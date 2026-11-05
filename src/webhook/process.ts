import {
  findAccountByPhoneNumberId,
  logWebhookEvent,
  markWebhookEvent,
  saveMessage,
  updateAccountStatusByWaba,
  updateMessageStatus,
  upsertContact,
  WhatsAppAccount,
} from '../db/repository';
import { errorInfo, log } from '../logger';
import { extractBody, fromUnix, normalizeWaId } from '../whatsapp/messages';
import {
  AccountUpdateValue,
  EchoesValue,
  HistoryValue,
  MessagesValue,
  StateSyncValue,
  WebhookChange,
  WebhookPayload,
} from '../whatsapp/types';
import { onIncomingMessage } from './hooks';

export async function processWebhook(payload: WebhookPayload): Promise<void> {
  if (payload.object !== 'whatsapp_business_account') {
    log.warn('Objeto de webhook no esperado', { object: payload.object });
    return;
  }
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      await processChange(entry.id, change);
    }
  }
}

async function processChange(wabaId: string, change: WebhookChange): Promise<void> {
  const phoneNumberId = (change.value as { metadata?: { phone_number_id?: string } })?.metadata?.phone_number_id ?? null;
  const account = phoneNumberId ? await findAccountByPhoneNumberId(phoneNumberId) : null;

  const eventId = await logWebhookEvent({
    field: change.field,
    wabaId,
    phoneNumberId,
    clientId: account?.clientId ?? null,
    payload: change.value,
  });

  try {
    if (change.field === 'account_update') {
      await handleAccountUpdate(wabaId, change.value as AccountUpdateValue);
      await markWebhookEvent(eventId, 'processed');
      return;
    }

    if (!account) {
      log.warn('Webhook de un número no registrado', { field: change.field, wabaId, phoneNumberId, eventId });
      await markWebhookEvent(eventId, 'unrouted');
      return;
    }

    switch (change.field) {
      case 'messages':
        await handleMessages(account, change.value as MessagesValue);
        break;
      case 'smb_message_echoes':
        await handleEchoes(account, change.value as EchoesValue);
        break;
      case 'history':
        await handleHistory(account, change.value as HistoryValue);
        break;
      case 'smb_app_state_sync':
        await handleStateSync(account, change.value as StateSyncValue);
        break;
      default:
        await markWebhookEvent(eventId, 'ignored');
        return;
    }
    await markWebhookEvent(eventId, 'processed');
  } catch (err) {
    log.error('Error procesando cambio de webhook', { eventId, field: change.field, ...errorInfo(err) });
    await markWebhookEvent(eventId, 'failed', err instanceof Error ? err.message : String(err)).catch(() => {});
  }
}

/** messages: mensajes entrantes de usuarios + estados de los mensajes que enviamos. */
async function handleMessages(account: WhatsAppAccount, value: MessagesValue): Promise<void> {
  for (const contact of value.contacts ?? []) {
    await upsertContact(account, normalizeWaId(contact.wa_id), { profileName: contact.profile?.name ?? null });
  }

  for (const message of value.messages ?? []) {
    const waId = normalizeWaId(message.from);
    const inserted = await saveMessage(account, {
      waId,
      wamid: message.id,
      direction: 'in',
      source: 'cloud_api',
      type: message.type,
      body: extractBody(message),
      payload: message,
      status: null,
      sentAt: fromUnix(message.timestamp),
    });
    if (inserted) await onIncomingMessage(account, waId, message); // los reintentos de Meta no se procesan dos veces
  }

  for (const status of value.statuses ?? []) {
    const error = status.errors?.[0];
    await updateMessageStatus(
      status.id,
      status.status,
      fromUnix(status.timestamp),
      error?.code ?? null,
      error ? (error.error_data?.details ?? error.message ?? error.title ?? null) : null,
    );
  }

  if (value.errors?.length) log.warn('Errores en webhook messages', { phoneNumberId: account.phoneNumberId, errors: value.errors });
}

/** smb_message_echoes: lo que el cliente envía desde la app WhatsApp Business (coexistencia). */
async function handleEchoes(account: WhatsAppAccount, value: EchoesValue): Promise<void> {
  for (const message of value.message_echoes ?? []) {
    if (!message.to) continue;
    await saveMessage(account, {
      waId: normalizeWaId(message.to),
      wamid: message.id,
      direction: 'out',
      source: 'business_app',
      type: message.type,
      body: extractBody(message),
      payload: message,
      status: 'sent',
      sentAt: fromUnix(message.timestamp),
    });
  }
}

/** history: historial de chats de la app Business al activar la coexistencia (llega en bloques). */
async function handleHistory(account: WhatsAppAccount, value: HistoryValue): Promise<void> {
  for (const chunk of value.history ?? []) {
    if (chunk.errors?.length) {
      // p. ej. el cliente decidió no compartir el historial
      log.warn('Historial no disponible', { phoneNumberId: account.phoneNumberId, errors: chunk.errors });
      continue;
    }
    log.info('Bloque de historial', { phoneNumberId: account.phoneNumberId, ...chunk.metadata });

    for (const thread of chunk.threads ?? []) {
      const waId = normalizeWaId(thread.id);
      for (const message of thread.messages ?? []) {
        await saveMessage(account, {
          waId,
          wamid: message.id,
          direction: normalizeWaId(message.from) === waId ? 'in' : 'out',
          source: 'history',
          type: message.type,
          body: extractBody(message),
          payload: message,
          status: message.history_context?.status?.toLowerCase() ?? null,
          sentAt: fromUnix(message.timestamp),
        });
      }
    }
  }
}

/** smb_app_state_sync: altas/bajas de contactos en la agenda de la app Business. */
async function handleStateSync(account: WhatsAppAccount, value: StateSyncValue): Promise<void> {
  for (const item of value.state_sync ?? []) {
    if (item.type !== 'contact' || !item.contact?.phone_number) continue;
    const waId = normalizeWaId(item.contact.phone_number);
    if (item.action === 'remove') {
      await upsertContact(account, waId, { contactName: null, inAddressBook: false });
    } else {
      await upsertContact(account, waId, {
        contactName: item.contact.full_name ?? item.contact.first_name ?? null,
        inAddressBook: true,
      });
    }
  }
}

/** account_update: no trae phone_number_id; se identifica por WABA. */
async function handleAccountUpdate(entryWabaId: string, value: AccountUpdateValue): Promise<void> {
  const wabaId = value.waba_info?.waba_id ?? entryWabaId;
  const statusByEvent: Record<string, string> = {
    PARTNER_ADDED: 'active',
    ACCOUNT_RECONNECTED: 'active',
    PARTNER_REMOVED: 'disconnected',
    ACCOUNT_OFFBOARDED: 'disconnected',
    ACCOUNT_DELETED: 'disconnected',
  };
  const newStatus = statusByEvent[value.event];
  const updated = newStatus ? await updateAccountStatusByWaba(wabaId, newStatus) : 0;
  log.info('account_update', { event: value.event, wabaId, newStatus, accountsUpdated: updated });
}

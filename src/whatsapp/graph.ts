import { config } from '../config';
import { findAccountByPhoneNumberId, saveMessage, TokenInfo, WhatsAppAccount } from '../db/repository';
import { extractBody, normalizeWaId } from './messages';

/** Mensaje saliente tal como lo espera POST /{phone_number_id}/messages (sin messaging_product). */
export interface OutgoingMessage {
  to: string;
  type: string;
  [key: string]: unknown;
}

export class WhatsAppApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly details: unknown,
  ) {
    super(`WhatsApp API respondió ${httpStatus}: ${JSON.stringify(details)}`);
  }
}

function tokenFor(account: WhatsAppAccount): string {
  return account.accessToken ?? config.accessToken;
}

function graphUrl(path: string, query?: Record<string, string>): string {
  const url = new URL(`https://graph.facebook.com/${config.graphApiVersion}/${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

async function graphFetch<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) throw new WhatsAppApiError(res.status, data.error ?? data);
  return data as T;
}

function graphPost<T>(path: string, token: string, body: unknown): Promise<T> {
  return graphFetch<T>(graphUrl(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function graphGet<T>(path: string, token: string, query?: Record<string, string>): Promise<T> {
  return graphFetch<T>(graphUrl(path, query), { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * Envía un mensaje desde el número del cliente y lo guarda en su conversación.
 * Fuera de la ventana de 24 h desde el último mensaje del usuario, solo se permiten plantillas.
 */
export async function sendMessage(phoneNumberId: string, message: OutgoingMessage): Promise<{ wamid: string }> {
  const account = await findAccountByPhoneNumberId(phoneNumberId);
  if (!account) throw new Error(`phone_number_id ${phoneNumberId} no está dado de alta en WhatsAppAccounts`);
  if (account.status !== 'active') throw new Error(`La cuenta ${phoneNumberId} está en estado ${account.status}`);

  const data = await graphPost<{ contacts?: { wa_id: string }[]; messages?: { id: string }[] }>(
    `${phoneNumberId}/messages`,
    tokenFor(account),
    { messaging_product: 'whatsapp', recipient_type: 'individual', ...message },
  );

  const wamid = data.messages?.[0]?.id;
  if (!wamid) throw new WhatsAppApiError(200, data);

  await saveMessage(account, {
    waId: normalizeWaId(data.contacts?.[0]?.wa_id ?? message.to),
    wamid,
    direction: 'out',
    source: 'cloud_api',
    type: message.type,
    body: extractBody(message),
    payload: message,
    status: 'accepted',
    sentAt: new Date(),
  });

  return { wamid };
}

export function sendText(phoneNumberId: string, to: string, body: string, previewUrl = false) {
  return sendMessage(phoneNumberId, { to, type: 'text', text: { body, preview_url: previewUrl } });
}

export function sendTemplate(
  phoneNumberId: string,
  to: string,
  name: string,
  languageCode: string,
  components?: unknown[],
) {
  return sendMessage(phoneNumberId, {
    to,
    type: 'template',
    template: { name, language: { code: languageCode }, ...(components ? { components } : {}) },
  });
}

/** Onboarding de un cliente (tras Embedded Signup): suscribe nuestra app a los webhooks de su WABA. */
export function subscribeAppToWaba(wabaId: string, token: string = config.accessToken) {
  return graphPost<{ success: boolean }>(`${wabaId}/subscribed_apps`, token, {});
}

/** Cambia el code de Embedded Signup (caduca en ~30 s) por el token de negocio del cliente. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const data = await graphFetch<{ access_token?: string }>(
    graphUrl('oauth/access_token', { client_id: config.appId, client_secret: config.appSecret, code }),
    { method: 'GET' },
  );
  if (!data.access_token) throw new WhatsAppApiError(200, data);
  return data.access_token;
}

/** Validez y caducidad reales de un token (se consulta con el token de app APP_ID|APP_SECRET). */
export async function debugToken(token: string): Promise<TokenInfo> {
  const data = await graphFetch<{ data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number } }>(
    graphUrl('debug_token', { input_token: token, access_token: `${config.appId}|${config.appSecret}` }),
    { method: 'GET' },
  );
  const d = data.data ?? {};
  const toDate = (seconds?: number) => (seconds ? new Date(seconds * 1000) : null); // 0 = no caduca
  return { isValid: d.is_valid === true, expiresAt: toDate(d.expires_at), dataAccessExpiresAt: toDate(d.data_access_expires_at) };
}

/** Intercambio fb_exchange_token. Solo funciona con un token aún válido y Meta no garantiza que alargue la caducidad. */
export async function exchangeForLongLivedToken(token: string): Promise<string> {
  const data = await graphFetch<{ access_token?: string }>(
    graphUrl('oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: token,
    }),
    { method: 'GET' },
  );
  if (!data.access_token) throw new WhatsAppApiError(200, data);
  return data.access_token;
}

export interface WabaPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

export async function getWabaPhoneNumbers(wabaId: string, token: string): Promise<WabaPhoneNumber[]> {
  const data = await graphGet<{ data?: WabaPhoneNumber[] }>(`${wabaId}/phone_numbers`, token, {
    fields: 'id,display_phone_number,verified_name',
  });
  return data.data ?? [];
}

/**
 * Coexistencia: pide a Meta que envíe por webhook los contactos (smb_app_state_sync) o el historial (history)
 * de la app WhatsApp Business. Solo se puede pedir una vez por tipo y en las 24 h siguientes al alta.
 */
export async function requestSmbAppDataSync(
  phoneNumberId: string,
  token: string,
  syncType: 'smb_app_state_sync' | 'history',
): Promise<{ request_id?: string }> {
  return graphPost(`${phoneNumberId}/smb_app_data`, token, { messaging_product: 'whatsapp', sync_type: syncType });
}

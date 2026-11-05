import { createHmac } from 'node:crypto';
import { config } from '../config';
import {
  clientExists,
  findAccountOwner,
  findClientIdByWaba,
  listPendingSyncAccounts,
  markSyncAlerted,
  markSyncRequested,
  saveOnboardedAccount,
  setSyncError,
  SyncType,
} from '../db/repository';
import { errorInfo, log } from '../logger';
import { safeEqual } from '../signature';
import { exchangeCodeForToken, getWabaPhoneNumbers, requestSmbAppDataSync, subscribeAppToWaba } from '../whatsapp/graph';
import { storeNewToken } from './tokens';

const SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;
const SYNC_ORDER: SyncType[] = ['smb_app_state_sync', 'history']; // Meta: primero contactos, después historial

// ---------- Enlaces de alta firmados ----------
// La página /onboarding es pública: el enlace firmado evita que alguien conecte su número a otro ClientId.

// purpose "onboard" = alta completa; "renew" = solo renovar el token de un cliente ya conectado.

export type LinkPurpose = 'onboard' | 'renew';

function linkSignature(purpose: LinkPurpose, clientId: string, exp: number): string {
  return createHmac('sha256', config.appSecret).update(`onboarding:${purpose}:${clientId}:${exp}`).digest('base64url');
}

export function createOnboardingLink(baseUrl: string, clientId: string, validDays = 7, purpose: LinkPurpose = 'onboard'): string {
  const exp = Math.floor(Date.now() / 1000) + validDays * 86400;
  const url = new URL('/onboarding', baseUrl);
  url.searchParams.set('client', clientId);
  url.searchParams.set('purpose', purpose);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', linkSignature(purpose, clientId, exp));
  return url.toString();
}

/** Devuelve el propósito del enlace si la firma es válida y no ha caducado; si no, null. */
export function verifyOnboardingLink(clientId: unknown, purpose: unknown, exp: unknown, sig: unknown): LinkPurpose | null {
  if (typeof clientId !== 'string' || typeof sig !== 'string') return null;
  if (purpose !== 'onboard' && purpose !== 'renew') return null;
  const expNumber = Number(exp);
  if (!Number.isInteger(expNumber) || expNumber * 1000 < Date.now()) return null;
  return safeEqual(sig, linkSignature(purpose, clientId, expNumber)) ? purpose : null;
}

// ---------- Alta ----------

export class OnboardingError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OnboardingInput {
  clientId: string;
  code: string;
  wabaId: string;
  phoneNumberId?: string;
  /** Evento WA_EMBEDDED_SIGNUP recibido en la página (FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING = coexistencia) */
  event?: string;
}

export type SyncResult = Record<SyncType, 'requested' | 'already_requested' | 'failed' | 'skipped'>;

export async function runOnboarding(input: OnboardingInput) {
  if (!(await clientExists(input.clientId))) throw new OnboardingError(400, `El cliente ${input.clientId} no existe en dbo.Clients`);

  // 1. code -> token del cliente (hay que hacerlo enseguida: el code caduca)
  const token = await exchangeCodeForToken(input.code);

  // 2. phone_number_id: el evento de coexistencia solo trae waba_id, así que se busca en la WABA
  const numbers = await getWabaPhoneNumbers(input.wabaId, token);
  if (input.phoneNumberId && !numbers.some((n) => n.id === input.phoneNumberId)) {
    throw new OnboardingError(400, `El número ${input.phoneNumberId} no pertenece a la WABA ${input.wabaId}`);
  }
  const phoneNumberId = input.phoneNumberId ?? (numbers.length === 1 ? numbers[0].id : undefined);
  if (!phoneNumberId) {
    throw new OnboardingError(422, `No se pudo determinar el phone_number_id: la WABA ${input.wabaId} tiene ${numbers.length} números`);
  }
  const number = numbers.find((n) => n.id === phoneNumberId);

  const owner = await findAccountOwner(phoneNumberId);
  if (owner && owner !== input.clientId) {
    throw new OnboardingError(409, `El número ${phoneNumberId} ya pertenece al cliente ${owner}`);
  }

  const onboardingType = input.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' ? 'coexistence' : 'cloud_api';

  // 3. guardar cuenta (fecha de alta = ahora; empieza la ventana de 24 h)
  await saveOnboardedAccount({
    phoneNumberId,
    clientId: input.clientId,
    wabaId: input.wabaId,
    displayPhoneNumber: number?.display_phone_number ?? null,
    accessToken: token,
    onboardingType,
  });

  // 4. caducidad real del token (debug_token) y webhooks de su WABA hacia nuestra app
  const tokenInfo = await storeNewToken(input.wabaId, token);
  await subscribeAppToWaba(input.wabaId, token);

  // 5. sincronización inicial (solo coexistencia)
  const sync: SyncResult =
    onboardingType === 'coexistence'
      ? await requestPendingSyncs(phoneNumberId, token, { contacts: null, history: null })
      : { smb_app_state_sync: 'skipped', history: 'skipped' };

  log.info('Alta completada', {
    clientId: input.clientId,
    wabaId: input.wabaId,
    phoneNumberId,
    onboardingType,
    sync,
    tokenExpiresAt: tokenInfo.expiresAt,
  });
  if (onboardingType === 'cloud_api') {
    log.warn('Alta sin coexistencia: el número debe registrarse con POST /{phone_number_id}/register antes de usarse', { phoneNumberId });
  }

  return {
    phoneNumberId,
    wabaId: input.wabaId,
    displayPhoneNumber: number?.display_phone_number ?? null,
    onboardingType,
    sync,
    tokenExpiresAt: tokenInfo.expiresAt,
  };
}

/** Renovación: el cliente repite el login con un enlace "renew"; solo se sustituye el token (no se toca la sincronización). */
export async function runTokenRenewal(input: { clientId: string; code: string; wabaId: string }) {
  const owner = await findClientIdByWaba(input.wabaId);
  if (owner !== input.clientId) {
    throw new OnboardingError(400, `La WABA ${input.wabaId} no está dada de alta para el cliente ${input.clientId}`);
  }
  const token = await exchangeCodeForToken(input.code);
  const tokenInfo = await storeNewToken(input.wabaId, token);
  if (!tokenInfo.isValid) throw new OnboardingError(502, 'Meta ha devuelto un token no válido');
  log.info('Token del cliente renovado', { clientId: input.clientId, wabaId: input.wabaId, tokenExpiresAt: tokenInfo.expiresAt });
  return { wabaId: input.wabaId, renewed: true, tokenExpiresAt: tokenInfo.expiresAt };
}

/** Pide los tipos de sincronización aún no pedidos, en orden. Si uno falla, no se pide el siguiente. */
async function requestPendingSyncs(
  phoneNumberId: string,
  token: string,
  alreadyRequested: { contacts: Date | null; history: Date | null },
): Promise<SyncResult> {
  const result: SyncResult = { smb_app_state_sync: 'skipped', history: 'skipped' };
  for (const syncType of SYNC_ORDER) {
    const done = syncType === 'history' ? alreadyRequested.history : alreadyRequested.contacts;
    if (done) {
      result[syncType] = 'already_requested';
      continue;
    }
    try {
      const response = await requestSmbAppDataSync(phoneNumberId, token, syncType);
      await markSyncRequested(phoneNumberId, syncType, response.request_id ?? null);
      result[syncType] = 'requested';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Fallo pidiendo smb_app_data', { phoneNumberId, syncType, ...errorInfo(err) });
      await setSyncError(phoneNumberId, `${syncType}: ${message}`);
      result[syncType] = 'failed';
      break;
    }
  }
  return result;
}

// ---------- Vigilancia de la ventana de 24 h ----------

/** Reintenta las sincronizaciones pendientes dentro de las 24 h y avisa (una vez) si se pasan. */
export async function checkPendingSyncs(): Promise<void> {
  for (const account of await listPendingSyncAccounts()) {
    const ageMs = Date.now() - new Date(account.onboardedAt).getTime();
    if (ageMs >= SYNC_WINDOW_MS) {
      log.error('ALERTA: sincronización de coexistencia no completada en 24 h; el cliente debe repetir el alta', {
        clientId: account.clientId,
        phoneNumberId: account.phoneNumberId,
        onboardedAt: account.onboardedAt,
        contactsSyncRequestedAt: account.contactsSyncRequestedAt,
        historySyncRequestedAt: account.historySyncRequestedAt,
        syncError: account.syncError,
      });
      await markSyncAlerted(account.phoneNumberId);
      continue;
    }
    log.warn('Reintentando sincronización de coexistencia', {
      clientId: account.clientId,
      phoneNumberId: account.phoneNumberId,
      hoursLeft: Math.round(((SYNC_WINDOW_MS - ageMs) / 3_600_000) * 10) / 10,
    });
    await requestPendingSyncs(account.phoneNumberId, account.accessToken, {
      contacts: account.contactsSyncRequestedAt,
      history: account.historySyncRequestedAt,
    });
  }
}

export function startSyncWatchdog(intervalMs = 10 * 60 * 1000): NodeJS.Timeout {
  const run = () => checkPendingSyncs().catch((err) => log.error('Fallo en la vigilancia de sincronización', errorInfo(err)));
  const timer = setInterval(run, intervalMs);
  timer.unref();
  setTimeout(run, 30_000).unref();
  return timer;
}

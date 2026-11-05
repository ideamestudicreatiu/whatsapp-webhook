import { listTokenAccounts, saveTokenInfo, setTokenAlertLevel, TokenAccount, TokenInfo } from '../db/repository';
import { errorInfo, log } from '../logger';
import { debugToken, exchangeForLongLivedToken } from '../whatsapp/graph';

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 14 * DAY_MS; // empezar a renovar/avisar 14 días antes
const URGENT_BEFORE_MS = 3 * DAY_MS;

/** Lo que vence antes: el token o el acceso a datos. */
function deadlineOf(info: TokenInfo): Date | null {
  const dates = [info.expiresAt, info.dataAccessExpiresAt].filter((d): d is Date => d !== null);
  return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
}

function alertLevel(info: TokenInfo): number {
  if (!info.isValid) return 3;
  const deadline = deadlineOf(info);
  if (!deadline) return 0;
  const left = deadline.getTime() - Date.now();
  if (left <= 0) return 3;
  if (left <= URGENT_BEFORE_MS) return 2;
  if (left <= RENEW_BEFORE_MS) return 1;
  return 0;
}

/** Consulta y guarda la caducidad de un token recién obtenido (alta o renovación). */
export async function storeNewToken(wabaId: string, token: string): Promise<TokenInfo> {
  const info = await debugToken(token);
  await saveTokenInfo(wabaId, info, token);
  return info;
}

async function checkToken(account: TokenAccount): Promise<void> {
  const info = await debugToken(account.accessToken);
  const deadline = deadlineOf(info);

  // Intento de renovación automática dentro de los últimos 14 días
  if (info.isValid && deadline && deadline.getTime() - Date.now() <= RENEW_BEFORE_MS) {
    try {
      const candidate = await exchangeForLongLivedToken(account.accessToken);
      const candidateInfo = await debugToken(candidate);
      const candidateDeadline = deadlineOf(candidateInfo);
      if (candidateInfo.isValid && (!candidateDeadline || candidateDeadline.getTime() > deadline.getTime() + DAY_MS)) {
        await saveTokenInfo(account.wabaId, candidateInfo, candidate);
        log.info('Token del cliente renovado automáticamente', {
          clientId: account.clientId,
          wabaId: account.wabaId,
          expiresAt: candidateDeadline,
        });
        return;
      }
    } catch (err) {
      log.warn('Renovación automática del token no disponible', { clientId: account.clientId, wabaId: account.wabaId, ...errorInfo(err) });
    }
  }

  await saveTokenInfo(account.wabaId, info);

  const level = alertLevel(info);
  if (level > account.tokenAlertLevel) {
    const text =
      level === 3
        ? 'ALERTA: token del cliente caducado o revocado; no se pueden enviar mensajes'
        : `ALERTA: el token del cliente caduca en ${Math.ceil((deadline!.getTime() - Date.now()) / DAY_MS)} días`;
    (level >= 2 ? log.error : log.warn)(text, {
      clientId: account.clientId,
      wabaId: account.wabaId,
      expiresAt: info.expiresAt,
      dataAccessExpiresAt: info.dataAccessExpiresAt,
      action: 'Enviar al cliente un enlace de renovación: npm run onboarding-link -- <clientId> <urlBase> --renew',
    });
    await setTokenAlertLevel(account.wabaId, level);
  }
}

export async function checkTokens(): Promise<void> {
  for (const account of await listTokenAccounts()) {
    await checkToken(account).catch((err) =>
      log.error('Fallo comprobando token', { clientId: account.clientId, wabaId: account.wabaId, ...errorInfo(err) }),
    );
  }
}

export function startTokenWatchdog(intervalMs = 6 * 60 * 60 * 1000): NodeJS.Timeout {
  const run = () => checkTokens().catch((err) => log.error('Fallo en la vigilancia de tokens', errorInfo(err)));
  const timer = setInterval(run, intervalMs);
  timer.unref();
  setTimeout(run, 60_000).unref();
  return timer;
}

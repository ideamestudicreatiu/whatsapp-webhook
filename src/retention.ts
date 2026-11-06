import { deleteAccountData, listExpiredDisconnectedAccounts, listWabaIds, purgeOldWebhookEvents } from './db/repository';
import { deleteOrphanTokens } from './db/tokenStore';
import { errorInfo, log } from './logger';

/** Plazo de la política de privacidad: como máximo 30 días tras la baja o desconexión. */
export const RETENTION_DAYS = 30;

export async function applyRetention(): Promise<void> {
  for (const account of await listExpiredDisconnectedAccounts(RETENTION_DAYS)) {
    await deleteAccountData(account.phoneNumberId);
    log.info('Datos borrados por fin del plazo de conservación', { ...account, retentionDays: RETENTION_DAYS });
  }

  const events = await purgeOldWebhookEvents(RETENTION_DAYS);
  if (events) log.info('Eventos de webhook antiguos borrados', { count: events, retentionDays: RETENTION_DAYS });

  // Tokens en Key Vault de WABA que ya no están en la base (plazo cumplido o sql/delete-data.sql)
  const secrets = await deleteOrphanTokens(await listWabaIds());
  if (secrets) log.info('Tokens de clientes borrados de Key Vault', { count: secrets });
}

export function startRetentionJob(intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  const run = () => applyRetention().catch((err) => log.error('Fallo aplicando el plazo de conservación', errorInfo(err)));
  const timer = setInterval(run, intervalMs);
  timer.unref();
  setTimeout(run, 5 * 60_000).unref();
  return timer;
}

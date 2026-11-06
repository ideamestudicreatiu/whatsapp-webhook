import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { config } from '../config';
import { errorInfo, log } from '../logger';

// Tokens de los clientes en Key Vault (un secreto por WABA). En dbo.WhatsAppAccounts.AccessToken
// solo se guarda la referencia "kv:<nombre>". Sin KEY_VAULT_URL (desarrollo local) se guarda el token tal cual.

const REF_PREFIX = 'kv:';
const CONTENT_TYPE = 'whatsapp-client-token';
const CACHE_MS = 5 * 60_000;

let client: SecretClient | undefined;
const cache = new Map<string, { value: string; expires: number }>();

function keyVault(): SecretClient | undefined {
  if (!config.keyVaultUrl) return undefined;
  client ??= new SecretClient(config.keyVaultUrl, new DefaultAzureCredential());
  return client;
}

function secretName(wabaId: string): string {
  return `waba-${wabaId.replace(/[^0-9A-Za-z]/g, '')}-token`;
}

/** Guarda el token y devuelve lo que hay que escribir en la columna AccessToken. */
export async function storeToken(wabaId: string, token: string): Promise<string> {
  const kv = keyVault();
  if (!kv) return token;
  const name = secretName(wabaId);
  await kv.setSecret(name, token, { contentType: CONTENT_TYPE, tags: { wabaId } });
  cache.set(name, { value: token, expires: Date.now() + CACHE_MS });
  return REF_PREFIX + name;
}

/** Convierte el valor de la columna AccessToken en el token real. */
export async function resolveToken(stored: string | null): Promise<string | null> {
  if (!stored || !stored.startsWith(REF_PREFIX)) return stored;
  const name = stored.slice(REF_PREFIX.length);
  const cached = cache.get(name);
  if (cached && cached.expires > Date.now()) return cached.value;

  const kv = keyVault();
  if (!kv) throw new Error(`El token ${name} está en Key Vault pero falta KEY_VAULT_URL`);
  const secret = await kv.getSecret(name);
  if (!secret.value) throw new Error(`El secreto ${name} está vacío`);
  cache.set(name, { value: secret.value, expires: Date.now() + CACHE_MS });
  return secret.value;
}

/**
 * Borra (y purga si se puede) los secretos de tokens cuyas WABA ya no están en la base:
 * cuentas eliminadas por el plazo de conservación o por sql/delete-data.sql.
 */
export async function deleteOrphanTokens(activeWabaIds: Set<string>): Promise<number> {
  const kv = keyVault();
  if (!kv) return 0;
  const oneHourAgo = Date.now() - 60 * 60_000;
  let deleted = 0;

  for await (const props of kv.listPropertiesOfSecrets()) {
    if (props.contentType !== CONTENT_TYPE) continue;
    const wabaId = props.tags?.wabaId;
    // margen de 1 h: un alta en curso guarda el secreto un instante antes de crear la cuenta
    if (!wabaId || activeWabaIds.has(wabaId) || (props.updatedOn?.getTime() ?? 0) > oneHourAgo) continue;

    const poller = await kv.beginDeleteSecret(props.name);
    await poller.pollUntilDone();
    cache.delete(props.name);
    try {
      await kv.purgeDeletedSecret(props.name);
    } catch (err) {
      log.warn('Secreto borrado pero no purgado (queda en borrado temporal hasta que caduque)', { name: props.name, ...errorInfo(err) });
    }
    deleted++;
  }
  return deleted;
}

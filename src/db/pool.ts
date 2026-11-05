import sql from 'mssql';
import { config } from '../config';

let poolPromise: Promise<sql.ConnectionPool> | undefined;

function createPool(): sql.ConnectionPool {
  if (config.sqlConnectionString) return new sql.ConnectionPool(config.sqlConnectionString);

  // Identidad administrada de App Service: sin contraseña en ningún sitio
  return new sql.ConnectionPool({
    server: config.sqlServer!,
    database: config.sqlDatabase!,
    options: { encrypt: true },
    authentication: {
      type: 'azure-active-directory-msi-app-service',
      options: config.sqlManagedIdentityClientId ? { clientId: config.sqlManagedIdentityClientId } : {},
    },
  });
}

export function getPool(): Promise<sql.ConnectionPool> {
  poolPromise ??= createPool()
    .connect()
    .catch((err) => {
      poolPromise = undefined; // reintentar en la siguiente llamada
      throw err;
    });
  return poolPromise;
}

export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise.catch(() => undefined);
  poolPromise = undefined;
  await pool?.close();
}

export { sql };

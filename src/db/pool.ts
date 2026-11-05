import sql from 'mssql';
import { config } from '../config';

let poolPromise: Promise<sql.ConnectionPool> | undefined;

export function getPool(): Promise<sql.ConnectionPool> {
  poolPromise ??= new sql.ConnectionPool(config.sqlConnectionString).connect().catch((err) => {
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

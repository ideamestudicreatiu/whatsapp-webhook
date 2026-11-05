function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

// Base de datos: SQL_SERVER + SQL_DATABASE con identidad administrada (Azure, sin contraseña),
// o SQL_CONNECTION_STRING (desarrollo local con usuario y contraseña).
const sqlConnectionString = process.env.SQL_CONNECTION_STRING || undefined;
const sqlServer = sqlConnectionString ? undefined : required('SQL_SERVER');
const sqlDatabase = sqlConnectionString ? undefined : required('SQL_DATABASE');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  verifyToken: required('VERIFY_TOKEN'),
  appSecret: required('APP_SECRET'),
  appId: required('APP_ID'),
  esConfigId: required('ES_CONFIG_ID'),
  accessToken: required('ACCESS_TOKEN'),
  sqlConnectionString,
  sqlServer,
  sqlDatabase,
  sqlManagedIdentityClientId: process.env.SQL_MANAGED_IDENTITY_CLIENT_ID || undefined, // solo para identidad asignada por el usuario
  graphApiVersion: process.env.GRAPH_API_VERSION || 'v26.0',
  internalApiKey: process.env.INTERNAL_API_KEY || undefined,
};

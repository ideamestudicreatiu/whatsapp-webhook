function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  verifyToken: required('VERIFY_TOKEN'),
  appSecret: required('APP_SECRET'),
  appId: required('APP_ID'),
  esConfigId: required('ES_CONFIG_ID'),
  accessToken: required('ACCESS_TOKEN'),
  sqlConnectionString: required('SQL_CONNECTION_STRING'),
  graphApiVersion: process.env.GRAPH_API_VERSION || 'v26.0',
  internalApiKey: process.env.INTERNAL_API_KEY || undefined,
};

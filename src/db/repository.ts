import { getPool, sql } from './pool';

export interface WhatsAppAccount {
  phoneNumberId: string;
  clientId: string;
  wabaId: string;
  accessToken: string | null;
  status: string;
}

export type Direction = 'in' | 'out';
export type Source = 'cloud_api' | 'business_app' | 'history';

export interface NewMessage {
  waId: string;
  wamid: string;
  direction: Direction;
  source: Source;
  type: string;
  body: string | null;
  payload: unknown;
  status: string | null;
  sentAt: Date;
}

// ---------- Cuentas (enrutado multi-cliente) ----------

const accountCache = new Map<string, { account: WhatsAppAccount | null; expires: number }>();

export async function findAccountByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppAccount | null> {
  const cached = accountCache.get(phoneNumberId);
  if (cached && cached.expires > Date.now()) return cached.account;

  const pool = await getPool();
  const result = await pool
    .request()
    .input('PhoneNumberId', sql.NVarChar(32), phoneNumberId)
    .query<WhatsAppAccount>(`
      SELECT PhoneNumberId AS phoneNumberId, ClientId AS clientId, WabaId AS wabaId,
             AccessToken AS accessToken, Status AS status
      FROM dbo.WhatsAppAccounts WHERE PhoneNumberId = @PhoneNumberId`);

  const account = result.recordset[0] ?? null;
  // Los "no encontrado" se cachean poco para que un cliente recién dado de alta empiece a funcionar enseguida
  accountCache.set(phoneNumberId, { account, expires: Date.now() + (account ? 60_000 : 10_000) });
  return account;
}

export async function updateAccountStatusByWaba(wabaId: string, status: string): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('WabaId', sql.NVarChar(32), wabaId)
    .input('Status', sql.NVarChar(20), status)
    .query(`UPDATE dbo.WhatsAppAccounts SET Status = @Status, UpdatedAt = SYSUTCDATETIME() WHERE WabaId = @WabaId`);
  accountCache.clear();
  return result.rowsAffected[0] ?? 0;
}

// ---------- Alta (Embedded Signup) ----------

export type SyncType = 'smb_app_state_sync' | 'history';

export interface PendingSyncAccount extends WhatsAppAccount {
  accessToken: string;
  onboardedAt: Date;
  contactsSyncRequestedAt: Date | null;
  historySyncRequestedAt: Date | null;
}

export async function clientExists(clientId: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('ClientId', sql.NVarChar(50), clientId)
    .query(`SELECT 1 AS x FROM dbo.Clients WHERE ClientId = @ClientId`);
  return result.recordset.length > 0;
}

/** ClientId al que pertenece ya un número, o null si es nuevo. */
export async function findAccountOwner(phoneNumberId: string): Promise<string | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('PhoneNumberId', sql.NVarChar(32), phoneNumberId)
    .query<{ ClientId: string }>(`SELECT ClientId FROM dbo.WhatsAppAccounts WHERE PhoneNumberId = @PhoneNumberId`);
  return result.recordset[0]?.ClientId ?? null;
}

/** Crea o reinicia la cuenta tras un alta: nuevo token, fecha de alta y sincronización pendiente. */
export async function saveOnboardedAccount(a: {
  phoneNumberId: string;
  clientId: string;
  wabaId: string;
  displayPhoneNumber: string | null;
  accessToken: string;
  onboardingType: 'coexistence' | 'cloud_api';
}): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('PhoneNumberId', sql.NVarChar(32), a.phoneNumberId)
    .input('ClientId', sql.NVarChar(50), a.clientId)
    .input('WabaId', sql.NVarChar(32), a.wabaId)
    .input('DisplayPhoneNumber', sql.NVarChar(32), a.displayPhoneNumber)
    .input('AccessToken', sql.NVarChar(sql.MAX), a.accessToken)
    .input('OnboardingType', sql.NVarChar(20), a.onboardingType)
    .query(`
      MERGE dbo.WhatsAppAccounts WITH (HOLDLOCK) AS t
      USING (SELECT @PhoneNumberId AS PhoneNumberId) AS s ON t.PhoneNumberId = s.PhoneNumberId
      WHEN MATCHED THEN UPDATE SET
        WabaId = @WabaId, DisplayPhoneNumber = COALESCE(@DisplayPhoneNumber, t.DisplayPhoneNumber),
        AccessToken = @AccessToken, Status = 'active', OnboardingType = @OnboardingType,
        OnboardedAt = SYSUTCDATETIME(),
        ContactsSyncRequestedAt = NULL, ContactsSyncRequestId = NULL,
        HistorySyncRequestedAt = NULL, HistorySyncRequestId = NULL,
        SyncError = NULL, SyncAlertedAt = NULL, UpdatedAt = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (PhoneNumberId, ClientId, WabaId, DisplayPhoneNumber, AccessToken, Status, OnboardingType, OnboardedAt)
        VALUES (@PhoneNumberId, @ClientId, @WabaId, @DisplayPhoneNumber, @AccessToken, 'active', @OnboardingType, SYSUTCDATETIME());`);
  accountCache.delete(a.phoneNumberId);
}

export async function markSyncRequested(phoneNumberId: string, syncType: SyncType, requestId: string | null): Promise<void> {
  const column = syncType === 'history' ? 'HistorySync' : 'ContactsSync';
  const pool = await getPool();
  await pool
    .request()
    .input('PhoneNumberId', sql.NVarChar(32), phoneNumberId)
    .input('RequestId', sql.NVarChar(100), requestId)
    .query(`
      UPDATE dbo.WhatsAppAccounts
      SET ${column}RequestedAt = SYSUTCDATETIME(), ${column}RequestId = @RequestId, SyncError = NULL, UpdatedAt = SYSUTCDATETIME()
      WHERE PhoneNumberId = @PhoneNumberId`);
}

export async function setSyncError(phoneNumberId: string, error: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('PhoneNumberId', sql.NVarChar(32), phoneNumberId)
    .input('SyncError', sql.NVarChar(1000), error.slice(0, 1000))
    .query(`UPDATE dbo.WhatsAppAccounts SET SyncError = @SyncError, UpdatedAt = SYSUTCDATETIME() WHERE PhoneNumberId = @PhoneNumberId`);
}

export async function markSyncAlerted(phoneNumberId: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('PhoneNumberId', sql.NVarChar(32), phoneNumberId)
    .query(`UPDATE dbo.WhatsAppAccounts SET SyncAlertedAt = SYSUTCDATETIME() WHERE PhoneNumberId = @PhoneNumberId`);
}

/** Altas de coexistencia con alguna sincronización sin pedir (de hace más de 5 min, para no pisar un alta en curso). */
export async function listPendingSyncAccounts(): Promise<(PendingSyncAccount & { syncError: string | null })[]> {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT PhoneNumberId AS phoneNumberId, ClientId AS clientId, WabaId AS wabaId, AccessToken AS accessToken,
           Status AS status, OnboardedAt AS onboardedAt, ContactsSyncRequestedAt AS contactsSyncRequestedAt,
           HistorySyncRequestedAt AS historySyncRequestedAt, SyncError AS syncError
    FROM dbo.WhatsAppAccounts
    WHERE OnboardingType = 'coexistence' AND OnboardedAt IS NOT NULL AND SyncAlertedAt IS NULL
      AND AccessToken IS NOT NULL AND Status = 'active'
      AND (ContactsSyncRequestedAt IS NULL OR HistorySyncRequestedAt IS NULL)
      AND OnboardedAt < DATEADD(MINUTE, -5, SYSUTCDATETIME())`);
  return result.recordset;
}

// ---------- Caducidad de tokens ----------

export interface TokenInfo {
  isValid: boolean;
  expiresAt: Date | null; // null = no caduca
  dataAccessExpiresAt: Date | null;
}

export interface TokenAccount {
  wabaId: string;
  clientId: string;
  accessToken: string;
  tokenAlertLevel: number;
}

export async function findClientIdByWaba(wabaId: string): Promise<string | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('WabaId', sql.NVarChar(32), wabaId)
    .query<{ ClientId: string }>(`SELECT TOP 1 ClientId FROM dbo.WhatsAppAccounts WHERE WabaId = @WabaId`);
  return result.recordset[0]?.ClientId ?? null;
}

/** Guarda la caducidad del token de una WABA. Con newToken, sustituye el token y reinicia las alertas. */
export async function saveTokenInfo(wabaId: string, info: TokenInfo, newToken?: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('WabaId', sql.NVarChar(32), wabaId)
    .input('NewToken', sql.NVarChar(sql.MAX), newToken ?? null)
    .input('IsValid', sql.Bit, info.isValid)
    .input('ExpiresAt', sql.DateTime2, info.expiresAt)
    .input('DataAccessExpiresAt', sql.DateTime2, info.dataAccessExpiresAt)
    .query(`
      UPDATE dbo.WhatsAppAccounts SET
        AccessToken = COALESCE(@NewToken, AccessToken),
        TokenValid = @IsValid, TokenExpiresAt = @ExpiresAt, DataAccessExpiresAt = @DataAccessExpiresAt,
        TokenCheckedAt = SYSUTCDATETIME(),
        TokenAlertLevel = CASE WHEN @NewToken IS NOT NULL THEN 0 ELSE TokenAlertLevel END,
        UpdatedAt = SYSUTCDATETIME()
      WHERE WabaId = @WabaId AND (AccessToken IS NOT NULL OR @NewToken IS NOT NULL)`);
  accountCache.clear();
}

export async function setTokenAlertLevel(wabaId: string, level: number): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('WabaId', sql.NVarChar(32), wabaId)
    .input('Level', sql.TinyInt, level)
    .query(`UPDATE dbo.WhatsAppAccounts SET TokenAlertLevel = @Level WHERE WabaId = @WabaId`);
}

/** Una fila por WABA activa con token propio (las que usan ACCESS_TOKEN no se vigilan aquí). */
export async function listTokenAccounts(): Promise<TokenAccount[]> {
  const pool = await getPool();
  const result = await pool.request().query<TokenAccount>(`
    SELECT WabaId AS wabaId, ClientId AS clientId, AccessToken AS accessToken, TokenAlertLevel AS tokenAlertLevel
    FROM dbo.WhatsAppAccounts
    WHERE AccessToken IS NOT NULL AND Status = 'active'`);
  const byWaba = new Map<string, TokenAccount>();
  for (const row of result.recordset) if (!byWaba.has(row.wabaId)) byWaba.set(row.wabaId, row);
  return [...byWaba.values()];
}

// ---------- Registro de eventos ----------

export async function logWebhookEvent(e: {
  field: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  clientId: string | null;
  payload: unknown;
}): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('Field', sql.NVarChar(50), e.field)
    .input('WabaId', sql.NVarChar(32), e.wabaId)
    .input('PhoneNumberId', sql.NVarChar(32), e.phoneNumberId)
    .input('ClientId', sql.NVarChar(50), e.clientId)
    .input('Payload', sql.NVarChar(sql.MAX), JSON.stringify(e.payload))
    .query<{ EventId: number }>(`
      INSERT INTO dbo.WebhookEvents (Field, WabaId, PhoneNumberId, ClientId, Payload)
      OUTPUT INSERTED.EventId
      VALUES (@Field, @WabaId, @PhoneNumberId, @ClientId, @Payload)`);
  return result.recordset[0].EventId;
}

export async function markWebhookEvent(eventId: number, status: string, error?: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('EventId', sql.BigInt, eventId)
    .input('Status', sql.NVarChar(20), status)
    .input('Error', sql.NVarChar(sql.MAX), error ?? null)
    .query(`UPDATE dbo.WebhookEvents SET Status = @Status, Error = @Error, ProcessedAt = SYSUTCDATETIME() WHERE EventId = @EventId`);
}

// ---------- Contactos ----------

/** Campos a undefined no se tocan. */
export async function upsertContact(
  account: WhatsAppAccount,
  waId: string,
  fields: { profileName?: string | null; contactName?: string | null; inAddressBook?: boolean },
): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('PhoneNumberId', sql.NVarChar(32), account.phoneNumberId)
    .input('ClientId', sql.NVarChar(50), account.clientId)
    .input('WaId', sql.NVarChar(32), waId)
    .input('SetProfileName', sql.Bit, fields.profileName !== undefined)
    .input('ProfileName', sql.NVarChar(200), fields.profileName ?? null)
    .input('SetContactName', sql.Bit, fields.contactName !== undefined)
    .input('ContactName', sql.NVarChar(200), fields.contactName ?? null)
    .input('InAddressBook', sql.Bit, fields.inAddressBook ?? null)
    .query(`
      MERGE dbo.Contacts WITH (HOLDLOCK) AS t
      USING (SELECT @PhoneNumberId AS PhoneNumberId, @WaId AS WaId) AS s
        ON t.PhoneNumberId = s.PhoneNumberId AND t.WaId = s.WaId
      WHEN MATCHED THEN UPDATE SET
        ProfileName   = CASE WHEN @SetProfileName = 1 THEN @ProfileName ELSE t.ProfileName END,
        ContactName   = CASE WHEN @SetContactName = 1 THEN @ContactName ELSE t.ContactName END,
        InAddressBook = COALESCE(@InAddressBook, t.InAddressBook),
        UpdatedAt     = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (PhoneNumberId, WaId, ClientId, ProfileName, ContactName, InAddressBook)
        VALUES (@PhoneNumberId, @WaId, @ClientId, @ProfileName, @ContactName, @InAddressBook);`);
}

// ---------- Conversaciones y mensajes ----------

/** Guarda el mensaje (creando la conversación si hace falta). Devuelve false si el wamid ya existía. */
export async function saveMessage(account: WhatsAppAccount, m: NewMessage): Promise<boolean> {
  const pool = await getPool();
  try {
    const result = await pool
      .request()
      .input('ClientId', sql.NVarChar(50), account.clientId)
      .input('PhoneNumberId', sql.NVarChar(32), account.phoneNumberId)
      .input('WaId', sql.NVarChar(32), m.waId)
      .input('Wamid', sql.NVarChar(200), m.wamid)
      .input('Direction', sql.NVarChar(3), m.direction)
      .input('Source', sql.NVarChar(20), m.source)
      .input('Type', sql.NVarChar(30), m.type)
      .input('Body', sql.NVarChar(sql.MAX), m.body)
      .input('Payload', sql.NVarChar(sql.MAX), JSON.stringify(m.payload))
      .input('Status', sql.NVarChar(20), m.status)
      .input('SentAt', sql.DateTime2, m.sentAt)
      .query<{ Inserted: number }>(`
        SET NOCOUNT ON;
        MERGE dbo.Conversations WITH (HOLDLOCK) AS t
        USING (SELECT @PhoneNumberId AS PhoneNumberId, @WaId AS WaId) AS s
          ON t.PhoneNumberId = s.PhoneNumberId AND t.WaId = s.WaId
        WHEN MATCHED AND (t.LastMessageAt IS NULL OR t.LastMessageAt < @SentAt) THEN
          UPDATE SET LastMessageAt = @SentAt
        WHEN NOT MATCHED THEN
          INSERT (ClientId, PhoneNumberId, WaId, LastMessageAt) VALUES (@ClientId, @PhoneNumberId, @WaId, @SentAt);

        DECLARE @ConversationId BIGINT =
          (SELECT ConversationId FROM dbo.Conversations WHERE PhoneNumberId = @PhoneNumberId AND WaId = @WaId);

        INSERT INTO dbo.Messages (ClientId, ConversationId, Wamid, Direction, Source, Type, Body, Payload, Status, SentAt)
        SELECT @ClientId, @ConversationId, @Wamid, @Direction, @Source, @Type, @Body, @Payload, @Status, @SentAt
        WHERE NOT EXISTS (SELECT 1 FROM dbo.Messages WHERE Wamid = @Wamid);

        SELECT @@ROWCOUNT AS Inserted;`);
    return (result.recordset[0]?.Inserted ?? 0) > 0;
  } catch (err) {
    // Carrera entre dos entregas simultáneas del mismo mensaje: violación de UNIQUE
    const number = (err as { number?: number }).number;
    if (number === 2627 || number === 2601) return false;
    throw err;
  }
}

/**
 * Actualiza el estado de un mensaje saliente. Solo avanza (sent → delivered → read),
 * porque los webhooks de estado pueden llegar desordenados; "failed" siempre se aplica.
 */
export async function updateMessageStatus(
  wamid: string,
  status: string,
  at: Date,
  errorCode: number | null,
  errorMessage: string | null,
): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('Wamid', sql.NVarChar(200), wamid)
    .input('Status', sql.NVarChar(20), status)
    .input('StatusAt', sql.DateTime2, at)
    .input('ErrorCode', sql.Int, errorCode)
    .input('ErrorMessage', sql.NVarChar(1000), errorMessage?.slice(0, 1000) ?? null)
    .query(`
      UPDATE dbo.Messages
      SET Status = @Status, StatusAt = @StatusAt,
          ErrorCode = COALESCE(@ErrorCode, ErrorCode), ErrorMessage = COALESCE(@ErrorMessage, ErrorMessage)
      WHERE Wamid = @Wamid
        AND (
          @Status = 'failed'
          OR CASE Status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END
           < CASE @Status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END
        )`);
  return (result.rowsAffected[0] ?? 0) > 0;
}

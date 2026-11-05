-- Esquema para Azure SQL. Todas las tablas llevan ClientId (patrón multi-cliente de la plataforma).

CREATE TABLE dbo.Clients (
  ClientId   NVARCHAR(50)  NOT NULL PRIMARY KEY,
  Name       NVARCHAR(200) NOT NULL,
  CreatedAt  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Un registro por número de WhatsApp conectado. El webhook enruta por PhoneNumberId.
CREATE TABLE dbo.WhatsAppAccounts (
  PhoneNumberId      NVARCHAR(32)  NOT NULL PRIMARY KEY,
  ClientId           NVARCHAR(50)  NOT NULL REFERENCES dbo.Clients (ClientId),
  WabaId             NVARCHAR(32)  NOT NULL,
  DisplayPhoneNumber NVARCHAR(32)  NULL,
  AccessToken        NVARCHAR(MAX) NULL,  -- token del cliente (Embedded Signup); NULL = usar ACCESS_TOKEN
  Status             NVARCHAR(20)  NOT NULL DEFAULT 'active', -- active | disconnected
  -- Embedded Signup. En coexistencia, smb_app_data debe pedirse (una sola vez por tipo) en las 24 h siguientes al alta.
  OnboardingType          NVARCHAR(20)   NULL, -- coexistence | cloud_api
  OnboardedAt             DATETIME2      NULL,
  ContactsSyncRequestedAt DATETIME2      NULL,
  ContactsSyncRequestId   NVARCHAR(100)  NULL,
  HistorySyncRequestedAt  DATETIME2      NULL,
  HistorySyncRequestId    NVARCHAR(100)  NULL,
  SyncError               NVARCHAR(1000) NULL,
  SyncAlertedAt           DATETIME2      NULL, -- se avisó de que pasaron 24 h sin completar la sincronización
  -- Caducidad del token del cliente (según debug_token). NULL = no caduca o aún no comprobado.
  TokenExpiresAt          DATETIME2      NULL,
  DataAccessExpiresAt     DATETIME2      NULL,
  TokenValid              BIT            NULL,
  TokenCheckedAt          DATETIME2      NULL,
  TokenAlertLevel         TINYINT        NOT NULL DEFAULT 0, -- 0 ok | 1 <14 días | 2 <3 días | 3 caducado/no válido
  CreatedAt        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
  UpdatedAt          DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_WhatsAppAccounts_WabaId ON dbo.WhatsAppAccounts (WabaId);

CREATE TABLE dbo.Contacts (
  PhoneNumberId  NVARCHAR(32)  NOT NULL,
  WaId           NVARCHAR(32)  NOT NULL,
  ClientId       NVARCHAR(50)  NOT NULL,
  ProfileName    NVARCHAR(200) NULL, -- nombre de perfil de WhatsApp del usuario
  ContactName    NVARCHAR(200) NULL, -- nombre en la agenda de la app Business (smb_app_state_sync)
  InAddressBook  BIT           NULL,
  CreatedAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
  UpdatedAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_Contacts PRIMARY KEY (PhoneNumberId, WaId)
);
CREATE INDEX IX_Contacts_ClientId ON dbo.Contacts (ClientId);

CREATE TABLE dbo.Conversations (
  ConversationId BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  ClientId       NVARCHAR(50) NOT NULL,
  PhoneNumberId  NVARCHAR(32) NOT NULL,
  WaId           NVARCHAR(32) NOT NULL,
  LastMessageAt  DATETIME2    NULL,
  CreatedAt      DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Conversations UNIQUE (PhoneNumberId, WaId)
);
CREATE INDEX IX_Conversations_Client_Last ON dbo.Conversations (ClientId, LastMessageAt DESC);

CREATE TABLE dbo.Messages (
  MessageId      BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  ClientId       NVARCHAR(50)   NOT NULL,
  ConversationId BIGINT         NOT NULL REFERENCES dbo.Conversations (ConversationId),
  Wamid          NVARCHAR(200)  NOT NULL,
  Direction      NVARCHAR(3)    NOT NULL CHECK (Direction IN ('in', 'out')),
  Source         NVARCHAR(20)   NOT NULL CHECK (Source IN ('cloud_api', 'business_app', 'history')),
  Type           NVARCHAR(30)   NOT NULL,
  Body           NVARCHAR(MAX)  NULL,
  Payload        NVARCHAR(MAX)  NULL, -- JSON original del mensaje
  Status         NVARCHAR(20)   NULL, -- accepted | sent | delivered | read | failed
  StatusAt       DATETIME2      NULL,
  ErrorCode      INT            NULL,
  ErrorMessage   NVARCHAR(1000) NULL,
  SentAt         DATETIME2      NOT NULL,
  CreatedAt      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Messages_Wamid UNIQUE (Wamid) -- Meta reintenta: evita duplicados
);
CREATE INDEX IX_Messages_Conversation ON dbo.Messages (ConversationId, SentAt);

-- Registro de cada cambio recibido, para auditoría y reprocesar los fallidos.
CREATE TABLE dbo.WebhookEvents (
  EventId       BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  ReceivedAt    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
  Field         NVARCHAR(50)  NOT NULL,
  WabaId        NVARCHAR(32)  NULL,
  PhoneNumberId NVARCHAR(32)  NULL,
  ClientId      NVARCHAR(50)  NULL,
  Payload       NVARCHAR(MAX) NOT NULL,
  Status        NVARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending | processed | failed | unrouted | ignored
  Error         NVARCHAR(MAX) NULL,
  ProcessedAt   DATETIME2     NULL
);
CREATE INDEX IX_WebhookEvents_Status ON dbo.WebhookEvents (Status, ReceivedAt);

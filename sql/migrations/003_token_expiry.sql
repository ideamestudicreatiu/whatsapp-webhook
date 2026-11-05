-- Solo si ya ejecutaste una versión anterior de schema.sql (sin las columnas de caducidad del token).
ALTER TABLE dbo.WhatsAppAccounts ADD
  TokenExpiresAt      DATETIME2 NULL,
  DataAccessExpiresAt DATETIME2 NULL,
  TokenValid          BIT       NULL,
  TokenCheckedAt      DATETIME2 NULL,
  TokenAlertLevel     TINYINT   NOT NULL CONSTRAINT DF_WhatsAppAccounts_TokenAlertLevel DEFAULT 0;

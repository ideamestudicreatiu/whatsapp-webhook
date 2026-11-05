-- Solo si ya ejecutaste una versión anterior de schema.sql (sin las columnas de Embedded Signup).
ALTER TABLE dbo.WhatsAppAccounts ADD
  OnboardingType          NVARCHAR(20)   NULL,
  OnboardedAt             DATETIME2      NULL,
  ContactsSyncRequestedAt DATETIME2      NULL,
  ContactsSyncRequestId   NVARCHAR(100)  NULL,
  HistorySyncRequestedAt  DATETIME2      NULL,
  HistorySyncRequestId    NVARCHAR(100)  NULL,
  SyncError               NVARCHAR(1000) NULL,
  SyncAlertedAt           DATETIME2      NULL;

-- Plazo de conservación: fecha de desconexión de cada cuenta (los datos se borran 30 días después).
ALTER TABLE dbo.WhatsAppAccounts ADD DisconnectedAt DATETIME2 NULL;

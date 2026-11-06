-- Borrado a petición (derecho de supresión). Ejecutar como administrador de Entra en la base "whatsapp".
-- Rellena UNA de las dos variables y ejecuta el script entero. Todo va en una transacción.

DECLARE @ClientId NVARCHAR(50) = NULL;  -- A) baja de un cliente: borra todos sus números y datos
DECLARE @WaId     NVARCHAR(32) = NULL;  -- B) un usuario final pide que se borren sus datos (solo dígitos, p. ej. '34600111222')

IF (@ClientId IS NULL AND @WaId IS NULL) OR (@ClientId IS NOT NULL AND @WaId IS NOT NULL)
  THROW 50000, 'Rellena exactamente una de las dos variables', 1;

BEGIN TRANSACTION;

IF @ClientId IS NOT NULL
BEGIN
  DELETE m FROM dbo.Messages m JOIN dbo.Conversations c ON c.ConversationId = m.ConversationId WHERE c.ClientId = @ClientId;
  DELETE FROM dbo.Conversations WHERE ClientId = @ClientId;
  DELETE FROM dbo.Contacts WHERE ClientId = @ClientId;
  DELETE FROM dbo.WebhookEvents
    WHERE ClientId = @ClientId OR WabaId IN (SELECT WabaId FROM dbo.WhatsAppAccounts WHERE ClientId = @ClientId);
  DELETE FROM dbo.WhatsAppAccounts WHERE ClientId = @ClientId;  -- incluye los tokens
  -- dbo.Clients se conserva: el cliente puede usar otras herramientas de la plataforma.
END
ELSE
BEGIN
  DELETE m FROM dbo.Messages m JOIN dbo.Conversations c ON c.ConversationId = m.ConversationId WHERE c.WaId = @WaId;
  DELETE FROM dbo.Conversations WHERE WaId = @WaId;
  DELETE FROM dbo.Contacts WHERE WaId = @WaId;
  -- los eventos en bruto con ese número se borran solos a los 30 días; si hay que hacerlo ya:
  DELETE FROM dbo.WebhookEvents WHERE Payload LIKE '%"' + @WaId + '"%';
END

COMMIT;

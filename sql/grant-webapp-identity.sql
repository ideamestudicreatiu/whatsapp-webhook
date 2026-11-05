-- Ejecutar en la base "whatsapp" conectado como administrador de Entra ID del servidor
-- (después de schema.sql). Da acceso de lectura/escritura a la identidad administrada de la web app.
-- El nombre es el de la web app (identidad asignada por el sistema).
CREATE USER [app-whatsapp-ideam] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [app-whatsapp-ideam];
ALTER ROLE db_datawriter ADD MEMBER [app-whatsapp-ideam];

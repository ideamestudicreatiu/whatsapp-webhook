# Webhook de WhatsApp Cloud API (multi-cliente)

Servicio Node.js + TypeScript para Ideam Estudi Creatiu como Tech Provider. Recibe los webhooks de todos los
clientes en una sola URL, identifica el cliente por `phone_number_id` y guarda contactos, conversaciones
y mensajes en Azure SQL.

## Endpoints

| Método | Ruta | Uso |
|---|---|---|
| GET | `/webhook/whatsapp` | Verificación de Meta (`hub.mode`, `hub.verify_token`, `hub.challenge`) |
| POST | `/webhook/whatsapp` | Eventos. Valida `X-Hub-Signature-256`, responde 200 y procesa en segundo plano |
| GET | `/onboarding` | Página de Embedded Signup (enlace firmado por cliente) |
| POST | `/api/onboarding` | Recibe `code` + `waba_id` de la página y completa el alta |
| POST | `/api/messages` | Solo si hay `INTERNAL_API_KEY`. Envía un mensaje (cabecera `x-api-key`) |
| GET | `/health` | Health check para App Service |

## Campos que se procesan

| Campo | Qué hace |
|---|---|
| `messages` | Guarda mensajes entrantes (`Source = cloud_api`), nombre de perfil y estados (sent → delivered → read / failed) |
| `smb_message_echoes` | Guarda lo que el cliente envía desde la app WhatsApp Business (`Source = business_app`) |
| `history` | Importa el historial de chats al activar la coexistencia (`Source = history`) |
| `smb_app_state_sync` | Sincroniza la agenda de la app Business (`Contacts.ContactName`, `InAddressBook`) |
| `account_update` | Marca la cuenta como `active` / `disconnected` según el evento (por WABA ID) |

Cada cambio recibido se guarda también en `dbo.WebhookEvents` con su estado
(`processed`, `failed`, `unrouted` si el número no está dado de alta, `ignored`), para auditoría y para reprocesar.
Los reintentos de Meta no duplican mensajes (`Wamid` es único).

## Puesta en marcha local

```bash
npm install
cp .env.example .env     # y rellenar
npm run dev
```

Crear las tablas ejecutando [sql/schema.sql](sql/schema.sql) en la base de datos.

### Dar de alta un cliente (Embedded Signup con coexistencia)

1. Crear el cliente: `INSERT INTO dbo.Clients (ClientId, Name) VALUES ('padel-club', 'Club de Pádel');`
2. Generar su enlace de alta firmado (7 días de validez) y enviárselo:
   ```bash
   npm run onboarding-link -- padel-club https://<app>.azurewebsites.net
   # en Azure: node dist/scripts/onboarding-link.js padel-club https://<app>.azurewebsites.net
   ```
3. El cliente abre `/onboarding`, pulsa **Conectar WhatsApp** y escanea el QR desde su app WhatsApp Business.
4. La página envía `code` + `waba_id` a `POST /api/onboarding`, que:
   - cambia el `code` por el token del cliente (`GET /oauth/access_token`; el code caduca en ~30 s),
   - obtiene el `phone_number_id` con `GET /{waba_id}/phone_numbers` (el evento de coexistencia no lo trae),
   - lo guarda en `dbo.WhatsAppAccounts` con `OnboardedAt`,
   - llama a `POST /{waba_id}/subscribed_apps`,
   - pide `POST /{phone_number_id}/smb_app_data` con `smb_app_state_sync` y luego con `history`.

Cada `sync_type` solo puede pedirse **una vez** y en las **24 h** siguientes al alta. Si una petición falla,
una tarea cada 10 min la reintenta mientras quede plazo. Pasadas 24 h sin completarla, registra un log
`ALERTA: sincronización de coexistencia no completada en 24 h` (crea una alerta sobre ese texto en
Application Insights) y el cliente tiene que repetir el alta.

### Caducidad del token del cliente

Con la plantilla oficial de Embedded Signup el token de cada cliente caduca (unos 60 días). El servicio:

- Al dar de alta o renovar, consulta `GET /debug_token` y guarda `TokenExpiresAt` y `DataAccessExpiresAt`.
- Cada 6 h vuelve a comprobar todos los tokens. En los últimos 14 días intenta renovarlo con `fb_exchange_token`;
  Meta no garantiza que eso alargue la caducidad, así que solo se usa el token nuevo si de verdad vence más tarde.
- Si no se ha podido renovar, avisa una vez por nivel (14 días, 3 días, caducado/revocado) con un log
  `ALERTA: …token del cliente…`. Crea una alerta sobre ese texto en Application Insights.
- Para renovar, envía al cliente un enlace de renovación. Solo cambia el token, sin tocar la sincronización:
  ```bash
  npm run onboarding-link -- padel-club https://<app>.azurewebsites.net --renew
  ```

Alternativa sin caducidad: asignar los activos de cada cliente al usuario del sistema de Ideam Estudi Creatiu y dejar
`AccessToken = NULL`, para que se use el token permanente de `ACCESS_TOKEN`. Esas cuentas no se vigilan.

Si el cliente elige en el flujo un número nuevo en vez de su app Business (`OnboardingType = cloud_api`), no
se sincroniza nada y hay que registrar el número con `POST /{phone_number_id}/register`, que no está implementado.

En Meta: añadir el dominio de la app a *Dominios permitidos para el SDK de JavaScript* en la configuración de
Inicio de sesión con Facebook para empresas.

### Enviar mensajes

```ts
import { sendText, sendTemplate, sendMessage } from './whatsapp/graph';

await sendText('<phone_number_id>', '34600111222', 'Hola!');
await sendTemplate('<phone_number_id>', '34600111222', 'recordatorio_reserva', 'es');
```

Los mensajes libres solo se pueden enviar dentro de las 24 h desde el último mensaje del usuario; fuera de esa
ventana, solo plantillas aprobadas.

### Probar el webhook con una firma válida

```bash
BODY='{"object":"whatsapp_business_account","entry":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.* //')
curl -i -X POST http://localhost:3000/webhook/whatsapp \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY"

curl -i "http://localhost:3000/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=123"
```

## Despliegue en Azure App Service

1. App Service Linux, Node 22 (`app-whatsapp-ideam`, sin "hostname único"), con **identidad administrada
   asignada por el sistema**.
2. **Variables de entorno**:
   - Secretos como referencias a Key Vault (`@Microsoft.KeyVault(...)`): `VERIFY_TOKEN`, `APP_SECRET`, `ACCESS_TOKEN`.
   - `KEY_VAULT_URL=https://kv-whatsapp-ideam.vault.azure.net/`: los tokens de cada cliente se guardan como secretos
     `waba-<id>-token` y en la base solo queda la referencia. La identidad de la web app necesita el rol
     *Key Vault Secrets Officer* (leer, escribir y borrar secretos).
   - Valores normales: `APP_ID`, `ES_CONFIG_ID`, `SQL_SERVER`, `SQL_DATABASE`. `PORT` lo pone Azure.
3. **Configuración general**: comando de inicio `npm start`, **Always On activado** (si no, la app se duerme y el
   procesado en segundo plano se corta), health check en `/health`.
4. **Azure SQL solo con autenticación de Entra ID**: permitir el acceso desde servicios de Azure y, como
   administrador de Entra, ejecutar [sql/schema.sql](sql/schema.sql) y después
   [sql/grant-webapp-identity.sql](sql/grant-webapp-identity.sql).
5. **Despliegue por OIDC**: crear una app registration (o identidad administrada asignada por el usuario) con
   *credencial federada* para `repo:ideamestudicreatiu/whatsapp-webhook:ref:refs/heads/main` y rol
   *Website Contributor* sobre la web app. En GitHub, variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID` y `AZURE_WEBAPP_NAME`. El workflow
   [.github/workflows/deploy.yml](.github/workflows/deploy.yml) despliega en cada push a `main`.
6. **Logs y alertas**: Application Insights basado en un área de trabajo de Log Analytics. Añadir una
   configuración de diagnóstico de la web app que envíe `AppServiceConsoleLogs` a esa área de trabajo, y una
   regla de alerta sobre `AppServiceConsoleLogs | where ResultDescription has "ALERTA"`.
7. En Meta (App → WhatsApp → Configuración): URL `https://<app>.azurewebsites.net/webhook/whatsapp`, el mismo
   `VERIFY_TOKEN`, y suscribir los campos `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`,
   `account_update`.

## Conservación y borrado de datos

La política de privacidad promete conservar los datos mientras dure el contrato, y **como máximo 30 días tras la
baja o desconexión** (`RETENTION_DAYS` en [src/retention.ts](src/retention.ts)). Una tarea diaria se encarga de:

- **Cuentas desconectadas**: un `account_update` de desconexión (`PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED`…) marca
  `DisconnectedAt`. A los 30 días se borran sus mensajes, conversaciones, contactos, eventos y la cuenta con su
  token. Si el cliente se reconecta antes, se cancela el borrado.
- **Eventos en bruto** (`dbo.WebhookEvents`): se borran a los 30 días, sea cual sea su estado.

Para borrar algo **a petición**, como la baja inmediata de un cliente o un usuario final que ejerce su derecho de
supresión, usa [sql/delete-data.sql](sql/delete-data.sql).

## Limitaciones conocidas

- Se responde 200 antes de guardar: si el proceso cae justo en ese momento, el evento se pierde (Meta no lo reenvía).
  Con más volumen, el siguiente paso es encolar el payload (Azure Service Bus / Storage Queue) antes de responder.
- Los ficheros multimedia no se descargan: se guarda el `media id` en `Payload` (caduca, hay que descargarlo pronto
  con `GET /{media_id}` si se necesita).

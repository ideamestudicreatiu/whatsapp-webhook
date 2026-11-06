import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drainBackground, runInBackground } from './background';
import { config } from './config';
import { closePool } from './db/pool';
import { errorInfo, log } from './logger';
import { OnboardingError, runOnboarding, runTokenRenewal, startSyncWatchdog, verifyOnboardingLink } from './onboarding/onboarding';
import { startTokenWatchdog } from './onboarding/tokens';
import { startRetentionJob } from './retention';
import { isValidSignature, safeEqual } from './signature';
import { processWebhook } from './webhook/process';
import { sendMessage, sendText, WhatsAppApiError } from './whatsapp/graph';
import { WebhookPayload } from './whatsapp/types';

const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple'); // "hub.mode" como clave literal, no como objeto anidado

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Verificación de Meta al configurar el webhook
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && typeof token === 'string' && typeof challenge === 'string' && safeEqual(token, config.verifyToken)) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  log.warn('Verificación de webhook rechazada', { mode });
  res.sendStatus(403);
});

// Eventos. Cuerpo sin parsear para poder validar la firma; los bloques de historial pueden ser grandes.
app.post('/webhook/whatsapp', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody) || !isValidSignature(rawBody, req.get('x-hub-signature-256'), config.appSecret)) {
    log.warn('Firma X-Hub-Signature-256 no válida', { ip: req.ip });
    res.sendStatus(401);
    return;
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.sendStatus(400);
    return;
  }

  res.sendStatus(200); // Meta exige respuesta rápida; si no, reintenta
  runInBackground('processWebhook', () => processWebhook(payload));
});

// Embedded Signup: página con el botón "Conectar WhatsApp" (se accede con un enlace firmado)
const onboardingHtml = readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8').replace(
  '__ONBOARDING_CONFIG__',
  () => JSON.stringify({ appId: config.appId, esConfigId: config.esConfigId, graphApiVersion: config.graphApiVersion }).replace(/</g, '\\u003c'),
);

app.get('/onboarding', (req, res) => {
  if (!verifyOnboardingLink(req.query.client, req.query.purpose, req.query.exp, req.query.sig)) {
    res.status(403).type('text/plain').send('Enlace de alta no válido o caducado. Pide uno nuevo a IDEAM Studio.');
    return;
  }
  res.type('html').send(onboardingHtml);
});

app.post('/api/onboarding', express.json({ limit: '16kb' }), async (req, res) => {
  const { clientId, purpose, exp, sig, code, waba_id, phone_number_id, event } = req.body ?? {};
  const linkPurpose = verifyOnboardingLink(clientId, purpose, exp, sig);
  if (!linkPurpose) {
    res.status(403).json({ error: 'Enlace de alta no válido o caducado' });
    return;
  }
  if (typeof code !== 'string' || typeof waba_id !== 'string' || (phone_number_id != null && typeof phone_number_id !== 'string')) {
    res.status(400).json({ error: 'Se requiere code y waba_id' });
    return;
  }
  try {
    const result =
      linkPurpose === 'renew'
        ? await runTokenRenewal({ clientId, code, wabaId: waba_id })
        : await runOnboarding({
            clientId,
            code,
            wabaId: waba_id,
            phoneNumberId: phone_number_id ?? undefined,
            event: typeof event === 'string' ? event : undefined,
          });
    res.json(result);
  } catch (err) {
    log.error('Error en el alta', { clientId, wabaId: waba_id, ...errorInfo(err) });
    if (err instanceof OnboardingError) res.status(err.httpStatus).json({ error: err.message });
    else if (err instanceof WhatsAppApiError) res.status(502).json({ error: 'Meta rechazó la petición', details: err.details });
    else res.status(500).json({ error: 'Error interno' });
  }
});

// API interna opcional para que otras herramientas envíen mensajes
if (config.internalApiKey) {
  const apiKey = config.internalApiKey;
  app.post('/api/messages', express.json({ limit: '1mb' }), async (req, res) => {
    const key = req.get('x-api-key');
    if (!key || !safeEqual(key, apiKey)) {
      res.sendStatus(401);
      return;
    }
    const { phoneNumberId, to, text, message } = req.body ?? {};
    if (typeof phoneNumberId !== 'string' || (!message && (typeof to !== 'string' || typeof text !== 'string'))) {
      res.status(400).json({ error: 'Se requiere phoneNumberId y (to + text) o message' });
      return;
    }
    try {
      const result = message ? await sendMessage(phoneNumberId, message) : await sendText(phoneNumberId, to, text);
      res.json(result);
    } catch (err) {
      log.error('Error enviando mensaje', { phoneNumberId, ...errorInfo(err) });
      if (err instanceof WhatsAppApiError) res.status(502).json({ error: err.details });
      else res.status(500).json({ error: err instanceof Error ? err.message : 'Error interno' });
    }
  });
}

const server = app.listen(config.port, () => {
  log.info('Webhook de WhatsApp escuchando', { port: config.port });
});
startSyncWatchdog();
startTokenWatchdog();
startRetentionJob();

async function shutdown(signal: string) {
  log.info('Apagando', { signal });
  server.close();
  await drainBackground(10_000);
  await closePool().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', errorInfo(err)));

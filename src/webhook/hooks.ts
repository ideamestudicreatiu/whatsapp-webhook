import { WhatsAppAccount } from '../db/repository';
import { log } from '../logger';
import { WaMessage } from '../whatsapp/types';

/**
 * Punto de extensión: se llama una vez por cada mensaje entrante nuevo (ya guardado).
 * Aquí irá la lógica de cada herramienta (bot de reservas del pádel, respuestas automáticas...).
 */
export async function onIncomingMessage(account: WhatsAppAccount, waId: string, message: WaMessage): Promise<void> {
  log.info('Mensaje entrante', { clientId: account.clientId, phoneNumberId: account.phoneNumberId, waId, type: message.type });
}

// Tipos (parciales) de los payloads de webhook de la WhatsApp Cloud API.
// Solo se tipan los campos que usamos; el resto se guarda tal cual en Payload.

export interface WebhookPayload {
  object: string; // "whatsapp_business_account"
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  id: string; // WABA ID
  time?: number;
  changes: WebhookChange[];
}

export interface WebhookChange {
  field: string;
  value: unknown;
}

export interface Metadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface GraphError {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

export interface WaMessage {
  from: string;
  to?: string; // presente en echoes e historial
  id: string; // wamid
  timestamp: string; // segundos Unix
  type: string;
  text?: { body: string };
  history_context?: { status?: string };
  [key: string]: unknown;
}

export interface WaContact {
  wa_id: string;
  profile?: { name?: string };
}

export interface WaStatus {
  id: string; // wamid del mensaje enviado
  status: string; // sent | delivered | read | failed
  timestamp: string;
  recipient_id: string;
  errors?: GraphError[];
}

/** field = "messages" */
export interface MessagesValue {
  messaging_product: 'whatsapp';
  metadata: Metadata;
  contacts?: WaContact[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
  errors?: GraphError[];
}

/** field = "smb_message_echoes": mensajes enviados desde la app WhatsApp Business (coexistencia) */
export interface EchoesValue {
  messaging_product: 'whatsapp';
  metadata: Metadata;
  message_echoes?: WaMessage[];
}

/** field = "history": historial de chats sincronizado al activar la coexistencia */
export interface HistoryValue {
  messaging_product: 'whatsapp';
  metadata: Metadata;
  history?: HistoryChunk[];
}

export interface HistoryChunk {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: { id: string; messages?: WaMessage[] }[];
  errors?: GraphError[];
}

/** field = "smb_app_state_sync": contactos de la agenda de la app WhatsApp Business */
export interface StateSyncValue {
  messaging_product: 'whatsapp';
  metadata: Metadata;
  state_sync?: {
    type: string; // "contact"
    contact?: { full_name?: string; first_name?: string; phone_number: string };
    action: string; // "add" | "remove"
    metadata?: { timestamp?: string };
  }[];
}

/** field = "account_update": altas/bajas del partner, desconexiones, etc. (sin metadata.phone_number_id) */
export interface AccountUpdateValue {
  event: string;
  phone_number?: string;
  waba_info?: { waba_id?: string; owner_business_id?: string };
  [key: string]: unknown;
}

/** wa_id / phone_number solo con dígitos, para que coincidan entre campos distintos. */
export function normalizeWaId(value: string): string {
  return value.replace(/\D/g, '');
}

export function fromUnix(timestamp: string | number | undefined): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/** Texto legible de un mensaje (entrante, echo, historial o saliente) para la columna Body. */
export function extractBody(message: { type: string; [key: string]: unknown }): string | null {
  const m = message as Record<string, any>;
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null;
    case 'image':
    case 'video':
    case 'document':
      return m[m.type]?.caption ?? m[m.type]?.filename ?? null;
    case 'button':
      return m.button?.text ?? null;
    case 'interactive':
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.interactive?.body?.text ?? null;
    case 'reaction':
      return m.reaction?.emoji ?? null;
    case 'location': {
      const l = m.location ?? {};
      return l.name ?? l.address ?? (l.latitude != null ? `${l.latitude},${l.longitude}` : null);
    }
    case 'template':
      return m.template?.name ? `[plantilla: ${m.template.name}]` : null;
    default:
      return null;
  }
}

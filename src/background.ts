import { errorInfo, log } from './logger';

const pending = new Set<Promise<void>>();

/** Lanza una tarea sin bloquear la respuesta HTTP. Los errores se registran, no se propagan. */
export function runInBackground(name: string, task: () => Promise<void>): void {
  const promise: Promise<void> = Promise.resolve()
    .then(task)
    .catch((err) => log.error(`Fallo en tarea en segundo plano: ${name}`, errorInfo(err)))
    .finally(() => pending.delete(promise));
  pending.add(promise);
}

/** Espera a que terminen las tareas pendientes (apagado ordenado), con límite de tiempo. */
export async function drainBackground(timeoutMs: number): Promise<void> {
  if (pending.size === 0) return;
  log.info('Esperando tareas pendientes', { count: pending.size });
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

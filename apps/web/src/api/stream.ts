import { authHeaders } from './client';
import { SseParser } from './sse';

export type StreamStatus = 'connecting' | 'live' | 'offline';

export interface StreamHandlers {
  onEvent(type: string, data: Record<string, unknown>): void;
  onStatus(status: StreamStatus): void;
  onUnauthorized(): void;
}

const MAX_BACKOFF_MS = 15_000;

/** Follow /api/stream with the session cookie, reconnecting with backoff; returns a stop function. */
export function followStream(handlers: StreamHandlers): () => void {
  const controller = new AbortController();
  let backoff = 1000;

  const readOnce = async (): Promise<'retry' | 'stop'> => {
    handlers.onStatus('connecting');
    const response = await fetch('/api/stream', {
      credentials: 'same-origin',
      headers: authHeaders(),
      signal: controller.signal,
    });
    if (response.status === 401) {
      handlers.onUnauthorized();
      return 'stop';
    }
    if (!response.ok || !response.body) {
      return 'retry';
    }
    handlers.onStatus('live');
    backoff = 1000;
    const parser = new SseParser();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return 'retry';
      }
      for (const message of parser.push(value)) {
        handlers.onEvent(message.event, JSON.parse(message.data) as Record<string, unknown>);
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const outcome = await readOnce().catch(() => 'retry' as const);
      if (outcome === 'stop' || controller.signal.aborted) {
        return;
      }
      handlers.onStatus('offline');
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  };
  void loop();
  return () => controller.abort();
}

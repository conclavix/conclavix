import type { ChangeStream, Db } from 'mongodb';
import type { FastifyBaseLogger } from 'fastify';
import { WATCHED_COLLECTIONS, toStreamEvent, type StreamEvent } from './events.js';

type Listener = (event: StreamEvent) => void;

const RESTART_DELAY_MS = 1000;

/** One change stream per process, shared by every connected board client. */
export class StreamHub {
  private readonly listeners = new Set<Listener>();
  private stream: ChangeStream | null = null;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ensureStream();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        void this.stopStream();
      }
    };
  }

  get size(): number {
    return this.listeners.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.stopStream();
  }

  private ensureStream(): void {
    if (this.stream || this.closed) {
      return;
    }
    const stream = this.db.watch(
      [
        {
          $match: {
            'ns.coll': { $in: WATCHED_COLLECTIONS },
            operationType: { $in: ['insert', 'update', 'replace', 'delete'] },
          },
        },
      ],
      { fullDocument: 'updateLookup' },
    );
    stream.on('change', (change) => {
      const event = toStreamEvent(change);
      if (event) {
        for (const listener of this.listeners) {
          listener(event);
        }
      }
    });
    stream.on('error', (error: unknown) => {
      this.log.warn({ err: error }, 'change stream failed, restarting');
      this.stream = null;
      void stream.close();
      setTimeout(() => {
        if (this.listeners.size > 0) {
          this.ensureStream();
        }
      }, RESTART_DELAY_MS).unref();
    });
    this.stream = stream;
  }

  private async stopStream(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    await stream?.close();
  }
}

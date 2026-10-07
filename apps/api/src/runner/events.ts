import pino from 'pino';
import { ObjectId } from 'mongodb';
import { RUN_EVENT_DATA_KINDS, runEventDataSchema, type RunEventData } from '@conclavix/core';
import type { Collections, RunEventDoc, RunEventType } from '../db.js';
import { RECORDER_TEXT_CAP, REDACTION_FAILED, Redactor, errorKind } from './redact.js';

const log = pino({ name: 'runner' });

const FLUSH_SIZE = 50;
/**
 * Longest time an event waits in the buffer, so the live view and a chat reply follow a run while
 * it is going instead of in batches of FLUSH_SIZE.
 */
export const FLUSH_INTERVAL_MS = 1000;

export interface RecorderLimits {
  /** Ordinary events stored per run; later ones are dropped and counted. */
  maxEvents: number;
  /** Terminal events (the result, the runner's closing lines) stored on top of that. */
  maxTerminal: number;
}

export const DEFAULT_RECORDER_LIMITS: RecorderLimits = { maxEvents: 2000, maxTerminal: 20 };

/**
 * Buffers a run's log lines and writes them in batches; every event is redacted. Ordinary events
 * are capped per run, but room is reserved for terminal events, so the result and the runner's
 * finished/cost line are always stored. Dropped events are reported by one marker event before
 * the next terminal event (or when the recorder finishes).
 */
export class RunEventRecorder {
  private seq = 0;
  private regular = 0;
  private terminal = 0;
  private dropped = 0;
  private reported = 0;
  private buffer: RunEventDoc[] = [];
  private pending: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly collections: Collections,
    private readonly runId: ObjectId,
    private readonly redactor: Redactor = new Redactor(),
    private readonly limits: RecorderLimits = DEFAULT_RECORDER_LIMITS,
  ) {}

  /** Record an event; a `result` event is terminal and bypasses the cap. */
  record(type: RunEventType, text: string, data?: RunEventData): void {
    if (type === 'result') {
      this.recordTerminal(type, text, data);
      return;
    }
    if (this.regular >= this.limits.maxEvents) {
      this.dropped += 1;
      return;
    }
    this.regular += 1;
    this.push(type, text, data);
  }

  /** Record one of the runner's closing lines (finished, runner error); never dropped by the cap. */
  recordFinal(text: string): void {
    this.recordTerminal('runner', text);
  }

  /** Report any dropped events, then write everything that is still buffered. */
  finish(): Promise<void> {
    this.reportDropped();
    return this.flush();
  }

  private recordTerminal(type: RunEventType, text: string, data?: RunEventData): void {
    if (this.terminal >= this.limits.maxTerminal) {
      this.dropped += 1;
      return;
    }
    this.terminal += 1;
    this.reportDropped();
    this.push(type, text, data);
  }

  private reportDropped(): void {
    const unreported = this.dropped - this.reported;
    if (unreported <= 0) return;
    this.reported = this.dropped;
    this.push(
      'runner',
      `[log truncated: ${unreported} ${unreported === 1 ? 'event' : 'events'} dropped after the limit of ${this.limits.maxEvents}]`,
    );
  }

  private push(type: RunEventType, text: string, data?: RunEventData): void {
    this.seq += 1;
    const valid = this.validData(type, data);
    this.buffer.push(
      this.redacted({
        _id: new ObjectId(),
        runId: this.runId,
        seq: this.seq,
        type,
        text,
        ...(valid ? { data: valid } : {}),
        at: new Date(),
      }),
    );
    if (this.buffer.length >= FLUSH_SIZE) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref();
    }
  }

  private validData(type: RunEventType, data: RunEventData | undefined): RunEventData | undefined {
    if (data === undefined) {
      return undefined;
    }
    const parsed = runEventDataSchema.safeParse(data);
    if (!parsed.success || RUN_EVENT_DATA_KINDS[parsed.data.kind] !== type) {
      log.warn(
        {
          runId: this.runId.toHexString(),
          type,
          issues: parsed.success
            ? [{ message: `data kind ${parsed.data.kind} does not match event type ${type}` }]
            : parsed.error.issues.slice(0, 5),
        },
        'dropping invalid structured run event data',
      );
      return undefined;
    }
    return parsed.data;
  }

  /** The single point every event passes before storage: redact the whole document, then cap. */
  private redacted(event: RunEventDoc): RunEventDoc {
    try {
      const clean = this.redactor.deep(event);
      return {
        ...clean,
        text:
          clean.text.length > RECORDER_TEXT_CAP
            ? `${this.redactor.text(clean.text.slice(0, RECORDER_TEXT_CAP), { end: true })}...`
            : clean.text,
      };
    } catch (error) {
      log.error(
        { runId: this.runId.toHexString(), seq: event.seq, errorKind: errorKind(error) },
        'run event redaction failed, storing a placeholder',
      );
      const { _id, runId, seq, type, at } = event;
      return { _id, runId, seq, type, text: REDACTION_FAILED, at };
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length > 0) {
      this.pending = this.pending.then(async () => {
        try {
          await this.collections.runEvents.insertMany(batch, { ordered: false });
        } catch (error) {
          log.error(
            { err: error, runId: this.runId.toHexString(), batchSize: batch.length },
            'failed to persist run events',
          );
        }
      });
    }
    return this.pending;
  }
}

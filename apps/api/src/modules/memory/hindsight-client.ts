import { z } from 'zod';
import { AppError } from '../../errors.js';

const metadataSchema = z.record(z.string(), z.unknown()).nullable().catch(null);

const documentSchema = z.object({
  id: z.string(),
  original_text: z.string().nullable().catch(null),
  tags: z.array(z.string()).catch([]),
  document_metadata: metadataSchema,
  updated_at: z.string(),
});

const listSchema = z.object({ items: z.array(documentSchema) });

const recallSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      document_id: z.string().nullable().catch(null),
      metadata: metadataSchema,
    }),
  ),
});

export type HindsightDocument = z.infer<typeof documentSchema>;
export type HindsightRecallResult = z.infer<typeof recallSchema>['results'][number];

/** A Hindsight answer Conclavix cannot use: a 4xx we caused, or a body that is not what we expect. */
export class HindsightError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HindsightError';
  }
}

/** Hindsight down, slow, overloaded or its LLM rate-limited: the board gets 503, agents a readable error. */
const unavailable = (cause: string): AppError =>
  new AppError(503, 'memory_unavailable', 'Memory is temporarily unavailable; try again later.', {
    cause: cause.slice(0, 300),
  });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface HindsightClientOptions {
  baseUrl: string;
  bank: string;
  apiKey?: string;
  timeoutMs?: number;
}

/** Minimal REST client for the parts of the Hindsight API Conclavix uses; every answer is validated. */
export class HindsightClient {
  private bankReady: Promise<void> | null = null;

  constructor(private readonly options: HindsightClientOptions) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const base = this.options.baseUrl.replace(/\/$/, '');
    const url = `${base}/v1/default/banks/${encodeURIComponent(this.options.bank)}${path}`;
    let status: number;
    let text: string;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw unavailable(`hindsight ${method} ${path} did not answer: ${describe(error)}`);
    }
    if (status === 404 && method === 'GET') {
      return null;
    }
    if (status === 429 || status >= 500) {
      throw unavailable(`hindsight ${method} ${path} answered ${status}: ${text.slice(0, 200)}`);
    }
    if (status < 200 || status >= 300) {
      throw new HindsightError(
        status,
        `hindsight ${method} ${path} failed: ${status} ${text.slice(0, 200)}`,
      );
    }
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new HindsightError(status, `hindsight ${method} ${path} returned invalid JSON`);
    }
  }

  private async requestAs<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const raw = await this.request(method, path, body);
    if (raw === null) {
      return null;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new HindsightError(502, `hindsight ${method} ${path} returned an unexpected shape`);
    }
    return parsed.data;
  }

  /** Create the bank once per process; PUT is idempotent on the Hindsight side. */
  ensureBank(): Promise<void> {
    this.bankReady ??= this.request('PUT', '', {}).then(
      () => undefined,
      (error: unknown) => {
        this.bankReady = null;
        throw error;
      },
    );
    return this.bankReady;
  }

  async retain(item: {
    documentId: string;
    content: string;
    tags: string[];
    metadata: Record<string, string>;
  }): Promise<void> {
    await this.ensureBank();
    await this.request('POST', '/memories', {
      async: false,
      items: [
        {
          content: item.content,
          document_id: item.documentId,
          tags: item.tags,
          metadata: item.metadata,
          update_mode: 'replace',
        },
      ],
    });
  }

  async recall(
    query: string,
    tags: string[] | null,
    maxTokens: number,
  ): Promise<HindsightRecallResult[]> {
    await this.ensureBank();
    const body: Record<string, unknown> = {
      query,
      max_tokens: maxTokens,
      // Observations are consolidated across documents and carry no document or metadata,
      // so Conclavix could not tell which bucket they belong to.
      types: ['world', 'experience'],
    };
    if (tags) {
      body['tags'] = tags;
      body['tags_match'] = 'any_strict';
    }
    return (await this.requestAs(recallSchema, 'POST', '/memories/recall', body))?.results ?? [];
  }

  async getDocument(id: string): Promise<HindsightDocument | null> {
    await this.ensureBank();
    return this.requestAs(documentSchema, 'GET', `/documents/${encodeURIComponent(id)}`);
  }

  async listDocuments(
    tags: string[] | null,
    match: 'all_strict' | 'any_strict',
    limit: number,
  ): Promise<HindsightDocument[]> {
    await this.ensureBank();
    const params = new URLSearchParams({ limit: String(limit), tags_match: match });
    for (const tag of tags ?? []) params.append('tags', tag);
    return (
      (await this.requestAs(listSchema, 'GET', `/documents?${params.toString()}`))?.items ?? []
    );
  }

  async deleteDocument(id: string): Promise<boolean> {
    await this.ensureBank();
    try {
      await this.request('DELETE', `/documents/${encodeURIComponent(id)}`);
      return true;
    } catch (error) {
      if (error instanceof HindsightError && error.status === 404) return false;
      throw error;
    }
  }
}

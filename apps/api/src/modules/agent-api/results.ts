import { z } from 'zod';
import { AppError } from '../../errors.js';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** Run a tool and turn domain and validation errors into tool errors the model can read. */
export async function guarded(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    if (error instanceof AppError || error instanceof z.ZodError) {
      const details = error instanceof AppError ? error.details : error.issues;
      return { ...ok({ error: error.message, details }), isError: true };
    }
    throw error;
  }
}

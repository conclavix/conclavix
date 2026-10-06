import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  /** Create an application error with an HTTP status, public code, message, and optional details. */
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** Create a 404 error for a missing resource. */
export const notFound = (what: string): AppError =>
  new AppError(404, 'not_found', `${what} not found`);

/** Create a 409 error for a conflict with existing state. */
export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'conflict', message, details);

/** Create a 422 error for an operation that violates domain rules. */
export const unprocessable = (message: string, details?: unknown): AppError =>
  new AppError(422, 'unprocessable', message, details);

/** Recognize MongoDB duplicate-key errors by their numeric error code. */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/** Map known errors to HTTP responses and hide unexpected error details behind a generic 500. */
function toResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: { error: error.code, message: error.message, details: error.details },
    };
  }
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return { status: 400, body: { error: 'invalid_request', message: 'Invalid request', details } };
  }
  const fastifyError = error as Partial<FastifyError>;
  if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
    return {
      status: fastifyError.statusCode,
      body: { error: fastifyError.code ?? 'bad_request', message: fastifyError.message },
    };
  }
  return { status: 500, body: { error: 'internal', message: 'Internal server error' } };
}

/** Register error and missing-route responses, logging server errors before replying. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const { status, body } = toResponse(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
    }
    return reply.status(status).send(body);
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: 'not_found', message: 'Route not found' }),
  );
}

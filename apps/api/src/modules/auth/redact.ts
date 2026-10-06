import type { FastifyRequest } from 'fastify';

/** Strip password reset tokens from a URL before it reaches the request log. */
export function redactUrl(url: string): string {
  return url
    .replace(/(\/reset-password\/)[^/?#]+/g, '$1[redacted]')
    .replace(/([?&]token=)[^&#]*/g, '$1[redacted]');
}

/** Request log serializer: the fields Fastify logs by default, with the URL redacted. */
export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
  };
}

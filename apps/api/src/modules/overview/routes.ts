import type { FastifyInstance } from 'fastify';
import { parse } from '../../validation.js';
import type { OverviewService } from './service.js';
import { overviewQuerySchema } from './types.js';

/** Register the aggregated board overview. */
export function registerOverviewRoutes(app: FastifyInstance, overview: OverviewService): void {
  app.get('/api/overview', async (request) =>
    overview.get(parse(overviewQuerySchema, request.query)),
  );
}

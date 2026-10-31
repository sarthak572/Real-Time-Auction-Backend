import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ZodError } from 'zod';
import { logger } from './logger.js';
import { pool } from './db.js';
import { cacheStats } from './cache.js';
import { writeBehindStats } from './state.js';
import { config } from './config.js';
import { hub } from './realtime/hub.js';
import { realtimeRoutes } from './realtime/routes.js';
import { demoRoutes } from './demo.js';
import { registry, httpDuration } from './metrics.js';
import { registerApiCollectors } from './metrics-collectors.js';
import { AppError } from './errors.js';
import { userRoutes } from './modules/users.js';
import { auctionRoutes } from './modules/auctions.js';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const instanceId = config.INSTANCE_ID ?? `api-${config.PORT}`;

export function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Every request gets an id; every log line for that request carries it (reqId), so a
    // single request can be traced across log lines.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    // Automatic request lines (2 per request) are off in production; the hook below keeps the ones that matter.
    disableRequestLogging: config.LOG_REQUESTS === 'false',
    trustProxy: config.TRUST_PROXY === 'true',
    // Must be LONGER than nginx's upstream keepalive_timeout (60 s). Node's default is 5 s, so nginx would sometimes reuse a
    // connection Node had just closed, and a POST sent on it fails with 502 (nginx cannot safely retry a bid).
    keepAliveTimeout: 65_000,
  });

  // With automatic request logging off, still log every server error and every slow request.
  app.addHook('onResponse', async (req, reply) => {
    const ms = reply.elapsedTime;
    // route is the pattern (/auctions/:id/bids), never the raw URL, so the number of time series stays small.
    httpDuration.observe({ method: req.method, route: req.routeOptions.url ?? 'unmatched', status: String(reply.statusCode) }, ms / 1000);
    if (config.LOG_REQUESTS === 'true') return;
    if (reply.statusCode >= 500 || ms >= config.LOG_SLOW_MS) {
      req.log.warn(
        { event: reply.statusCode >= 500 ? 'request.error' : 'request.slow', method: req.method, url: req.routeOptions.url, statusCode: reply.statusCode, durationMs: Math.round(ms) },
        'request needs attention',
      );
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-instance', instanceId);
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof ZodError) {
      req.log.warn({ event: 'validation.failed', issues: err.issues }, 'validation failed');
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: err.issues });
    }
    if (err instanceof AppError) {
      if (err.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    req.log.error({ event: 'unhandled.error', err }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL', message: 'internal server error' });
  });

  // Prometheus scrapes this directly on each instance. nginx hides it from the outside (see nginx.conf).
  registerApiCollectors();
  app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));

  // Liveness: is the process up? Readiness: can it actually serve (DB reachable)?
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready', pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } };
    } catch {
      return reply.code(503).send({ status: 'db_unavailable' });
    }
  });

  // Runtime stats for bottleneck hunting (replaced by Prometheus metrics in Phase 7).
  app.get('/health/stats', async () => {
    const m = process.memoryUsage();
    const stats = {
      rssMb: Math.round(m.rss / 1048576),
      heapUsedMb: Math.round(m.heapUsed / 1048576),
      eventLoopLagP99Ms: +(loopDelay.percentile(99) / 1e6).toFixed(1),
      eventLoopLagMaxMs: +(loopDelay.max / 1e6).toFixed(1),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      cache: {
        ...cacheStats,
        hitRatio: cacheStats.hits + cacheStats.misses ? +(cacheStats.hits / (cacheStats.hits + cacheStats.misses)).toFixed(3) : null,
      },
      realtime: hub.snapshot(),
      instance: instanceId,
      bidImpl: config.BID_IMPL,
      writeBehind: config.BID_IMPL === 'redis' ? await writeBehindStats() : undefined,
    };
    loopDelay.reset();
    return stats;
  });

  app.register(userRoutes);
  app.register(auctionRoutes);
  app.register(realtimeRoutes);
  if (config.NODE_ENV !== 'production') app.register(demoRoutes);
  return app;
}

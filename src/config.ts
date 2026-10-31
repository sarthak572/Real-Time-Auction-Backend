import 'dotenv/config';
import { z } from 'zod';

// Fail fast at boot if configuration is wrong, instead of failing at 3am.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  // Behind nginx: believe X-Forwarded-For so req.ip is the real client, not the proxy. Never enable without a proxy in front.
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  // Name of this instance, returned in the x-instance header and /health/stats.
  INSTANCE_ID: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  // 'single' = one SQL statement (short lock). 'legacy' = the original 5-round-trip transaction, kept for A/B load tests.
  // 'redis'  = write-behind: Redis is the live authority, a flusher writes batches to Postgres (default).
  // 'single' = one SQL statement against Postgres. 'legacy' = original 5-round-trip transaction.
  BID_IMPL: z.enum(['redis', 'single', 'legacy']).default('redis'),
  // Write-behind settings.
  STATE_REDIS_URL: z.string().url().default('redis://localhost:6380'),
  FLUSH_INTERVAL_MS: z.coerce.number().default(200),
  FLUSH_BATCH_SIZE: z.coerce.number().default(1000),
  FLUSH_RECLAIM_IDLE_MS: z.coerce.number().default(5000), // take over entries a dead flusher read but never acknowledged
  // How long a bid's Idempotency-Key is remembered. Every key costs ~200 bytes in the state Redis (which never evicts),
  // so this is a memory budget: at 1,000 keyed bids/s, 600 s is ~120 MB.
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().default(600),
  // Throughput switches for the write-behind bid path (both on by default; off = the earlier behaviour, for comparison).
  BID_BATCH: z.enum(['true', 'false']).default('true'), // send all bids that arrive in the same event-loop turn as one Redis write
  PUBLISH_IN_SCRIPT: z.enum(['true', 'false']).default('true'), // publish the live event from inside the bid script
  // Above this share of the state Redis memory limit, requests that carry an Idempotency-Key are refused (503) so the
  // keys cannot push the never-evicting Redis into refusing every bid. Plain bids keep working.
  IDEMPOTENCY_MEMORY_LIMIT: z.coerce.number().min(0).max(1).default(0.8),
  FLUSHER_METRICS_PORT: z.coerce.number().default(9101),
  WB_MAX_BACKLOG: z.coerce.number().default(100_000), // refuse new bids if this many are waiting to be flushed
  FLUSHER_IN_PROCESS: z.enum(['true', 'false']).default('false'), // run the flusher inside the API process (dev convenience)
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().default(10),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  AUCTION_CACHE_TTL_SECONDS: z.coerce.number().default(30),
  LIST_CACHE_TTL_SECONDS: z.coerce.number().default(2),
  // Real-time (WebSocket) limits. Every open socket costs memory, so cap them.
  WS_MAX_CONNECTIONS: z.coerce.number().default(10_000),
  WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().default(50),
  WS_HEARTBEAT_MS: z.coerce.number().default(25_000),
  WS_MAX_BUFFERED_BYTES: z.coerce.number().default(1_048_576),
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().default(1024),
  WS_CATCHUP_MAX: z.coerce.number().default(100),
  // Logging volume. Unset = sensible default for the environment (see below).
  LOG_REQUESTS: z.enum(['true', 'false']).optional(), // Fastify's automatic 'incoming request' + 'request completed' lines
  LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(), // share of routine success events that are logged
  LOG_ASYNC: z.enum(['true', 'false']).optional(), // buffer log writes instead of writing synchronously on every line
  LOG_SLOW_MS: z.coerce.number().default(500), // requests slower than this are always logged
});

const parsed = schema.parse(process.env);
const production = parsed.NODE_ENV === 'production';

// Development logs everything synchronously (easy to read). Production logs only what matters, buffered:
// every error, every slow request, and a sample of routine events. Sampled events carry their sampleRate,
// so a log reader (or the future AI assistant) can scale counts back up.
export const config = {
  ...parsed,
  // Where live bid events travel. When the bid script publishes them, they are on the state Redis.
  PUBSUB_URL: parsed.BID_IMPL === 'redis' && parsed.PUBLISH_IN_SCRIPT === 'true' ? parsed.STATE_REDIS_URL : parsed.REDIS_URL,
  LOG_REQUESTS: parsed.LOG_REQUESTS ?? (production ? 'false' : 'true'),
  LOG_SAMPLE_RATE: parsed.LOG_SAMPLE_RATE ?? (production ? 0.01 : 1),
  LOG_ASYNC: parsed.LOG_ASYNC ?? (production ? 'true' : 'false'),
};

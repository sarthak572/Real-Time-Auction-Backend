import { config } from './config.js';
import { logger, flushLogs } from './logger.js';
import { pool } from './db.js';
import { redis } from './cache.js';
import { hub } from './realtime/hub.js';
import { stateRedis, waitStateReady } from './state.js';
import { Flusher } from './flusher.js';
import { buildApp } from './app.js';

const app = buildApp();
hub.start();

// Optional: run the flusher inside this process (dev). In production it runs as its own process (npm run flusher).
const embedded = config.BID_IMPL === 'redis' && config.FLUSHER_IN_PROCESS === 'true' ? new Flusher() : null;
if (config.BID_IMPL === 'redis') await waitStateReady();
if (embedded) {
  await embedded.init();
  embedded.start();
}

// Graceful shutdown: stop accepting requests, finish in-flight ones, then close DB connections.
// Without this, deploys drop live requests.
async function shutdown(signal: string) {
  logger.info({ event: 'shutdown.start', signal }, 'shutting down');
  await embedded?.stop();
  await hub.shutdown(); // close live sockets politely (code 1001) so clients reconnect elsewhere
  await app.close();
  await pool.end();
  await redis.quit().catch(() => undefined);
  await stateRedis.quit().catch(() => undefined);
  logger.info({ event: 'shutdown.done' }, 'bye');
  flushLogs(); // buffered log lines must reach the file before exiting
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: '0.0.0.0' });
logger.info({ event: 'server.started', port: config.PORT }, 'server started');

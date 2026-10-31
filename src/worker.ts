// The flusher as its own process: npm run flusher
// It can be restarted or run several times at once; entries are shared through a Redis consumer group.
import { logger, flushLogs } from './logger.js';
import { pool } from './db.js';
import { stateRedis, waitStateReady } from './state.js';
import { Flusher } from './flusher.js';
import { registry } from './metrics.js';
import { config } from './config.js';
import { createServer } from 'node:http';

await waitStateReady();
const flusher = new Flusher();
await flusher.init();
flusher.start();

// The flusher has no web server of its own, so give Prometheus a tiny one.
const metricsServer = createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': registry.contentType });
    res.end(await registry.metrics());
  } else {
    res.writeHead(404).end();
  }
});
metricsServer.listen(config.FLUSHER_METRICS_PORT, '0.0.0.0');
logger.info({ event: 'flusher.started' }, 'flusher started');

async function shutdown(signal: string) {
  logger.info({ event: 'flusher.stopping', signal }, 'flusher stopping');
  metricsServer.close();
  await flusher.stop();
  await stateRedis.quit().catch(() => undefined);
  await pool.end();
  logger.info({ event: 'flusher.stopped' }, 'flusher stopped');
  flushLogs();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

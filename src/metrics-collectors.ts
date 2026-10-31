// Metrics that read live state from the API process (pool, cache, sockets, write-behind backlog).
// Kept separate from metrics.ts so the flusher does not have to load the WebSocket and HTTP code.
import { pool } from './db.js';
import { cacheStats } from './cache.js';
import { hub } from './realtime/hub.js';
import { stateRedis, STREAM, stateMemory, startMemoryWatch } from './state.js';
import { config } from './config.js';
import { gauge, labelledGauge, mirrorCounter } from './metrics.js';

let registered = false;
export function registerApiCollectors() {
  if (registered) return; // buildApp() can run more than once in one process (tests)
  registered = true;
  labelledGauge('pg_pool_connections', 'Postgres pool: total, idle and waiting (queued for a connection) clients', 'state', () => ({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  }));

  mirrorCounter('cache_hits_total', 'Auction reads answered from the Redis cache', () => cacheStats.hits);
  mirrorCounter('cache_misses_total', 'Auction reads that had to go to Postgres', () => cacheStats.misses);
  mirrorCounter('cache_errors_total', 'Redis cache errors (reads fall back to Postgres)', () => cacheStats.errors);
  mirrorCounter('cache_coalesced_total', 'Cache misses that shared another request’s Postgres query', () => cacheStats.coalesced);

  gauge('ws_active_sockets', 'Open WebSocket connections on this instance', () => hub.snapshot().activeSockets);
  gauge('ws_rooms', 'Auctions with at least one viewer on this instance', () => hub.snapshot().auctionsWithViewers);
  gauge('ws_buffered_bytes', 'Bytes queued to be sent to slow WebSocket clients', () => hub.snapshot().bufferedBytes);
  mirrorCounter('ws_messages_sent_total', 'WebSocket messages sent', () => hub.counters.messagesSent);
  mirrorCounter('ws_connections_total', 'WebSocket connections accepted', () => hub.counters.connectionsTotal);
  mirrorCounter('ws_rejected_total', 'WebSocket connections refused (address limit or server full)', () => hub.counters.rejected);
  mirrorCounter('ws_dropped_slow_clients_total', 'Clients dropped for not reading fast enough', () => hub.counters.droppedSlowClients);
  mirrorCounter('ws_heartbeat_terminated_total', 'Dead connections closed by the heartbeat', () => hub.counters.heartbeatTerminated);
  mirrorCounter('pubsub_published_total', 'Bid events published to Redis', () => hub.counters.published);
  mirrorCounter('pubsub_received_total', 'Bid events received from Redis', () => hub.counters.received);

  if (config.BID_IMPL === 'redis') {
    // The state Redis never evicts: if it fills up, bids fail. Idempotency keys and the unsaved backlog are what fill it.
    labelledGauge('state_redis_memory_bytes', 'State Redis memory: used and the configured maximum', 'kind', () => ({ used: stateMemory.used, max: stateMemory.max }));
    startMemoryWatch();
    // Reported by the API too (not only the flusher) so the backlog is still visible when the flusher is dead.
    gauge('writebehind_stream_length', 'Accepted bids waiting to be saved to Postgres', async () => {
      try {
        return await stateRedis.xlen(STREAM);
      } catch {
        return -1;
      }
    });
  }
}

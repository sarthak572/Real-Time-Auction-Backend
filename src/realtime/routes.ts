import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { getAuction } from '../modules/auction-queries.js';
import { hub, type Client, type BidEvent } from './hub.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const queryParam = z.object({ lastSeq: z.coerce.number().int().min(0).optional() });

export async function realtimeRoutes(app: FastifyInstance) {
  await app.register(websocket, { options: { maxPayload: config.WS_MAX_PAYLOAD_BYTES } });

  app.get(
    '/auctions/:id/live',
    {
      websocket: true,
      // Runs on the HTTP upgrade request, BEFORE the connection becomes a WebSocket,
      // so we can still answer with normal HTTP errors (404 / 429 / 503).
      preValidation: async (req) => {
        const { id } = idParam.parse(req.params);
        const reason = hub.checkCapacity(req.ip);
        if (reason) {
          hub.counters.rejected++;
          req.log.warn({ event: 'ws.rejected', reason, ip: req.ip }, 'websocket rejected');
          throw reason === 'ip_limit'
            ? new AppError(429, 'WS_IP_LIMIT', 'too many connections from this address')
            : new AppError(503, 'WS_SERVER_FULL', 'server is at connection capacity');
        }
        if (!(await getAuction(id, req.log))) throw new AppError(404, 'AUCTION_NOT_FOUND', 'auction not found');
      },
    },
    (socket, req) => {
      const { id: auctionId } = idParam.parse(req.params);
      const { lastSeq } = queryParam.parse(req.query);
      const client: Client = {
        id: randomUUID(),
        socket,
        ip: req.ip,
        auctionId,
        alive: true,
        connectedAt: Date.now(),
      };

      // Register and attach every handler synchronously, before any await, so nothing is missed.
      hub.add(client);
      req.log.info({ event: 'ws.connected', clientId: client.id, auctionId, lastSeq, ip: client.ip }, 'websocket connected');

      socket.on('pong', () => (client.alive = true));

      // Clients only listen. The one thing they may send is an app-level ping (browsers cannot send ping frames).
      socket.on('message', (raw) => {
        client.alive = true;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg?.type === 'ping') hub.send(client, JSON.stringify({ type: 'pong' }));
        } catch {
          hub.send(client, JSON.stringify({ type: 'error', code: 'BAD_MESSAGE' }));
        }
      });

      socket.on('close', (code) => {
        hub.remove(client);
        req.log.info(
          { event: 'ws.disconnected', clientId: client.id, auctionId, code, durationMs: Date.now() - client.connectedAt },
          'websocket disconnected',
        );
      });
      socket.on('error', (err) =>
        req.log.warn({ event: 'ws.error', clientId: client.id, err: err.message }, 'websocket error'),
      );

      sendInitialState(client, lastSeq, req.log).catch((err) => {
        req.log.error({ event: 'ws.init_failed', clientId: client.id, err: err.message }, 'initial state failed');
        socket.close(1011, 'internal error');
      });
    },
  );
}

type Log = FastifyInstance['log'];

/**
 * 1. snapshot of the current state (with seq)
 * 2. if the client says it already saw bids up to lastSeq, replay what it missed.
 *
 * Client rule: apply a live event only if event.seq > the seq it already has; a jump of more
 * than +1 means something was missed, so reconnect with ?lastSeq=<last seq seen>.
 */
async function sendInitialState(client: Client, lastSeq: number | undefined, log: Log) {
  const a = await getAuction(client.auctionId, log);
  if (!a) throw new Error('auction disappeared');
  const seq = Number(a.bid_count);

  hub.send(
    client,
    JSON.stringify({
      type: 'snapshot',
      auctionId: client.auctionId,
      currentPrice: Number(a.current_price),
      highestBidder: a.highest_bidder === null ? null : Number(a.highest_bidder),
      endsAt: a.ends_at,
      seq,
    }),
  );

  if (lastSeq === undefined || lastSeq >= seq) return;

  const gap = seq - lastSeq;
  if (gap > config.WS_CATCHUP_MAX) {
    // Too far behind to replay cheaply; the snapshot is the new baseline.
    hub.send(client, JSON.stringify({ type: 'catchup_skipped', missed: gap }));
    log.info({ event: 'ws.catchup', clientId: client.id, gap, replayed: 0, skipped: true }, 'catch-up skipped');
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, bidder_id, amount, seq, created_at FROM bids
     WHERE auction_id=$1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [client.auctionId, lastSeq, config.WS_CATCHUP_MAX],
  );
  for (const r of rows) {
    const ev: BidEvent = {
      type: 'bid',
      auctionId: client.auctionId,
      bidId: Number(r.id),
      bidderId: Number(r.bidder_id),
      amount: Number(r.amount),
      seq: Number(r.seq),
      at: new Date(r.created_at).toISOString(),
      replay: true,
    };
    hub.send(client, JSON.stringify(ev));
  }
  log.info({ event: 'ws.catchup', clientId: client.id, gap, replayed: rows.length }, 'catch-up replayed');
}

import { WebSocket } from 'ws';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { redis } from '../cache.js';

export interface BidEvent {
  type: 'bid';
  auctionId: number;
  bidId?: number; // absent until the bid has been saved to Postgres (write-behind)
  bidderId: number;
  amount: number;
  seq: number;
  at: string;
  replay?: boolean;
}

export interface Client {
  id: string;
  socket: WebSocket;
  ip: string;
  auctionId: number;
  alive: boolean;
  connectedAt: number;
}

const channelOf = (auctionId: number) => `auction:${auctionId}:events`;

/**
 * Hub = everything about live connections on THIS server instance.
 *
 *   rooms:  auctionId -> sockets watching it (only sockets connected to this instance)
 *   Redis:  one PUBLISH per accepted bid; every instance subscribed to that channel
 *           forwards the message to its own local sockets.
 */
class Hub {
  private rooms = new Map<number, Set<Client>>();
  private perIp = new Map<string, number>();
  private total = 0;
  private sub: Redis | null = null; // a subscribed Redis connection cannot run normal commands
  private heartbeat: NodeJS.Timeout | null = null;

  readonly counters = {
    connectionsTotal: 0,
    messagesSent: 0,
    published: 0,
    publishFailed: 0,
    received: 0,
    droppedSlowClients: 0,
    heartbeatTerminated: 0,
    rejected: 0,
  };

  start() {
    this.sub = new Redis(config.PUBSUB_URL); // ioredis re-subscribes automatically after a reconnect
    this.sub.on('error', (err) => logger.error({ event: 'pubsub.error', err: err.message }, 'pubsub error'));
    this.sub.on('message', (channel, message) => this.onMessage(channel, message));

    this.heartbeat = setInterval(() => this.checkHeartbeats(), config.WS_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Returns a rejection reason, or null if a new connection is allowed. */
  checkCapacity(ip: string): 'server_full' | 'ip_limit' | null {
    if (this.total >= config.WS_MAX_CONNECTIONS) return 'server_full';
    if ((this.perIp.get(ip) ?? 0) >= config.WS_MAX_CONNECTIONS_PER_IP) return 'ip_limit';
    return null;
  }

  add(client: Client) {
    let room = this.rooms.get(client.auctionId);
    if (!room) {
      room = new Set();
      this.rooms.set(client.auctionId, room);
      // First local viewer of this auction: start listening to its channel.
      this.sub?.subscribe(channelOf(client.auctionId)).catch((err) =>
        logger.error({ event: 'pubsub.error', op: 'subscribe', err: err.message }, 'subscribe failed'),
      );
    }
    room.add(client);
    this.perIp.set(client.ip, (this.perIp.get(client.ip) ?? 0) + 1);
    this.total++;
    this.counters.connectionsTotal++;
  }

  remove(client: Client) {
    const room = this.rooms.get(client.auctionId);
    if (!room?.delete(client)) return; // already removed
    if (room.size === 0) {
      this.rooms.delete(client.auctionId);
      // Last local viewer left: stop receiving traffic for this auction.
      this.sub?.unsubscribe(channelOf(client.auctionId)).catch(() => undefined);
    }
    const n = (this.perIp.get(client.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(client.ip);
    else this.perIp.set(client.ip, n);
    this.total--;
  }

  /** Send a string to one client, dropping it if it cannot keep up (backpressure). */
  send(client: Client, data: string) {
    const { socket } = client;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > config.WS_MAX_BUFFERED_BYTES) {
      // The client is not reading fast enough; buffering for it would grow our memory without bound.
      this.counters.droppedSlowClients++;
      logger.warn(
        { event: 'ws.dropped_slow_client', clientId: client.id, auctionId: client.auctionId, bufferedBytes: socket.bufferedAmount },
        'dropping slow websocket client',
      );
      socket.terminate();
      return;
    }
    socket.send(data);
    this.counters.messagesSent++;
  }

  /** Called after Postgres committed a bid. Never throws: the bid itself already succeeded. */
  async publishBid(event: BidEvent) {
    const payload = JSON.stringify(event); // serialized ONCE, reused for every viewer
    try {
      await redis.publish(channelOf(event.auctionId), payload);
      this.counters.published++;
      logger.debug({ event: 'pubsub.published', auctionId: event.auctionId, seq: event.seq }, 'bid published');
    } catch (err) {
      // Redis is down: at least deliver to viewers connected to this instance.
      this.counters.publishFailed++;
      logger.warn(
        { event: 'pubsub.publish_failed', auctionId: event.auctionId, err: (err as Error).message },
        'publish failed, delivering locally only',
      );
      this.fanOut(event.auctionId, payload);
    }
  }

  private onMessage(channel: string, message: string) {
    const auctionId = Number(channel.split(':')[1]);
    this.counters.received++;
    this.fanOut(auctionId, message);
  }

  private fanOut(auctionId: number, payload: string) {
    const room = this.rooms.get(auctionId);
    if (!room) return;
    for (const client of room) this.send(client, payload);
  }

  /** Detect dead connections (closed laptop, lost network) that never sent a close frame. */
  private checkHeartbeats() {
    for (const room of this.rooms.values()) {
      for (const client of room) {
        if (!client.alive) {
          this.counters.heartbeatTerminated++;
          logger.info({ event: 'ws.heartbeat_timeout', clientId: client.id, auctionId: client.auctionId }, 'no pong, terminating');
          client.socket.terminate();
          continue;
        }
        client.alive = false; // must be set back to true by a pong before the next round
        client.socket.ping();
      }
    }
  }

  snapshot() {
    let bufferedBytes = 0;
    const rooms: { auctionId: number; viewers: number }[] = [];
    for (const [auctionId, room] of this.rooms) {
      rooms.push({ auctionId, viewers: room.size });
      for (const c of room) bufferedBytes += c.socket.bufferedAmount;
    }
    rooms.sort((a, b) => b.viewers - a.viewers);
    return {
      activeSockets: this.total,
      auctionsWithViewers: this.rooms.size,
      topRooms: rooms.slice(0, 5),
      bufferedBytes,
      ...this.counters,
    };
  }

  async shutdown() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const room of this.rooms.values()) {
      for (const c of room) c.socket.close(1001, 'server shutting down'); // 1001 = going away
    }
    await this.sub?.quit().catch(() => undefined);
  }
}

export const hub = new Hub();

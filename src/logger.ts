import { pino } from 'pino';
import { config } from './config.js';

const development = config.NODE_ENV === 'development';

// JSON logs in production (machine readable, ideal for a future AI log-analysis assistant); pretty output in development.
// In production the destination is buffered: a log call copies the line into memory and a timer writes it out, instead of
// a synchronous write on the thread that serves requests. The price: up to ~1 s of logs can be lost if the process is
// killed hard (a clean shutdown flushes first, see flushLogs).
export const logger = development
  ? pino({
      level: config.LOG_LEVEL,
      base: { service: 'auction-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    })
  : pino(
      { level: config.LOG_LEVEL, base: { service: 'auction-api' }, timestamp: pino.stdTimeFunctions.isoTime },
      pino.destination({ dest: 1, sync: config.LOG_ASYNC === 'false', minLength: 4096, periodicFlush: 1000 }),
    );

/** Call before a clean exit so buffered lines are not lost. */
export function flushLogs() {
  try {
    logger.flush();
  } catch {
    // synchronous or pretty destination: nothing to flush
  }
}

/** True for roughly `rate` of calls. Used for routine, high-volume events (a successful bid, a bid that was too low). */
export const sampled = (rate: number = config.LOG_SAMPLE_RATE) => rate >= 1 || Math.random() < rate;

const lastLogged = new Map<string, { at: number; suppressed: number }>();
/**
 * Lets an error log at most once per `ms`, so a broken dependency cannot write thousands of identical lines per second.
 * Returns the number of calls skipped since the last logged one, or null if this call should not be logged.
 */
export function throttle(key: string, ms = 1000): number | null {
  const now = Date.now();
  const entry = lastLogged.get(key);
  if (entry && now - entry.at < ms) {
    entry.suppressed++;
    return null;
  }
  lastLogged.set(key, { at: now, suppressed: 0 });
  return entry?.suppressed ?? 0;
}

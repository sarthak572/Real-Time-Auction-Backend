export class AppError extends Error {
  statusCode: number;
  code: string;
  // True when this is a stored answer being repeated for a retried request (Idempotency-Key), not a fresh decision.
  replayed: boolean;

  constructor(statusCode: number, code: string, message: string, replayed = false) {
    // Most AppErrors are everyday answers ("bid too low", "auction ended"), not bugs. Capturing a stack trace for each
    // one is real CPU under load (a profile showed ~1.5% of a busy instance), and nothing ever reads these stacks.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super(message);
    Error.stackTraceLimit = limit;
    this.statusCode = statusCode;
    this.code = code;
    this.replayed = replayed;
  }
}

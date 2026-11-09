/**
 * Small HTTP layer shared by both API clients.
 * The transport is swappable so tests can plug in fake TikTok / ShipHero servers.
 */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** Thrown when we never got an answer (timeout, connection reset). The remote change MAY have happened. */
export class NetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}
/** Thrown when the remote API answered with an error. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | number | null,
    public readonly requestId: string | null,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}
/** Thrown when a response does not have the shape the official docs describe. Never guess — stop. */
export class SchemaMismatchError extends Error {
  constructor(message: string, public readonly raw: unknown) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

export const fetchTransport: Transport = async (req) => {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: await res.text() };
  } catch (e) {
    throw new NetworkError(`Network error calling ${new URL(req.url).host}: ${(e as Error).message}`, e);
  }
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry helper — ONLY for read-only calls. Mutations are never blindly retried;
 * they go through the reconciliation path in the engine instead.
 */
export async function retryRead<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number; sleepFn?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 500;
  const sl = opts.sleepFn ?? sleep;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const retryable = e instanceof NetworkError || (e instanceof ApiError && e.retryable);
      if (!retryable || i === attempts - 1) throw e;
      await sl(base * 2 ** i + Math.floor(Math.random() * base));
    }
  }
  throw last;
}

export function parseJson(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new SchemaMismatchError(`${what} did not return JSON`, body.slice(0, 500));
  }
}

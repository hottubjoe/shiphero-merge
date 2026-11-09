import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const SECRET_KEYS = /token|secret|password|sign|authorization|cipher/i;

/** Remove anything that looks like a credential before it is written to disk. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) && typeof v === 'string' ? `***${v.slice(-4)}` : redact(v, depth + 1);
  }
  return out;
}

export class Logger {
  private stream: fs.WriteStream | null = null;
  constructor(file?: string, private quiet = false) {
    if (file) {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      this.stream = fs.createWriteStream(file, { flags: 'a' });
    }
  }
  private write(level: Level, msg: string, data?: Record<string, unknown>) {
    const entry = { ts: new Date().toISOString(), level, msg, ...(data ? (redact(data) as object) : {}) };
    const line = JSON.stringify(entry);
    this.stream?.write(line + '\n');
    if (!this.quiet) (level === 'error' ? console.error : console.log)(line);
  }
  debug(m: string, d?: Record<string, unknown>) { if (process.env.LOG_DEBUG) this.write('debug', m, d); }
  info(m: string, d?: Record<string, unknown>) { this.write('info', m, d); }
  warn(m: string, d?: Record<string, unknown>) { this.write('warn', m, d); }
  error(m: string, d?: Record<string, unknown>) { this.write('error', m, d); }
}

export const silentLogger = new Logger(undefined, true);

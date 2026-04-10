/**
 * TLS side-channel — spawns the Go-based bogdanfinn/tls-client daemon
 * and exposes a `fetchWithTls()` primitive that performs HTTP requests
 * with a real Chrome TLS ClientHello, real H2 frame settings, and real
 * H2 frame order. Used to make gating requests that the browser can't
 * make through itself, then inject the resulting cookies into the
 * BlackTip browser session.
 *
 * This is the v0.3.0 answer to "an edge gates the very first request
 * before BlackTip's browser even has a session." Use it as follows:
 *
 *   const channel = await TlsSideChannel.spawn();
 *   const resp = await channel.fetch('https://protected.example.com/');
 *   await bt.setCookies(resp.cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })));
 *   await bt.navigate('https://protected.example.com/');
 *   // ... browser session now has the cookies the gating request earned
 *   await channel.close();
 *
 * The daemon binary lives in `native/tls-client/blacktip-tls` (Linux/macOS)
 * or `native/tls-client/blacktip-tls.exe` (Windows). Build it once with
 * `cd native/tls-client && go build -o blacktip-tls .` — Go is the only
 * build dependency, and you can grab it from https://go.dev/dl/.
 *
 * The daemon stays alive across many requests so we don't pay subprocess
 * startup cost per call. It uses a newline-delimited JSON wire protocol
 * with per-request IDs, so multiple `fetch()` calls can be in flight
 * concurrently without interleaving issues.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

// ── Types ──

export interface TlsRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Request body as a UTF-8 string OR raw Buffer. Buffer is required for
   *  binary uploads (multipart, octet-stream); string is fine for form
   *  bodies and JSON. Encoded as base64 on the wire. */
  body?: string | Buffer;
  timeoutMs?: number;
  /** Chrome / Firefox / Safari profile name; defaults to chrome_133. */
  profile?: string;
}

export interface TlsResponse {
  status: number;
  /** Headers from the upstream response. Multi-valued — Set-Cookie commonly
   *  has multiple entries. Header keys preserve the casing the upstream sent. */
  headers: Record<string, string[]>;
  /** Response body as a UTF-8 string. May be garbage for binary content;
   *  use `bodyBuffer` for that. Kept as the primary body field for callers
   *  that just want JSON / HTML. */
  body: string;
  /** Response body as raw bytes. Use this when the upstream returns binary
   *  data (images, fonts, video, anything non-UTF-8). The TLS rewriting
   *  route handler always uses this so subresources don't get mangled. */
  bodyBuffer: Buffer;
  finalUrl: string;
  durationMs: number;
  /** Cookies parsed from `Set-Cookie` headers, ready to inject via `bt.setCookies()`. */
  cookies: ParsedCookie[];
}

export interface ParsedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

interface DaemonResponse {
  id: string;
  ok: boolean;
  status?: number;
  headers?: Record<string, string[]>;
  body?: string;
  finalUrl?: string;
  durationMs: number;
  error?: string;
}

// ── Resolution of the daemon binary ──

/**
 * Resolves the path to the prebuilt blacktip-tls binary. Looks first
 * in `native/tls-client/` next to the package source, then falls back
 * to a process-env override (`BLACKTIP_TLS_BIN`) for users who want
 * to ship the binary somewhere else.
 */
function resolveBinaryPath(): string {
  const env = process.env.BLACKTIP_TLS_BIN;
  if (env && existsSync(env)) return env;

  // From src/tls-side-channel.ts (or its compiled equivalent in dist/)
  // → ../native/tls-client/blacktip-tls[.exe]
  const here = dirname(fileURLToPath(import.meta.url));
  const exe = process.platform === 'win32' ? 'blacktip-tls.exe' : 'blacktip-tls';
  const candidates = [
    join(here, '..', 'native', 'tls-client', exe),
    join(here, '..', '..', 'native', 'tls-client', exe), // when running from dist/
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `BlackTip TLS daemon binary not found. Build it with:\n` +
      `  cd native/tls-client && go build -o ${exe} .\n` +
      `Or set BLACKTIP_TLS_BIN to an absolute path.`,
  );
}

// ── Cookie parsing ──
//
// Set-Cookie parsing is gnarly: commas can appear inside `Expires`
// values ("Sun, 06 Nov 1994 08:49:37 GMT"), so a naive split-on-comma
// breaks. We split on the literal `\n` boundary that bogdanfinn/fhttp
// uses when joining multiple Set-Cookie headers... but the Go daemon
// returns headers as `string[]`, so each cookie is already its own
// array element and we don't need to split at all.

function parseCookie(setCookie: string, defaultDomain: string): ParsedCookie | null {
  // First chunk before `;` is `name=value`. Subsequent chunks are attributes.
  const parts = setCookie.split(';').map((p) => p.trim());
  const first = parts[0];
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  let domain = defaultDomain;
  let path = '/';
  let httpOnly = false;
  let secure = false;
  let sameSite: ParsedCookie['sameSite'];
  let expires: number | undefined;

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i]!;
    const ai = attr.indexOf('=');
    const key = (ai < 0 ? attr : attr.slice(0, ai)).trim().toLowerCase();
    const val = ai < 0 ? '' : attr.slice(ai + 1).trim();
    if (key === 'domain') domain = val.replace(/^\./, '');
    else if (key === 'path') path = val;
    else if (key === 'httponly') httpOnly = true;
    else if (key === 'secure') secure = true;
    else if (key === 'samesite') {
      const v = val.toLowerCase();
      if (v === 'strict') sameSite = 'Strict';
      else if (v === 'lax') sameSite = 'Lax';
      else if (v === 'none') sameSite = 'None';
    } else if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t / 1000;
    }
  }

  return { name, value, domain, path, httpOnly, secure, sameSite, expires };
}

// ── TlsSideChannel ──

interface PendingRequest {
  resolve: (r: TlsResponse) => void;
  reject: (e: Error) => void;
}

export class TlsSideChannel {
  private proc: ChildProcessWithoutNullStreams;
  private rl: ReadlineInterface;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private closed = false;

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
    this.rl = createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    proc.on('exit', (code) => {
      this.closed = true;
      const err = new Error(`TLS daemon exited with code ${code}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  /**
   * Spawn the daemon. Throws if the binary isn't built or can't start.
   * The daemon stays alive until you call `close()`.
   */
  static async spawn(): Promise<TlsSideChannel> {
    const bin = resolveBinaryPath();
    const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Forward daemon stderr to ours so we see crashes in dev.
    proc.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[blacktip-tls] ${chunk.toString()}`);
    });
    return new TlsSideChannel(proc);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: DaemonResponse;
    try {
      parsed = JSON.parse(line) as DaemonResponse;
    } catch {
      process.stderr.write(`[blacktip-tls] unparseable line: ${line}\n`);
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);

    if (!parsed.ok) {
      pending.reject(new Error(parsed.error ?? 'unknown daemon error'));
      return;
    }

    const finalUrl = parsed.finalUrl ?? '';
    const headers = parsed.headers ?? {};
    const bodyB64 = parsed.body ?? '';
    const bodyBuffer = Buffer.from(bodyB64, 'base64');
    const body = bodyBuffer.toString('utf-8');

    // Parse Set-Cookie headers. The header key may be `Set-Cookie`
    // or `set-cookie` depending on the daemon's Go HTTP version.
    const cookies: ParsedCookie[] = [];
    const cookieHeaders = headers['Set-Cookie'] ?? headers['set-cookie'] ?? [];
    let defaultDomain = '';
    try {
      defaultDomain = new URL(finalUrl).hostname;
    } catch { /* leave empty */ }
    for (const sc of cookieHeaders) {
      const c = parseCookie(sc, defaultDomain);
      if (c) cookies.push(c);
    }

    pending.resolve({
      status: parsed.status ?? 0,
      headers,
      body,
      bodyBuffer,
      finalUrl,
      durationMs: parsed.durationMs,
      cookies,
    });
  }

  /**
   * Perform a single TLS-impersonated request. Multiple `fetch()` calls
   * can be in flight concurrently — the daemon handles each in its own
   * goroutine and matches responses by id.
   */
  async fetch(req: TlsRequest): Promise<TlsResponse> {
    if (this.closed) throw new Error('TLS daemon is closed');
    const id = `r${this.nextId++}`;
    let bodyB64 = '';
    if (req.body != null) {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'utf-8');
      bodyB64 = buf.toString('base64');
    }
    const wire = {
      id,
      url: req.url,
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      body: bodyB64,
      timeoutMs: req.timeoutMs ?? 15000,
      profile: req.profile ?? 'chrome_133',
    };
    return new Promise<TlsResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify(wire) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Shut down the daemon and clean up the subprocess. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
    return new Promise<void>((resolve) => {
      this.proc.once('exit', () => resolve());
      this.proc.stdin.end();
      // Hard-kill if it doesn't exit gracefully within a second.
      setTimeout(() => {
        if (!this.proc.killed) this.proc.kill('SIGKILL');
        resolve();
      }, 1000).unref();
    });
  }
}

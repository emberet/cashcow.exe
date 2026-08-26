import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import type { Db } from "../util/db.ts";
import type { Config } from "../config/schema.ts";
import { KillSwitch } from "../risk/killswitch.ts";
import { publicSnapshot, adminSnapshot, refreshWallet } from "./queries.ts";
import {
  authState, login, logout, validateSession, readCookie, cookieHeader,
  clearCookieHeader, csrfToken, checkCsrf, auditAction, sessionCount, revokeAllSessions,
} from "./auth.ts";
import { enqueue, COMMAND_KINDS, type CommandKind } from "./commands.ts";
import { log, errFields } from "../util/log.ts";

/**
 * Dashboard server.
 *
 * Two audiences on one port, with a hard boundary between them:
 *   - `/`        public, read-only, no secrets, no pre-launch candidates
 *   - `/admin`   session-gated controls
 *
 * Real-time delivery is server-sent events rather than WebSockets: the traffic
 * is strictly one-way, SSE reconnects on its own, and it survives ordinary
 * reverse proxies without an upgrade dance. The server re-reads SQLite on an
 * interval and pushes only when the payload actually changed, so an idle bot
 * costs an idle socket rather than a stream of duplicate frames.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

type Client = { res: ServerResponse; admin: boolean; lastHash: string };

export type WebServer = { close: () => Promise<void>; url: string };

export function startWebServer(db: Db, cfg: Config, kill: KillSwitch): Promise<WebServer> {
  const clients = new Set<Client>();
  const secureCookies = cfg.web.behindTlsProxy;

  const server = createServer((req, res) => {
    handle(req, res, db, cfg, kill, clients, secureCookies).catch((e) => {
      log.error("web request failed", { url: req.url, ...errFields(e) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  // Push loop: read state, diff, send only on change.
  const timer = setInterval(() => {
    if (!clients.size) return;
    // Fire and forget: keeps the cached balance warm without making the push
    // loop async. Its own TTL stops this hammering the RPC.
    void refreshWallet(db, cfg).catch(() => {});
    try {
      const pub = JSON.stringify(publicSnapshot(db, cfg, kill));
      const pubHash = hash(pub);
      let adm: string | undefined;
      let admHash = "";

      for (const client of clients) {
        if (client.admin) {
          if (adm === undefined) {
            adm = JSON.stringify(adminSnapshot(db, cfg, kill));
            admHash = hash(adm);
          }
          if (client.lastHash !== admHash) {
            client.lastHash = admHash;
            writeEvent(client.res, "snapshot", adm);
          }
        } else if (client.lastHash !== pubHash) {
          client.lastHash = pubHash;
          writeEvent(client.res, "snapshot", pub);
        }
      }
    } catch (e) {
      log.warn("push loop error", errFields(e));
    }
  }, cfg.web.pushIntervalSeconds * 1000);

  // Keep-alive comments stop proxies reaping idle event streams.
  const ping = setInterval(() => {
    for (const c of clients) c.res.write(": ping\n\n");
  }, 25_000);

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(cfg.web.port, cfg.web.host, () => {
      const url = `http://${cfg.web.host}:${cfg.web.port}`;
      const auth = authState();

      log.info("dashboard listening", {
        url,
        public: cfg.web.publicEnabled ? `${url}/` : "disabled",
        admin: auth.configured ? `${url}/admin` : "DISABLED (no password configured)",
      });
      if (!auth.configured) log.warn("admin portal disabled", { reason: auth.reason });
      if (cfg.web.host !== "127.0.0.1" && cfg.web.host !== "localhost") {
        log.warn("dashboard is bound to a non-loopback address", {
          host: cfg.web.host,
          note: "the admin portal is reachable from the network; put TLS in front of it",
        });
      }

      resolvePromise({
        url,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(timer);
            clearInterval(ping);
            for (const c of clients) c.res.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage, res: ServerResponse, db: Db, cfg: Config,
  kill: KillSwitch, clients: Set<Client>, secureCookies: boolean,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  // Throttling keys on the unspoofable socket address; the audit log records
  // the friendlier one, which may include a proxy-supplied hop.
  const throttleKey = socketIp(req);
  const ip = displayIp(req, cfg);

  securityHeaders(res);

  const token = readCookie(req.headers.cookie);
  const isAdmin = validateSession(db, token);

  // ------------------------------------------------------------------ auth
  if (path === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const password = typeof body.password === "string" ? body.password : "";
    const result = login(db, password, throttleKey, ip);

    if (!result.ok) {
      auditAction(db, "login_failed", result.reason, ip);
      return sendJson(res, 401, { error: result.reason, retryAfterMs: result.retryAfterMs });
    }
    auditAction(db, "login", "admin session started", ip);
    res.setHeader("set-cookie", cookieHeader(result.token, secureCookies, result.expiresAt - Date.now()));
    return sendJson(res, 200, { ok: true, csrf: csrfToken(result.token) });
  }

  if (path === "/api/logout" && req.method === "POST") {
    logout(db, token);
    res.setHeader("set-cookie", clearCookieHeader(secureCookies));
    return sendJson(res, 200, { ok: true });
  }

  if (path === "/api/session") {
    const auth = authState();
    return sendJson(res, 200, {
      configured: auth.configured,
      reason: auth.configured ? null : auth.reason,
      authenticated: isAdmin,
      csrf: isAdmin && token ? csrfToken(token) : null,
    });
  }

  // ---------------------------------------------------------------- public
  if (path === "/api/public") {
    if (!cfg.web.publicEnabled) return sendJson(res, 404, { error: "public dashboard disabled" });
    if (cfg.web.showWallet) await refreshWallet(db, cfg).catch(() => {});
    return sendJson(res, 200, publicSnapshot(db, cfg, kill));
  }

  if (path === "/api/stream") {
    if (!cfg.web.publicEnabled) return sendJson(res, 404, { error: "public dashboard disabled" });
    return openStream(req, res, clients, false, () => JSON.stringify(publicSnapshot(db, cfg, kill)));
  }

  // ----------------------------------------------------------------- admin
  if (path.startsWith("/api/admin")) {
    const auth = authState();
    if (!auth.configured) return sendJson(res, 503, { error: auth.reason });
    if (!isAdmin) return sendJson(res, 401, { error: "not authenticated" });

    if (path === "/api/admin/snapshot") {
      await refreshWallet(db, cfg).catch(() => {});
      return sendJson(res, 200, adminSnapshot(db, cfg, kill, await walletBalance(db, cfg)));
    }

    if (path === "/api/admin/stream") {
      return openStream(req, res, clients, true, () => JSON.stringify(adminSnapshot(db, cfg, kill)));
      // Balance is fetched on the request path only; the push loop stays
      // synchronous so a slow RPC cannot stall every connected client.
    }

    // Everything past here mutates, so it needs the CSRF token.
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

    const body = await readBody(req);
    if (!checkCsrf(token, typeof body.csrf === "string" ? body.csrf : undefined)) {
      auditAction(db, "csrf_rejected", path, ip);
      return sendJson(res, 403, { error: "bad or missing CSRF token" });
    }

    switch (path) {
      case "/api/admin/halt": {
        const reason = typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 200)
          : "halted from admin portal";
        kill.halt(reason);
        auditAction(db, "halt", reason, ip);
        return sendJson(res, 200, { ok: true, halted: true });
      }

      case "/api/admin/resume": {
        kill.resume();
        auditAction(db, "resume", "resumed from admin portal", ip);
        return sendJson(res, 200, { ok: true, halted: false });
      }

      case "/api/admin/command": {
        const kind = String(body.kind ?? "");
        if (!COMMAND_KINDS.includes(kind as CommandKind)) {
          return sendJson(res, 400, { error: `unknown command: ${kind}` });
        }
        const payload = (body.payload ?? {}) as Record<string, unknown>;
        const id = enqueue(db, kind as CommandKind, payload, ip);
        auditAction(db, `command:${kind}`, JSON.stringify(payload), ip);
        return sendJson(res, 200, {
          ok: true, id,
          note: "Queued. The bot executes it on its next tick — the web process never signs.",
        });
      }

      case "/api/admin/revoke-sessions": {
        const n = revokeAllSessions(db);
        auditAction(db, "revoke_sessions", `revoked ${n}`, ip);
        res.setHeader("set-cookie", clearCookieHeader(secureCookies));
        return sendJson(res, 200, { ok: true, revoked: n });
      }

      default:
        return sendJson(res, 404, { error: "unknown admin endpoint" });
    }
  }

  if (path === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      adminConfigured: authState().configured,
      sessions: sessionCount(db),
      publicEnabled: cfg.web.publicEnabled,
    });
  }

  // ----------------------------------------------------------------- static
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method not allowed" });
  }

  let file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  if (file === "admin" || file === "admin/") file = "admin.html";
  if (!extname(file)) file += ".html";

  if (file === "index.html" && !cfg.web.publicEnabled) {
    return redirect(res, "/admin");
  }

  return serveStatic(res, file);
}

// -------------------------------------------------------------------- SSE

function openStream(
  req: IncomingMessage, res: ServerResponse, clients: Set<Client>,
  admin: boolean, initial: () => string,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Disables buffering in nginx, which would otherwise hold events back.
    "x-accel-buffering": "no",
  });

  const payload = initial();
  const client: Client = { res, admin, lastHash: hash(payload) };
  clients.add(client);
  writeEvent(res, "snapshot", payload);

  const drop = () => { clients.delete(client); };
  req.on("close", drop);
  req.on("error", drop);
}

function writeEvent(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

// ---------------------------------------------------------------- helpers

function securityHeaders(res: ServerResponse): void {
  // Everything is same-origin and self-contained: no CDN, no remote fonts.
  //
  // `script-src` stays strict -- that is where the real risk lives, and there
  // are no inline scripts or event handlers anywhere in this app.
  //
  // `style-src` allows 'unsafe-inline' because the dashboard sets genuinely
  // data-driven values (bar widths, avatar gradients) and Chrome counts CSSOM
  // writes to element.style as inline styles, so no amount of moving them into
  // JS avoids it. The residual risk is negligible here: every interpolated
  // value is HTML-escaped, and the classic CSS-exfiltration path is already
  // closed by `img-src 'self' data:` and `connect-src 'self'`, which stop a
  // stylesheet reaching any external host.
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("permissions-policy", "geolocation=(), microphone=(), camera=()");
}

async function serveStatic(res: ServerResponse, file: string): Promise<void> {
  // Resolve inside PUBLIC_DIR and verify containment, so "../" cannot escape.
  const target = resolve(join(PUBLIC_DIR, normalize(file)));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + "/")) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) return sendJson(res, 404, { error: "not found" });

    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { location: to });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Nothing legitimate posted here is large; cap it rather than buffer freely.
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The address the connection actually came from. Cannot be forged by a client,
 * because it is the socket peer rather than anything the client sent.
 *
 * **Everything security-relevant must key on this**, not on the display address
 * below.
 */
function socketIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * The address to *show* a human, which may come from a proxy header.
 *
 * `X-Forwarded-For` is attacker-supplied. Trusting it for rate limiting let a
 * client rotate the header and get unlimited password guesses -- measured at
 * 30/30 attempts allowed where a fixed address locked out after 8. It is now
 * display-only, and only when the operator says a proxy is actually in front.
 */
function displayIp(req: IncomingMessage, cfg: Config): string {
  if (cfg.web.trustProxyHeader) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd) {
      return `${fwd.split(",")[0]!.trim().slice(0, 45)} (via proxy)`;
    }
  }
  return socketIp(req);
}

/**
 * Best-effort wallet balance for capacity display. Never throws: an RPC hiccup
 * must degrade the number shown, not break the dashboard, and capacity falls
 * back to the static cap when the balance is unknown.
 */
async function walletBalance(db: Db, cfg: Config): Promise<number | undefined> {
  if (cfg.dryRun) return undefined;
  try {
    const { getBalanceSol } = await import("../chain/rpc.ts");
    const { publishedWalletAddress } = await import("../chain/wallet.ts");
    const { PublicKey } = await import("@solana/web3.js");
    // Invariant 4: read the address the bot published, never resolve it from
    // the secret here. An address is public information; the keypair it came
    // from is not, and the secret-loading path caches that keypair inside
    // whatever process calls it -- which would be this one.
    const address = publishedWalletAddress(db);
    if (!address) return undefined;
    return await getBalanceSol(cfg, new PublicKey(address));
  } catch {
    return undefined;
  }
}

function hash(s: string): string {
  return createHash("sha1").update(s).digest("base64");
}

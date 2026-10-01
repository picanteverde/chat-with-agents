import { join } from 'node:path';
import { bearerToken, requireAdminToken, timingSafeEqual, tokenFromAuthMessage } from './auth';
import { Chat, HttpError } from './chat';
import { Store } from './db';
import { MAX_WAIT_SECONDS, type Event, type Participant } from './types';

const ADMIN_TOKEN = requireAdminToken(process.env.CWA_ADMIN_TOKEN);
const HOST = process.env.CWA_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CWA_PORT ?? 7071);
const DB_PATH = process.env.CWA_DB ?? 'chat.sqlite';
const ROOT = process.env.CWA_ROOT ?? process.cwd();
const AUTH_TIMEOUT_MS = 5000;

if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.warn(`[server] binding to ${HOST}: put TLS (wss://) in front; tokens and messages travel in clear otherwise.`);
}

const chat = new Chat(new Store(DB_PATH));

/** The admin token is a virtual participant that can bootstrap others and read agent DMs. */
const ADMIN: Participant = { id: 0, name: 'admin', kind: 'human', admin: true, createdAt: '' };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const error = (status: number, message: string) => json({ error: message }, status);

function authenticate(req: Request): Participant | null {
  const token = bearerToken(req);
  if (!token) return null;
  if (timingSafeEqual(token, ADMIN_TOKEN)) return ADMIN;
  return chat.authenticate(token);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = (await req.json()) as unknown;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new Error();
    return b as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body must be a JSON object');
  }
}

const int = (v: string | null): number | undefined => (v !== null && /^\d+$/.test(v) ? Number(v) : undefined);

type WsData = { participant: Participant | null; unsubscribe: (() => void) | null; timer: ReturnType<typeof setTimeout> | null };

async function api(req: Request, url: URL, server: ReturnType<typeof Bun.serve>): Promise<Response | undefined> {
  const path = url.pathname;
  const parts = path.split('/').filter(Boolean);
  const method = req.method;

  if (path === '/api/health') return json({ ok: true });

  // WebSocket: authenticates with its first frame, so no header check here.
  if (path === '/api/ws') {
    const ok = server.upgrade(req, { data: { participant: null, unsubscribe: null, timer: null } satisfies WsData });
    return ok ? undefined : error(426, 'websocket upgrade required');
  }

  const me = authenticate(req);
  if (!me) return error(401, 'unauthorized');

  // ── admin: participants ──
  if (parts[1] === 'participants') {
    if (method === 'GET' && parts.length === 2) return json({ participants: chat.participants(), me: me.name });
    if (!me.admin) return error(403, 'admin only');
    if (method === 'POST' && parts.length === 2) {
      const b = await body(req);
      const { participant, token } = chat.createParticipant(b.name, b.kind, b.admin === true);
      return json({ participant, token }, 201); // token is shown once
    }
    if (method === 'DELETE' && parts.length === 3) {
      chat.removeParticipant(parts[2]);
      return new Response(null, { status: 204 });
    }
    return undefined;
  }

  // ── channels ──
  if (parts[1] === 'channels') {
    if (method === 'GET' && parts.length === 2) return json({ channels: chat.channels() });
    if (method === 'POST' && parts.length === 2) return json({ channel: chat.createChannel((await body(req)).name, me) }, 201);
    if (method === 'GET' && parts.length === 4 && parts[3] === 'messages') {
      return json({ messages: chat.history(me, { channel: parts[2] }, int(url.searchParams.get('before')), int(url.searchParams.get('limit'))) });
    }
    return undefined;
  }

  // ── direct messages ──
  if (parts[1] === 'dm' && parts.length === 3 && method === 'GET') {
    return json({ messages: chat.history(me, { with: parts[2] }, int(url.searchParams.get('before')), int(url.searchParams.get('limit'))) });
  }
  if (parts[1] === 'dm' && parts.length === 4 && method === 'GET') {
    // admin oversight of agent↔agent threads: /api/dm/:a/:b
    return json({ messages: chat.dmBetween(me, parts[2], parts[3], int(url.searchParams.get('before')), int(url.searchParams.get('limit'))) });
  }

  // ── messages ──
  if (path === '/api/messages' && method === 'POST') {
    if (me.admin && me.id === 0) return error(403, 'the admin token cannot post; create a participant');
    const b = await body(req);
    return json({ message: chat.send(me, { channel: b.channel, to: b.to }, b.body) }, 201);
  }

  // ── events (pull) ──
  if (path === '/api/events' && method === 'GET') {
    if (me.id === 0) return error(403, 'the admin token has no event stream; create a participant');
    const wait = Math.min(int(url.searchParams.get('wait')) ?? 0, MAX_WAIT_SECONDS);
    const result = await chat.poll(me, int(url.searchParams.get('after')), wait, int(url.searchParams.get('limit')));
    return json(result);
  }
  if (path === '/api/events/ack' && method === 'POST') {
    if (me.id === 0) return error(403, 'admin token has no cursor');
    chat.ack(me, (await body(req)).cursor as number);
    return json({ ok: true });
  }

  // ── notifications ──
  if (path === '/api/notifications' && method === 'GET') {
    if (me.id === 0) return json({ notifications: [] });
    return json({ notifications: chat.unread(me) });
  }
  if (path === '/api/notifications/ack' && method === 'POST') {
    if (me.id === 0) return json({ acked: 0 });
    return json({ acked: chat.ackNotifications(me, (await body(req)).ids) });
  }

  if (path === '/api/presence' && method === 'GET') return json({ online: chat.online() });

  return undefined;
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return (await api(req, url, server)) ?? error(404, 'not found');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(Bun.file(join(ROOT, 'public', 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return error(404, 'not found');
    } catch (err) {
      if (err instanceof HttpError) return error(err.status, err.message);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[server] ${req.method} ${url.pathname}: ${message}`);
      return error(500, 'internal error');
    }
  },
  websocket: {
    maxPayloadLength: 64 * 1024,
    open(ws) {
      ws.data.timer = setTimeout(() => {
        if (!ws.data.participant) ws.close(4401, 'auth timeout');
      }, AUTH_TIMEOUT_MS);
    },
    message(ws, raw) {
      const d = ws.data;
      if (!d.participant) {
        const token = tokenFromAuthMessage(raw);
        const p = token ? (timingSafeEqual(token, ADMIN_TOKEN) ? ADMIN : chat.authenticate(token)) : null;
        if (!p) {
          ws.close(4401, 'unauthorized');
          return;
        }
        if (d.timer) clearTimeout(d.timer);
        d.participant = p;
        const send = (event: Event) => {
          if (event.type === 'revoked') {
            ws.close(4401, 'participant removed');
            return;
          }
          ws.send(JSON.stringify(event));
        };
        if (p.id !== 0) d.unsubscribe = chat.subscribe(p.name, send);
        ws.send(JSON.stringify({ type: 'ready', me: p.name, online: chat.online() }));
        // Re-deliver unread notifications (at-least-once); the client acks them.
        if (p.id !== 0) for (const { notification, message } of chat.unread(p)) if (message) send({ type: 'notification', notification, message });
        return;
      }
      // Authenticated frames: {type:"send", channel|to, body} or {type:"ack", ids:[…]}
      if (!chat.isActive(d.participant)) {
        ws.close(4401, 'participant removed');
        return;
      }
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as Record<string, unknown>;
        if (m.type === 'send') {
          if (d.participant.id === 0) throw new HttpError(403, 'the admin token cannot post');
          const message = chat.send(d.participant, { channel: m.channel, to: m.to }, m.body);
          ws.send(JSON.stringify({ type: 'sent', id: m.id ?? null, message })); // acknowledged send
        } else if (m.type === 'ack') {
          ws.send(JSON.stringify({ type: 'acked', count: d.participant.id === 0 ? 0 : chat.ackNotifications(d.participant, m.ids) }));
        } else if (m.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        } else {
          throw new HttpError(400, 'unknown message type');
        }
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400;
        ws.send(JSON.stringify({ type: 'error', status, message: err instanceof Error ? err.message : 'bad message' }));
      }
    },
    close(ws) {
      if (ws.data.timer) clearTimeout(ws.data.timer);
      ws.data.unsubscribe?.();
    },
  },
});

console.log(`[server] chat-with-agents listening on http://${server.hostname}:${server.port} (db: ${DB_PATH})`);

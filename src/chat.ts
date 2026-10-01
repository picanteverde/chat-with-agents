import { hashToken, newToken } from './auth';
import { dmPair, Store } from './db';
import { MAX_BODY, MAX_WAIT_SECONDS, NAME, PAGE_SIZE, type Event, type Kind, type Message, type Participant } from './types';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MENTION = /(?:^|[^a-z0-9_-])@([a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?)/g;

export function extractMentions(body: string, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION)) if (known.has(m[1])) out.add(m[1]);
  return [...out];
}

export function assertName(name: unknown, what = 'name'): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new HttpError(400, `${what} must be a slug: a-z, 0-9, dashes or underscores, 1-32 chars`);
  return name;
}

type Listener = (event: Event) => void;

/**
 * Everything the server does, independent of HTTP: participants, channels,
 * messages, notifications, presence, and the two delivery paths —
 * push (listeners, used by WebSockets) and pull (events after a cursor, used
 * by agents that long-poll).
 */
export class Chat {
  private listeners = new Map<string, Set<Listener>>(); // name → live sockets
  private waiters = new Set<() => void>(); // long-poll wakeups

  constructor(readonly store: Store) {}

  /* ───────── participants ───────── */

  createParticipant(name: unknown, kind: unknown, admin = false): { participant: Participant; token: string } {
    const n = assertName(name);
    if (kind !== 'human' && kind !== 'agent') throw new HttpError(400, 'kind must be "human" or "agent"');
    if (this.store.participantByName(n)) throw new HttpError(409, `participant ${n} already exists`);
    if (this.store.nameRetired(n)) throw new HttpError(409, `${n} belonged to a removed participant; names are not reused`);
    const token = newToken();
    const participant = this.store.createParticipant(n, kind as Kind, hashToken(token), admin);
    return { participant, token };
  }

  authenticate(token: string): Participant | null {
    return this.store.participantByToken(hashToken(token));
  }

  participants(): Participant[] {
    return this.store.listParticipants();
  }

  /** Revoke a participant: token invalid at once, live sockets told to close, name retired. */
  removeParticipant(name: string): void {
    if (!this.store.revokeParticipant(assertName(name))) throw new HttpError(404, 'participant not found');
    this.push(name, { type: 'revoked' });
    this.listeners.delete(name);
    this.broadcastPresence();
  }

  /** True while the participant's token is still valid (used to re-check long-lived sockets). */
  isActive(p: Participant): boolean {
    return p.id === 0 || this.store.participantByName(p.name)?.id === p.id;
  }

  /* ───────── channels ───────── */

  channels() {
    return this.store.listChannels();
  }

  createChannel(name: unknown, by: Participant) {
    const n = assertName(name, 'channel');
    if (this.store.channelExists(n)) throw new HttpError(409, `channel ${n} already exists`);
    return this.store.createChannel(n, by.name);
  }

  /* ───────── messages ───────── */

  send(from: Participant, target: { channel?: unknown; to?: unknown }, body: unknown): Message {
    if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, 'body is required');
    if (body.length > MAX_BODY) throw new HttpError(413, `body exceeds ${MAX_BODY} characters`);
    const known = new Set(this.store.listParticipants().map((p) => p.name));
    const mentions = extractMentions(body, known).filter((m) => m !== from.name);

    let message: Message;
    const recipients: string[] = [];
    if (target.channel !== undefined) {
      const channel = assertName(target.channel, 'channel');
      if (!this.store.channelExists(channel)) throw new HttpError(404, 'channel not found');
      message = this.store.insertMessage({ channel, dm: null, from: from.name, body, mentions });
      for (const m of mentions) recipients.push(m);
    } else if (target.to !== undefined) {
      const to = assertName(target.to, 'to');
      if (to === from.name) throw new HttpError(400, 'cannot DM yourself');
      if (!known.has(to)) throw new HttpError(404, 'participant not found');
      message = this.store.insertMessage({ channel: null, dm: dmPair(from.name, to), from: from.name, body, mentions: [] });
      recipients.push(to);
    } else {
      throw new HttpError(400, 'specify "channel" or "to"');
    }

    // Deliver: push to sockets, create notifications, wake long-pollers.
    const seen = new Set<string>();
    for (const name of recipients) {
      if (seen.has(name)) continue;
      seen.add(name);
      const notification = this.store.insertNotification(name, message.channel ? 'mention' : 'dm', message.id);
      this.push(name, { type: 'notification', notification, message });
    }
    const audience = message.channel ? [...this.listeners.keys()] : [message.dm![0], message.dm![1]];
    for (const name of audience) this.push(name, { type: 'message', message });
    this.wake();
    return message;
  }

  history(viewer: Participant, target: { channel?: string; with?: string }, before?: number, limit = PAGE_SIZE): Message[] {
    const n = Math.min(Math.max(1, limit), 200);
    if (target.channel) {
      const channel = assertName(target.channel, 'channel');
      if (!this.store.channelExists(channel)) throw new HttpError(404, 'channel not found');
      return this.store.channelHistory(channel, n, before);
    }
    if (target.with) {
      const other = assertName(target.with, 'with');
      return this.store.dmHistory(dmPair(viewer.name, other), n, before);
    }
    throw new HttpError(400, 'specify "channel" or "with"');
  }

  /** Admin oversight: read any DM thread between two agents (not human DMs). */
  dmBetween(viewer: Participant, a: string, b: string, before?: number, limit = PAGE_SIZE): Message[] {
    if (!viewer.admin) throw new HttpError(403, 'admin only');
    const pa = this.store.participantByName(assertName(a));
    const pb = this.store.participantByName(assertName(b));
    if (!pa || !pb) throw new HttpError(404, 'participant not found');
    if (pa.kind !== 'agent' || pb.kind !== 'agent') throw new HttpError(403, 'oversight covers agent-to-agent DMs only');
    return this.store.dmHistory(dmPair(a, b), Math.min(Math.max(1, limit), 200), before);
  }

  /* ───────── pull delivery (agents) ───────── */

  /**
   * Events after `after` (or the participant's stored cursor). Blocks up to
   * `waitSeconds` when nothing is waiting. Returns the new cursor; the client
   * acknowledges with `ack(cursor)` so a crash between poll and processing
   * re-delivers rather than loses events.
   */
  async poll(p: Participant, after: number | undefined, waitSeconds: number, limit = 100): Promise<{ events: Event[]; cursor: number }> {
    const start = after ?? this.store.getCursor(p.name);
    const deadline = Date.now() + Math.min(Math.max(0, waitSeconds), MAX_WAIT_SECONDS) * 1000;
    for (;;) {
      const batch = this.collect(p, start, limit);
      if (batch.events.length || Date.now() >= deadline) return batch;
      await this.waitForWake(deadline - Date.now());
    }
  }

  private collect(p: Participant, after: number, limit: number): { events: Event[]; cursor: number } {
    const messages = this.store.messagesAfter(p.name, after, limit);
    const unread = this.store.unreadNotifications(p.name).filter((n) => n.messageId > after);
    const events: Event[] = [];
    for (const m of messages) {
      const n = unread.find((u) => u.messageId === m.id);
      events.push(n ? { type: 'notification', notification: n, message: m } : { type: 'message', message: m });
    }
    const cursor = messages.length ? messages[messages.length - 1].id : after;
    return { events, cursor };
  }

  ack(p: Participant, cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0) throw new HttpError(400, 'cursor must be a non-negative integer');
    this.store.setCursor(p.name, cursor);
    // Acking the cursor also acks notifications up to it.
    const ids = this.store.unreadNotifications(p.name).filter((n) => n.messageId <= cursor).map((n) => n.id);
    this.store.ackNotifications(p.name, ids);
  }

  unread(p: Participant) {
    return this.store.unreadNotifications(p.name).map((n) => ({ notification: n, message: this.store.getMessage(n.messageId) }));
  }

  ackNotifications(p: Participant, ids: unknown): number {
    if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i))) throw new HttpError(400, 'ids must be an array of integers');
    return this.store.ackNotifications(p.name, ids as number[]);
  }

  /* ───────── push delivery (sockets) & presence ───────── */

  subscribe(name: string, listener: Listener): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    const wasOffline = set.size === 0;
    set.add(listener);
    if (wasOffline) this.broadcastPresence();
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(name);
        this.broadcastPresence();
      }
    };
  }

  online(): string[] {
    return [...this.listeners.keys()].sort();
  }

  private push(name: string, event: Event): void {
    for (const l of this.listeners.get(name) ?? []) {
      try {
        l(event);
      } catch {
        /* a dead socket must not break delivery to others */
      }
    }
  }

  private broadcastPresence(): void {
    const event: Event = { type: 'presence', online: this.online() };
    for (const name of this.listeners.keys()) this.push(name, event);
  }

  private wake(): void {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  private waitForWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
    });
  }
}

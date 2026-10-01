import { Database } from 'bun:sqlite';
import type { Channel, Kind, Message, Notification, Participant } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
  admin INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT,
  dm_a TEXT,
  dm_b TEXT,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  CHECK ((channel IS NOT NULL AND dm_a IS NULL AND dm_b IS NULL) OR (channel IS NULL AND dm_a IS NOT NULL AND dm_b IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel, id);
CREATE INDEX IF NOT EXISTS messages_dm ON messages(dm_a, dm_b, id);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mention','dm')),
  message_id INTEGER NOT NULL REFERENCES messages(id),
  created_at TEXT NOT NULL,
  acked_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(recipient, acked_at);
INSERT OR IGNORE INTO channels (name, created_by, created_at) VALUES ('general', 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

type ParticipantRow = { id: number; name: string; kind: Kind; admin: number; cursor: number; created_at: string };
type ChannelRow = { id: number; name: string; created_by: string; created_at: string };
type MessageRow = { id: number; channel: string | null; dm_a: string | null; dm_b: string | null; sender: string; body: string; mentions: string; created_at: string };
type NotificationRow = { id: number; recipient: string; kind: 'mention' | 'dm'; message_id: number; created_at: string; acked_at: string | null };

const now = () => new Date().toISOString();

export function dmPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function toParticipant(r: ParticipantRow): Participant {
  return { id: r.id, name: r.name, kind: r.kind, admin: r.admin === 1, createdAt: r.created_at };
}
function toChannel(r: ChannelRow): Channel {
  return { id: r.id, name: r.name, createdBy: r.created_by, createdAt: r.created_at };
}
function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    channel: r.channel,
    dm: r.dm_a && r.dm_b ? [r.dm_a, r.dm_b] : null,
    from: r.sender,
    body: r.body,
    mentions: JSON.parse(r.mentions) as string[],
    createdAt: r.created_at,
  };
}
function toNotification(r: NotificationRow): Notification {
  return { id: r.id, to: r.recipient, kind: r.kind, messageId: r.message_id, createdAt: r.created_at, ackedAt: r.acked_at };
}

export class Store {
  readonly db: Database;

  constructor(path = ':memory:') {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  /* participants */
  createParticipant(name: string, kind: Kind, tokenHash: string, admin = false): Participant {
    const row = this.db
      .query<ParticipantRow, [string, string, number, string, string]>(
        'INSERT INTO participants (name, kind, admin, token_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id, name, kind, admin, cursor, created_at',
      )
      .get(name, kind, admin ? 1 : 0, tokenHash, now())!;
    return toParticipant(row);
  }
  participantByToken(tokenHash: string): Participant | null {
    const r = this.db.query<ParticipantRow, [string]>('SELECT id, name, kind, admin, cursor, created_at FROM participants WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash);
    return r ? toParticipant(r) : null;
  }
  participantByName(name: string): Participant | null {
    const r = this.db.query<ParticipantRow, [string]>('SELECT id, name, kind, admin, cursor, created_at FROM participants WHERE name = ? AND revoked_at IS NULL').get(name);
    return r ? toParticipant(r) : null;
  }
  listParticipants(): Participant[] {
    return this.db.query<ParticipantRow, []>('SELECT id, name, kind, admin, cursor, created_at FROM participants WHERE revoked_at IS NULL ORDER BY name').all().map(toParticipant);
  }
  /** Revoke: the token stops working and the name is retired forever (history stays attributable). */
  revokeParticipant(name: string): boolean {
    return this.db
      .query<unknown, [string, string, string]>("UPDATE participants SET revoked_at = ?, token_hash = 'revoked:' || id || ':' || ? WHERE name = ? AND revoked_at IS NULL")
      .run(now(), crypto.randomUUID(), name).changes > 0;
  }
  nameRetired(name: string): boolean {
    return !!this.db.query<{ id: number }, [string]>('SELECT id FROM participants WHERE name = ? AND revoked_at IS NOT NULL').get(name);
  }
  getCursor(name: string): number {
    return this.db.query<{ cursor: number }, [string]>('SELECT cursor FROM participants WHERE name = ?').get(name)?.cursor ?? 0;
  }
  setCursor(name: string, cursor: number): void {
    this.db.query('UPDATE participants SET cursor = MAX(cursor, ?) WHERE name = ?').run(cursor, name);
  }

  /* channels */
  createChannel(name: string, createdBy: string): Channel {
    const row = this.db
      .query<ChannelRow, [string, string, string]>('INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?) RETURNING *')
      .get(name, createdBy, now())!;
    return toChannel(row);
  }
  listChannels(): Channel[] {
    return this.db.query<ChannelRow, []>('SELECT * FROM channels ORDER BY id').all().map(toChannel);
  }
  channelExists(name: string): boolean {
    return !!this.db.query<{ id: number }, [string]>('SELECT id FROM channels WHERE name = ?').get(name);
  }

  /* messages */
  insertMessage(m: { channel: string | null; dm: [string, string] | null; from: string; body: string; mentions: string[] }): Message {
    const row = this.db
      .query<MessageRow, [string | null, string | null, string | null, string, string, string, string]>(
        'INSERT INTO messages (channel, dm_a, dm_b, sender, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
      )
      .get(m.channel, m.dm?.[0] ?? null, m.dm?.[1] ?? null, m.from, m.body, JSON.stringify(m.mentions), now())!;
    return toMessage(row);
  }
  getMessage(id: number): Message | null {
    const r = this.db.query<MessageRow, [number]>('SELECT * FROM messages WHERE id = ?').get(id);
    return r ? toMessage(r) : null;
  }
  /** Newest page of a channel, oldest-first; `before` pages back. */
  channelHistory(channel: string, limit: number, before?: number): Message[] {
    const rows = before
      ? this.db.query<MessageRow, [string, number, number]>('SELECT * FROM messages WHERE channel = ? AND id < ? ORDER BY id DESC LIMIT ?').all(channel, before, limit)
      : this.db.query<MessageRow, [string, number]>('SELECT * FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?').all(channel, limit);
    return rows.reverse().map(toMessage);
  }
  dmHistory(pair: [string, string], limit: number, before?: number): Message[] {
    const rows = before
      ? this.db.query<MessageRow, [string, string, number, number]>('SELECT * FROM messages WHERE dm_a = ? AND dm_b = ? AND id < ? ORDER BY id DESC LIMIT ?').all(pair[0], pair[1], before, limit)
      : this.db.query<MessageRow, [string, string, number]>('SELECT * FROM messages WHERE dm_a = ? AND dm_b = ? ORDER BY id DESC LIMIT ?').all(pair[0], pair[1], limit);
    return rows.reverse().map(toMessage);
  }
  /** Every message after `cursor` that `name` may see: all channels + DMs they are part of. */
  messagesAfter(name: string, cursor: number, limit: number): Message[] {
    return this.db
      .query<MessageRow, [number, string, string, number]>(
        'SELECT * FROM messages WHERE id > ? AND (channel IS NOT NULL OR dm_a = ? OR dm_b = ?) ORDER BY id ASC LIMIT ?',
      )
      .all(cursor, name, name, limit)
      .map(toMessage);
  }
  lastMessageId(): number {
    return this.db.query<{ m: number | null }, []>('SELECT MAX(id) AS m FROM messages').get()?.m ?? 0;
  }

  /* notifications */
  insertNotification(to: string, kind: 'mention' | 'dm', messageId: number): Notification {
    const row = this.db
      .query<NotificationRow, [string, string, number, string]>('INSERT INTO notifications (recipient, kind, message_id, created_at) VALUES (?, ?, ?, ?) RETURNING *')
      .get(to, kind, messageId, now())!;
    return toNotification(row);
  }
  unreadNotifications(to: string): Notification[] {
    return this.db.query<NotificationRow, [string]>('SELECT * FROM notifications WHERE recipient = ? AND acked_at IS NULL ORDER BY id').all(to).map(toNotification);
  }
  ackNotifications(to: string, ids: number[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    return this.db.query(`UPDATE notifications SET acked_at = ? WHERE recipient = ? AND acked_at IS NULL AND id IN (${placeholders})`).run(now(), to, ...ids).changes;
  }
}

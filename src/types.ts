export type Kind = 'human' | 'agent';

export interface Participant {
  id: number;
  name: string; // slug, unique
  kind: Kind;
  admin: boolean;
  createdAt: string;
}

export interface Channel {
  id: number;
  name: string; // slug, unique; "general" always exists
  createdBy: string;
  createdAt: string;
}

/** A message lives in exactly one place: a channel, or a DM between two names. */
export interface Message {
  id: number; // monotonic; doubles as the event cursor
  channel: string | null;
  dm: [string, string] | null; // sorted pair
  from: string;
  body: string;
  mentions: string[];
  createdAt: string;
}

export interface Notification {
  id: number;
  to: string;
  kind: 'mention' | 'dm';
  messageId: number;
  createdAt: string;
  ackedAt: string | null;
}

/** What an agent receives from the events endpoint (and humans over the socket). */
export type Event =
  | { type: 'message'; message: Message }
  | { type: 'notification'; notification: Notification; message: Message }
  | { type: 'presence'; online: string[] }
  | { type: 'revoked' };

export const NAME = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
export const MAX_BODY = 16_000;
export const PAGE_SIZE = 50;
export const MAX_WAIT_SECONDS = 30;

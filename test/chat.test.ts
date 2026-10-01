import { describe, expect, test } from 'bun:test';
import { hashToken, newToken, timingSafeEqual, tokenFromAuthMessage } from '../src/auth';
import { Chat, HttpError, extractMentions } from '../src/chat';
import { Store, dmPair } from '../src/db';

function setup() {
  const chat = new Chat(new Store(':memory:'));
  const ana = chat.createParticipant('ana', 'human');
  const bot = chat.createParticipant('bot', 'agent');
  const bot2 = chat.createParticipant('bot2', 'agent');
  const admin = chat.createParticipant('root', 'human', true);
  return { chat, ana: ana.participant, bot: bot.participant, bot2: bot2.participant, admin: admin.participant, tokens: { ana: ana.token, bot: bot.token } };
}

describe('auth', () => {
  test('tokens are random, hashed, and resolve to the right participant', () => {
    const { chat, tokens } = setup();
    expect(tokens.ana).not.toBe(tokens.bot);
    expect(tokens.ana.startsWith('cwa_')).toBe(true);
    expect(chat.authenticate(tokens.ana)?.name).toBe('ana');
    expect(chat.authenticate('cwa_nope')).toBeNull();
    expect(hashToken('a')).not.toBe(hashToken('b'));
    expect(newToken().length).toBeGreaterThan(40);
  });
  test('constant-time compare and first-message auth parsing', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(tokenFromAuthMessage('{"type":"auth","token":"t"}')).toBe('t');
    expect(tokenFromAuthMessage('{"type":"send","body":"x"}')).toBeNull();
  });
});

describe('participants and channels', () => {
  test('names are validated and unique', () => {
    const { chat } = setup();
    expect(() => chat.createParticipant('Ana', 'human')).toThrow(HttpError);
    expect(() => chat.createParticipant('ana', 'human')).toThrow(HttpError);
    expect(() => chat.createParticipant('x', 'robot')).toThrow(HttpError);
  });
  test('general exists; channels can be created once', () => {
    const { chat, ana } = setup();
    expect(chat.channels().map((c) => c.name)).toEqual(['general']);
    chat.createChannel('dev', ana);
    expect(() => chat.createChannel('dev', ana)).toThrow(HttpError);
    expect(() => chat.createChannel('Dev Team', ana)).toThrow(HttpError);
  });
});

describe('messages', () => {
  test('channel send persists, history pages back oldest-first', () => {
    const { chat, ana } = setup();
    for (let i = 1; i <= 120; i++) chat.send(ana, { channel: 'general' }, `m${i}`);
    const page = chat.history(ana, { channel: 'general' });
    expect(page).toHaveLength(50);
    expect(page[0].body).toBe('m71');
    expect(page[49].body).toBe('m120');
    const older = chat.history(ana, { channel: 'general' }, page[0].id);
    expect(older[0].body).toBe('m21');
    expect(older[49].body).toBe('m70');
  });
  test('DMs are private to the pair; admin may read agent-agent threads only', () => {
    const { chat, ana, bot, bot2, admin } = setup();
    chat.send(ana, { to: 'bot' }, 'secret');
    chat.send(bot, { to: 'bot2' }, 'robot talk');
    expect(chat.history(ana, { with: 'bot' }).map((m) => m.body)).toEqual(['secret']);
    expect(chat.history(bot2, { with: 'ana' })).toEqual([]); // not their thread
    expect(dmPair('zed', 'amy')).toEqual(['amy', 'zed']);
    expect(chat.dmBetween(admin, 'bot', 'bot2').map((m) => m.body)).toEqual(['robot talk']);
    expect(() => chat.dmBetween(admin, 'ana', 'bot')).toThrow(HttpError); // human DM: no oversight
    expect(() => chat.dmBetween(ana, 'bot', 'bot2')).toThrow(HttpError); // not admin
  });
  test('validation', () => {
    const { chat, ana } = setup();
    expect(() => chat.send(ana, { channel: 'nope' }, 'x')).toThrow(HttpError);
    expect(() => chat.send(ana, { to: 'ghost' }, 'x')).toThrow(HttpError);
    expect(() => chat.send(ana, { to: 'ana' }, 'x')).toThrow(HttpError);
    expect(() => chat.send(ana, {}, 'x')).toThrow(HttpError);
    expect(() => chat.send(ana, { channel: 'general' }, '')).toThrow(HttpError);
    expect(() => chat.send(ana, { channel: 'general' }, 'x'.repeat(16_001))).toThrow(HttpError);
  });
});

describe('mentions and notifications', () => {
  test('only known names count, and never the sender', () => {
    const known = new Set(['ana', 'bot']);
    expect(extractMentions('hey @bot and @ana, not @ghost, email a@b.c', known)).toEqual(['bot', 'ana']);
  });
  test('a mention creates an unread notification that survives until acked', () => {
    const { chat, ana, bot } = setup();
    const m = chat.send(ana, { channel: 'general' }, 'hi @bot, status?');
    expect(m.mentions).toEqual(['bot']);
    const unread = chat.unread(bot);
    expect(unread).toHaveLength(1);
    expect(unread[0].notification.kind).toBe('mention');
    expect(chat.ackNotifications(bot, [unread[0].notification.id])).toBe(1);
    expect(chat.unread(bot)).toHaveLength(0);
    expect(chat.unread(ana)).toHaveLength(0); // mentioning yourself or others does not notify the sender
  });
  test('a DM notifies the recipient', () => {
    const { chat, ana, bot } = setup();
    chat.send(bot, { to: 'ana' }, 'done');
    expect(chat.unread(ana)[0].notification.kind).toBe('dm');
  });
});

describe('pull delivery (agents)', () => {
  test('poll returns events after the cursor; ack advances it and clears notifications', async () => {
    const { chat, ana, bot } = setup();
    chat.send(ana, { channel: 'general' }, 'one');
    chat.send(ana, { channel: 'general' }, 'two @bot');
    chat.send(ana, { to: 'bot' }, 'three');
    const first = await chat.poll(bot, undefined, 0);
    expect(first.events.map((e) => e.type)).toEqual(['message', 'notification', 'notification']);
    expect(first.cursor).toBe(3);
    // Not acked yet: polling again from the stored cursor re-delivers (at-least-once).
    const again = await chat.poll(bot, undefined, 0);
    expect(again.events).toHaveLength(3);
    chat.ack(bot, first.cursor);
    expect(chat.unread(bot)).toHaveLength(0);
    const after = await chat.poll(bot, undefined, 0);
    expect(after.events).toHaveLength(0);
    expect(after.cursor).toBe(3);
  });
  test('a DM between others is not delivered to a third party', async () => {
    const { chat, ana, bot, bot2 } = setup();
    chat.send(ana, { to: 'bot' }, 'private');
    const r = await chat.poll(bot2, 0, 0);
    expect(r.events).toHaveLength(0);
  });
  test('a blocked poll wakes up when a message arrives', async () => {
    const { chat, ana, bot } = setup();
    const t0 = Date.now();
    const pending = chat.poll(bot, 0, 5);
    setTimeout(() => chat.send(ana, { channel: 'general' }, 'wake'), 50);
    const r = await pending;
    expect(r.events).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('push delivery and presence', () => {
  test('subscribers receive channel messages, DMs only reach the pair, presence tracks sockets', () => {
    const { chat, ana, bot, bot2 } = setup();
    const got: Record<string, string[]> = { ana: [], bot: [], bot2: [] };
    const offAna = chat.subscribe('ana', (e) => got.ana.push(e.type));
    const offBot = chat.subscribe('bot', (e) => got.bot.push(e.type));
    expect(chat.online()).toEqual(['ana', 'bot']);
    chat.send(ana, { channel: 'general' }, 'hello @bot');
    chat.send(bot2, { to: 'bot' }, 'psst');
    expect(got.bot).toContain('notification');
    expect(got.bot.filter((t) => t === 'message')).toHaveLength(2);
    expect(got.ana.filter((t) => t === 'message')).toHaveLength(1); // not the DM
    offAna();
    expect(chat.online()).toEqual(['bot']);
    offBot();
    expect(chat.online()).toEqual([]);
  });
});

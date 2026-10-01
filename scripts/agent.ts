// A minimal agent loop: long-poll for events, react, acknowledge the cursor.
// Replace `respond()` with a call to your model or tool runner.
//
//   CWA_URL=http://127.0.0.1:7071 CWA_TOKEN=cwa_… bun run agent
export {};

const base = (process.env.CWA_URL ?? 'http://127.0.0.1:7071').replace(/\/$/, '');
const token = process.env.CWA_TOKEN ?? '';
if (!token) {
  console.error('usage: CWA_TOKEN=<participant token> bun run agent');
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

type Message = { id: number; channel: string | null; dm: [string, string] | null; from: string; body: string; mentions: string[] };
type Event = { type: 'message'; message: Message } | { type: 'notification'; notification: { kind: string }; message: Message } | { type: 'presence' };

const whoami = await fetch(`${base}/api/participants`, { headers }).then((r) => r.json() as Promise<{ me: string }>);
const me = whoami.me;
console.log(`[agent] running as ${me}; waiting for mentions and DMs`);

async function send(target: { channel?: string; to?: string }, body: string) {
  const res = await fetch(`${base}/api/messages`, { method: 'POST', headers, body: JSON.stringify({ ...target, body }) });
  if (!res.ok) console.error(`[agent] send failed: ${res.status} ${await res.text()}`);
}

/** The "brain". Swap this for your model call; it receives the message and returns a reply or null. */
function respond(m: Message): string | null {
  const text = m.body.replace(new RegExp(`@${me}\\b`, 'g'), '').trim();
  if (/\b(ping|hello|hi)\b/i.test(text)) return `hello @${m.from} 👋`;
  if (/\btime\b/i.test(text)) return `it is ${new Date().toISOString()}`;
  return `got it, @${m.from}: "${text.slice(0, 80)}"`;
}

for (;;) {
  let res: Response;
  try {
    res = await fetch(`${base}/api/events?wait=25`, { headers });
  } catch (err) {
    console.error(`[agent] poll error: ${(err as Error).message}; retrying in 3s`);
    await Bun.sleep(3000);
    continue;
  }
  if (!res.ok) {
    console.error(`[agent] poll failed: ${res.status} ${await res.text()}`);
    await Bun.sleep(3000);
    continue;
  }
  const { events, cursor } = (await res.json()) as { events: Event[]; cursor: number };
  for (const e of events) {
    if (e.type !== 'notification') continue; // only act when addressed (mention or DM)
    const m = e.message;
    const reply = respond(m);
    if (reply) await send(m.channel ? { channel: m.channel } : { to: m.from }, reply);
  }
  // Ack only after handling, so a crash above re-delivers instead of losing the turn.
  await fetch(`${base}/api/events/ack`, { method: 'POST', headers, body: JSON.stringify({ cursor }) });
}

# chat-with-agents

A small WebSocket chat service where **humans and AI agents running anywhere talk as one team**: channels, direct messages, `@mentions`, history, presence and notifications, from one SQLite file and one Bun process.

The one idea that makes it work for agents: **humans get pushed to, agents pull.** A person keeps a socket open and sees messages the instant they land. An agent has no UI; it long-polls a "give me what happened since my cursor" endpoint, acts on its turn, and acknowledges. Same messages, same store, two delivery paths.

```
 human (browser) ──── WebSocket ────▶ ┌──────────────────────┐ ◀──── long-poll /api/events ──── agent A
 human (browser) ──── WebSocket ────▶ │  chat-with-agents    │ ◀──── long-poll /api/events ──── agent B
                                      │  Bun + bun:sqlite    │ ◀──── WebSocket (optional) ───── agent C
                                      └──────────────────────┘
                                        channels · DMs · mentions · notifications · presence
```

No dependencies beyond [Bun](https://bun.sh). No build step. One file of state: `chat.sqlite`.

## Quick start

```bash
git clone https://github.com/picanteverde/chat-with-agents
cd chat-with-agents
export CWA_ADMIN_TOKEN=$(openssl rand -hex 32)   # bootstrap credential; keep it
bun run start                                     # http://127.0.0.1:7071
```

Create two participants (the admin token is the only thing that can):

```bash
curl -s -X POST localhost:7071/api/participants -H "Authorization: Bearer $CWA_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"ana","kind":"human"}'
# → {"participant":{"name":"ana",…},"token":"cwa_…"}   ← shown once, hand it to Ana

curl -s -X POST localhost:7071/api/participants -H "Authorization: Bearer $CWA_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"bot","kind":"agent"}'
# → {"participant":{"name":"bot",…},"token":"cwa_…"}   ← give it to the agent
```

Run the sample agent with its token, open <http://127.0.0.1:7071> with Ana's token, and type `hi @bot` in `#general`. The agent wakes up on its next poll, answers, and the reply appears in the browser.

```bash
CWA_TOKEN=cwa_… bun run agent
```

The sample agent only acts when addressed (a mention or a DM) and acknowledges its cursor after handling the batch, so a crash mid-turn replays the turn instead of losing it. Swap its `respond()` for a model call and you have a real one.

## Concepts

- **Participant** — a human or an agent, identified by a slug name and a per-participant token. Identity always comes from the token, never from a name in a payload.
- **Channel** — a named, workspace-wide conversation. `general` always exists; anyone can create more. Everyone can read and post in every channel.
- **DM** — a private thread between two participants, addressed by name. Only the pair can read it, with one exception below.
- **Message** — who, when, where (channel or DM), body (plain text, up to 16 000 chars), and the list of valid `@mentions` it contains. Message ids are monotonic and double as the event cursor.
- **Notification** — created when you are mentioned or receive a DM. Unread ones are re-delivered on every reconnect (at-least-once) until acknowledged.
- **Admin** — the `CWA_ADMIN_TOKEN` (or a participant created with `"admin": true`). Creates and removes participants and may read **agent↔agent** DM threads for supervision. Human DMs stay private even from admins. The raw admin token cannot post or poll; give the admin a participant to chat.

## How agents take turns

```
GET /api/events?wait=25            →  { "events": [...], "cursor": 42 }   (blocks up to 25 s when idle)
   … handle the batch …
POST /api/events/ack {"cursor":42} →  advances the stored cursor and acks notifications up to it
```

- `events` are, in order: `message` (anything you can see: every channel, your DMs) and `notification` (a message that mentioned you or was sent to you directly, wrapped with its notification). Act on notifications, read the rest for context.
- With no `after` parameter the server uses your stored cursor, so a restarted agent resumes where it acked. Pass `after=<id>` to read from anywhere.
- Delivery is **at-least-once**: nothing is marked delivered until you ack. Make handling idempotent or ack promptly.
- Agents may use the WebSocket instead if their runtime handles pushes well; both paths see identical data.

## API

All routes except `/api/health` and the socket upgrade need `Authorization: Bearer <token>`. Errors are `{ "error": "…" }`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | — | liveness |
| `GET` | `/api/participants` | any | list participants; `me` tells you who you are |
| `POST` | `/api/participants` | admin | `{name, kind: "human"\|"agent", admin?}` → participant + one-time token |
| `DELETE` | `/api/participants/:name` | admin | revoke: token dies at once, open sockets are closed, the name is retired (history stays) |
| `GET` | `/api/channels` | any | list |
| `POST` | `/api/channels` | any | `{name}` |
| `GET` | `/api/channels/:name/messages?before=&limit=` | any | newest page, oldest-first; `before=<id>` pages back |
| `GET` | `/api/dm/:name?before=&limit=` | any | your thread with `:name` |
| `GET` | `/api/dm/:a/:b` | admin | oversight: an agent↔agent thread |
| `POST` | `/api/messages` | participant | `{channel, body}` or `{to, body}` → stored message (201 = acknowledged) |
| `GET` | `/api/events?after=&wait=&limit=` | participant | pull events (long-poll, `wait` ≤ 30 s) |
| `POST` | `/api/events/ack` | participant | `{cursor}` |
| `GET` | `/api/notifications` | participant | unread, with their messages |
| `POST` | `/api/notifications/ack` | participant | `{ids:[…]}` |
| `GET` | `/api/presence` | any | names with an open socket |
| `GET` | `/api/ws` | — | WebSocket, see below |

### WebSocket

Connect to `/api/ws` and send `{"type":"auth","token":"…"}` as the **first frame** (within 5 s). You receive `{"type":"ready","me":"ana","online":[…]}` followed by any unread notifications. Then:

| You send | You receive |
|---|---|
| `{"type":"send","channel":"general","body":"…","id":"c1"}` or `{"type":"send","to":"bot","body":"…"}` | `{"type":"sent","id":"c1","message":{…}}` (acknowledged send) |
| `{"type":"ack","ids":[7,8]}` | `{"type":"acked","count":2}` |
| `{"type":"ping"}` | `{"type":"pong"}` |

And at any time: `{"type":"message","message":{…}}` for anything you can see, `{"type":"notification","notification":{…},"message":{…}}` when addressed, `{"type":"presence","online":[…]}` when someone connects or leaves, `{"type":"error","status":…,"message":"…"}` when a frame is rejected.

Mentions: `@name` anywhere in a body, matched against existing participants (unknown names are left as text). Mentioning yourself does not notify you.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CWA_ADMIN_TOKEN` | — | required, ≥ 16 chars; the server refuses to start without it |
| `CWA_HOST` | `127.0.0.1` | bind address; see Security before changing |
| `CWA_PORT` | `7071` | port |
| `CWA_DB` | `chat.sqlite` | SQLite path (`:memory:` for throwaway runs) |
| `CWA_ROOT` | cwd | directory containing `public/` |

## Security

- **Identity is the token.** Every action is attributed to the participant whose token was presented; names inside payloads are only ever *targets*. Tokens are random 256-bit values, shown once, stored as SHA-256 hashes, compared in constant time.
- **The admin token** creates participants and can read agent-to-agent DMs. It cannot read human DMs and cannot post. Treat it like a root credential for the chat.
- **Tokens never travel in URLs.** HTTP uses the `Authorization` header; the socket authenticates with its first frame and is closed after 5 s otherwise.
- **Bind to localhost** (the default) and reach it over an SSH tunnel or a VPN, or put a TLS-terminating reverse proxy in front before setting `CWA_HOST=0.0.0.0`. Over plain `ws://` across a network, tokens and every message are readable on the wire.
- **Blast radius of a stolen participant token:** read every channel, that participant's DMs and notifications; post as them. Not other participants' DMs, not participant management. Revoke with `DELETE /api/participants/:name`: the token stops working immediately, live sockets are closed with 4401, and the name can never be registered again, so a newcomer cannot inherit the old DMs or notifications. Give the person a new name.
- Message bodies are stored and returned verbatim; the web UI renders them as text, never HTML. If you build another client, do the same.
- No rate limiting. Put one in the proxy if the service faces anything but your own agents.

## Development

```bash
bun test            # 15 tests against an in-memory SQLite: auth, channels, DMs, paging, mentions, pull/ack, push/presence
bun run typecheck
bun run dev         # restart on change
```

Layout: `src/db.ts` (schema + queries), `src/chat.ts` (all behaviour, HTTP-free, fully unit-tested), `src/server.ts` (routes + socket), `public/index.html` (single-page client), `scripts/agent.ts` (sample agent loop).

## License

MIT

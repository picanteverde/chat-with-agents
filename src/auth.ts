// Identity comes from a per-participant token, never from a client-supplied name.
// Tokens are random, shown once at creation, and stored as SHA-256 hashes.
// The admin token (CWA_ADMIN_TOKEN) bootstraps participants and may read every DM.

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'cwa_' + Buffer.from(bytes).toString('base64url');
}

export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1].trim() : null;
}

/** First WebSocket frame: {"type":"auth","token":"…"}. Tokens never go in URLs. */
export function tokenFromAuthMessage(raw: string | Uint8Array): string | null {
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const m = JSON.parse(text) as { type?: unknown; token?: unknown };
    return m.type === 'auth' && typeof m.token === 'string' ? m.token : null;
  } catch {
    return null;
  }
}

export function requireAdminToken(value: string | undefined): string {
  const token = (value ?? '').trim();
  if (token.length < 16) {
    throw new Error('CWA_ADMIN_TOKEN must be set to a secret of at least 16 characters (try: openssl rand -hex 32)');
  }
  return token;
}

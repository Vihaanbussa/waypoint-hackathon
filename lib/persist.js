// Somewhere durable to keep the store when the host's own disk is wiped on
// every restart. Speaks the Upstash Redis REST API: one POST per command, the
// command as a JSON array, the answer as { result } or { error }.
//
// With no address and token it does nothing, and the JSON files are all there is.

// Settings get pasted with extras: quotes around the value, the NAME= in front,
// or both lines of a .env block at once. Pick the value for `name` out of that.
export function cleanSetting(value, name) {
  let text = String(value ?? '').trim();
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith(`${name}=`));
  if (line) text = line.trim().slice(name.length + 1);
  else if (/\n/.test(text)) text = text.split(/\r?\n/)[0];
  return text.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

// What kind of text a secret setting holds, without giving any of it away:
// its length and its shape. For working out why a pasted token is refused.
export function describeSecret(value) {
  const text = String(value ?? '');
  const size = `${text.length} characters`;
  if (!text) return 'empty';
  if (/^https?:\/\//i.test(text)) return `${size}, a web address rather than a token`;
  if (/^rediss?:\/\//i.test(text) || /^redis-cli\b/i.test(text)) return `${size}, a redis:// address or command rather than the REST token`;
  if (/^[*\u2022\u00b7.]+$/.test(text)) return `${size}, only the dots or stars a hidden token is shown as`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return `${size}, an id (UUID) rather than a token`;
  if (/^wpb_/.test(text)) return `${size}, a Waypoint Bot key rather than the database token`;
  if (/\s/.test(text)) return `${size}, with spaces or line breaks inside`;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return `${size}, with characters a token does not have`;
  if (text.length < 40) return `${size}, shorter than an Upstash REST token (about 60 or more)`;
  return `${size}, the right shape for a token`;
}

export function createPersist({ url: rawUrl, token: rawToken, prefix = 'waypoint' } = {}) {
  const url = cleanSetting(rawUrl, 'UPSTASH_REDIS_REST_URL').replace(/\/+$/, '');
  const token = cleanSetting(rawToken, 'UPSTASH_REDIS_REST_TOKEN');
  const remote = Boolean(url && token);

  async function command(args) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `The database answered ${res.status}.`);
    return data.result;
  }

  return {
    remote,
    // Safe to log: says nothing about the token but its length and shape.
    tokenLooksLike: describeSecret(token),
    // The saved value, or null if nothing has been saved under that name yet.
    async get(name) {
      if (!remote) return null;
      const text = await command(['GET', `${prefix}:${name}`]);
      return text == null ? null : JSON.parse(text);
    },
    async set(name, value) {
      if (!remote) return;
      await command(['SET', `${prefix}:${name}`, JSON.stringify(value)]);
    },
  };
}

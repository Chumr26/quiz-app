// Cloudflare Worker: leaderboard-proxy
// Validates submissions, writes them to data/leaderboard.json via GitHub
// Contents API, enforces origin allow-list, per-IP rate limit, and global
// daily quota. The repo is public; the PAT is fine-grained with the
// `paths: data/leaderboard.json` filter, so a leak can't broaden scope.

export interface Env {
  GH_PAT: string;
  GH_REPO: string;
  ALLOWED_ORIGINS: string;
  RL_KV: KVNamespace;
}

const NAME_RE = /^[A-Za-zÀ-ỹ0-9 _.\-]{1,30}$/u;
const BACKOFFS_MS = [1000, 2000, 4000];
const MAX_ENTRIES = 100;

function json(data: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function validate(b: any): string | null {
  if (typeof b?.name !== 'string') return 'name required';
  const n = b.name.trim();
  if (!NAME_RE.test(n)) return 'name 1-30 chars [A-Za-zÀ-ỹ0-9 _.-]';
  if (!Number.isInteger(b.part) || b.part < 0 || b.part > 5) return 'part 0-5';
  if (!Number.isInteger(b.score) || b.score < 0 || b.score > 200) return 'score 0-200';
  if (![40, 200].includes(b.total)) return 'total 40 or 200';
  if (!Number.isInteger(b.ms) || b.ms < 0) return 'ms >= 0';
  if ((b.part <= 4 && b.total !== 40) || (b.part === 5 && b.total !== 200))
    return 'total mismatch with part';
  return null;
}

async function perIpLimit(ip: string, env: Env): Promise<boolean> {
  const key = `rl:ip:${ip}`;
  const cur = parseInt((await env.RL_KV.get(key)) || '0');
  if (cur >= 5) return false;
  await env.RL_KV.put(key, String(cur + 1), { expirationTtl: 600 });
  return true;
}

async function globalQuotaOk(env: Env): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:global:${day}`;
  const cur = parseInt((await env.RL_KV.get(key)) || '0');
  if (cur >= 5000) return false;
  await env.RL_KV.put(key, String(cur + 1), { expirationTtl: 86400 });
  return true;
}

async function ghGet(env: Env): Promise<{ sha: string; data: any } | null> {
  const r = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/contents/data/leaderboard.json`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_PAT}`,
        'User-Agent': 'leaderboard-proxy',
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (!r.ok) return null;
  const j: any = await r.json();
  let text: string;
  try {
    text = b64decode(j.content);
  } catch {
    return null;
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data.entries)) return null;
  return { sha: j.sha, data };
}

async function ghPut(env: Env, sha: string, content: string): Promise<number> {
  const r = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/contents/data/leaderboard.json`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GH_PAT}`,
        'Content-Type': 'application/json',
        'User-Agent': 'leaderboard-proxy',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({
        message: `chore(leaderboard): append submission (${content.length}B)`,
        content: b64encode(content),
        sha,
      }),
    }
  );
  return r.status;
}

async function submitWithRetry(env: Env, newEntry: any): Promise<{ ok: boolean; kind?: string }> {
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    const cur = await ghGet(env);
    if (!cur) return { ok: false, kind: 'upstream' };

    cur.data.entries = (cur.data.entries || []).concat(newEntry);
    cur.data.entries.sort((a: any, b: any) => b.score - a.score || a.ms - a.ms);
    if (cur.data.entries.length > MAX_ENTRIES) cur.data.entries = cur.data.entries.slice(0, MAX_ENTRIES);

    const newContent = JSON.stringify(cur.data, null, 2);
    const status = await ghPut(env, cur.sha, newContent);
    if (status === 200) return { ok: true };

    const isLastAttempt = attempt === BACKOFFS_MS.length;
    if (isLastAttempt) return { ok: false, kind: 'race' };

    if (status === 409) {
      // SHA race: next iteration re-fetches SHA, no extra sleep
      continue;
    }
    if (status >= 500) {
      await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt]));
      continue;
    }
    return { ok: false, kind: status === 401 ? 'config' : 'upstream' };
  }
  return { ok: false, kind: 'race' };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const originOk = allowed.includes(origin);
    const corsH = originOk
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        }
      : {};

    // Server-side reject BEFORE any side-effect. CORS alone wouldn't protect writes.
    if (!originOk) {
      return new Response('forbidden', { status: 403 });
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsH });
    }
    if (req.method === 'GET' && new URL(req.url).pathname === '/api/health') {
      return json({ ok: true }, 200, corsH);
    }
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/api/submit') {
      return json({ error: 'not found' }, 404, corsH);
    }

    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await perIpLimit(ip, env))) {
      return json({ error: 'ratelimit' }, 429, { ...corsH, 'Retry-After': '600' });
    }
    if (!(await globalQuotaOk(env))) {
      return json({ error: 'quota', retry: false }, 503, corsH);
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'validation', reason: 'bad json' }, 400, corsH);
    }
    const reason = validate(body);
    if (reason) return json({ error: 'validation', reason }, 400, corsH);

    const newEntry = {
      name: body.name.trim(),
      part: body.part,
      score: body.score,
      total: body.total,
      ms: body.ms,
      ts: new Date().toISOString(),
    };

    const result = await submitWithRetry(env, newEntry);
    if (result.ok) return json({ ok: true, queuedAt: newEntry.ts }, 200, corsH);
    const statusBy: Record<string, number> = { race: 503, upstream: 503, config: 503 };
    const retryBy: Record<string, boolean> = { race: true, upstream: true, config: false };
    return json(
      { error: result.kind, retry: retryBy[result.kind!] },
      statusBy[result.kind!],
      corsH
    );
  },
};
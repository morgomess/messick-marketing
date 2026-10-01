// Weekly review worker. Serves the client weekly review page at messickmarketing.com/review/?c=<code>.
//
// Public (the code is the only key; it is unguessable and never appears in the public repo):
//   GET  /api/week?c=         posts for the review week (Status = Done only), approved insights, review state
//   POST /api/approve         {c, post, name, approved}   -> Airtable record comment + state
//   POST /api/comment         {c, post, name, text}       -> Airtable record comment + state
//   POST /api/submit          {c, name}                   -> Telegram summary to Morgan + state
//   GET  /img?c=&k=           highlight images stored by the weekly insights job
// Admin (Bearer ADMIN_KEY):
//   PUT  /admin/client?c=     {name, baseId, tz}
//   PUT  /admin/insights?c=   {weekStart, period, takeaway, tops, quotes, audience}
//   PUT  /admin/img?c=&k=     raw image bytes, Content-Type header kept
//   PUT  /admin/draft?c=      same body as insights; returns draftKey for the private preview (?c=&d=)
//   POST /admin/approve?c=    promotes the draft to live insights
//   GET  /admin/clients       list of configured clients
//
// The review week is the Monday-to-Sunday week containing (now + 76 hours) in the client's time
// zone: from Thursday 8 PM (when the weekly preview QA runs) the page shows next week, before that
// the current one.

import { aios } from './aios.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/admin/')) return await admin(req, env, url);
      if (p.startsWith('/aios/')) return await aios(req, env, url, { json, at, clean });
      if (p === '/img' && req.method === 'GET') return await img(env, url);
      if (p === '/api/week' && req.method === 'GET') return await week(env, url.searchParams.get('c'), url.searchParams.get('d'));
      if (req.method === 'POST' && ['/api/approve', '/api/comment', '/api/submit'].includes(p)) {
        const body = await req.json().catch(() => ({}));
        return await action(env, p.slice(5), body);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server', detail: String(e.message || e) }, 500);
    }
  },
};

async function getClient(env, code) {
  if (!code || !/^[a-z0-9]{8,24}$/.test(code)) return null;
  return env.REVIEW.get('client:' + code, 'json');
}

// ---------- dates ----------
function todayIn(tz) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(s + 'T00:00:00Z');
}
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
// Flips to next week at Thursday 8 PM local, when the weekly preview QA starts (Morgan, 2026-10-01):
// local wall-clock time + 76 hours lands on Monday 00:00 exactly at that moment.
function reviewWeek(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const t0 = new Date(local + 76 * 3600e3);
  const t = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate()));
  const monday = addDays(t, -((t.getUTCDay() + 6) % 7));
  return { start: monday, end: addDays(monday, 6) };
}
const label = d => `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;

// ---------- Airtable ----------
async function at(env, path, init = {}) {
  const r = await fetch('https://api.airtable.com/v0/' + path, {
    ...init, headers: { Authorization: 'Bearer ' + env.AIRTABLE_PAT, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Airtable ${r.status} ${JSON.stringify(data.error || data).slice(0, 200)}`);
  return data;
}

// Month tables are named like "October 2026". A month's first posts can sit in the previous
// month's table, so the month before the week is read too.
function monthTables(tables, start, end) {
  const want = new Set();
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)); d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    want.add(`${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`);
  }
  return tables.filter(t => want.has(t.name.trim()));
}

async function loadPosts(env, client, start, end) {
  const cacheKey = `posts:${client.baseId}:${ymd(start)}`;
  const cached = await env.REVIEW.get(cacheKey, 'json');
  if (cached) return cached;
  const meta = await at(env, `meta/bases/${client.baseId}/tables`);
  const posts = [];
  let unfinished = 0;
  for (const t of monthTables(meta.tables, start, end)) {
    const byName = n => t.fields.find(f => f.name.trim().toLowerCase() === n);
    const f = {
      title: t.fields.find(x => x.id === t.primaryFieldId),
      date: byName('publishing date'), status: byName('status'), caption: byName('caption'),
      tags: byName('hashtags'), platforms: byName('platforms'), media: byName('image') || t.fields.find(x => x.type === 'multipleAttachments'),
    };
    if (!f.date) continue;
    let offset;
    do {
      const q = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
      if (offset) q.set('offset', offset);
      const page = await at(env, `${client.baseId}/${t.id}?${q}`);
      for (const r of page.records) {
        const v = r.fields, d = v[f.date.id];
        if (!d || d < ymd(start) || d > ymd(end)) continue;
        const status = f.status && v[f.status.id];
        const statusName = typeof status === 'string' ? status : status?.name;
        if (statusName !== 'Done') { unfinished++; continue; }
        const plats = f.platforms ? (v[f.platforms.id] || []).map(x => (typeof x === 'string' ? x : x.name)) : [];
        const media = (f.media ? v[f.media.id] || [] : []).map(a => ({
          url: a.url, type: a.type || '', w: a.width, h: a.height,
          thumb: a.thumbnails?.large?.url || null,
        }));
        posts.push({
          id: `${t.id}:${r.id}`, date: d,
          title: f.title ? String(v[f.title.id] || '') : '',
          caption: f.caption ? v[f.caption.id] || '' : '', hashtags: f.tags ? v[f.tags.id] || '' : '',
          platforms: plats, media,
        });
      }
      offset = page.offset;
    } while (offset);
  }
  posts.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  for (const x of posts) { const d = new Date(x.date + 'T00:00:00Z'); x.day = DAYS[d.getUTCDay()]; x.dateLabel = label(d); }
  const out = { posts, unfinished };
  // Attachment URLs from Airtable last about two hours; five minutes of cache is safe.
  await env.REVIEW.put(cacheKey, JSON.stringify(out), { expirationTtl: 300 });
  return out;
}

// ---------- routes ----------
async function week(env, code, draftKey) {
  const client = await getClient(env, code);
  if (!client) return json({ error: 'unknown link' }, 404);
  const draft = draftKey ? await env.REVIEW.get('draft:' + code, 'json') : null;
  const isDraft = !!(draft && draft.draftKey === draftKey);
  const { start, end } = isDraft ? { start: new Date(draft.weekStart + 'T00:00:00Z'), end: addDays(new Date(draft.weekStart + 'T00:00:00Z'), 6) } : reviewWeek(client.tz);
  const { posts, unfinished } = await loadPosts(env, client, start, end);
  const insights = isDraft ? { ...draft, draftKey: undefined, draft: true } : await env.REVIEW.get('insights:' + code, 'json');
  const state = (await env.REVIEW.get(`review:${code}:${ymd(start)}`, 'json')) || { approvals: {}, comments: [], submitted: null };
  // Soft deadline: Monday 9 AM of the review week, client's own time (Morgan, 2026-09-30).
  const nowLocal = new Intl.DateTimeFormat('en-CA', { timeZone: client.tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(', ', 'T');
  const deadline = { label: `Monday, ${label(start)} at 9 AM`, passed: nowLocal >= `${ymd(start)}T09` };
  return json({
    client: { name: client.name },
    deadline,
    week: { start: ymd(start), end: ymd(end), label: `${label(start)} to ${start.getUTCMonth() === end.getUTCMonth() ? end.getUTCDate() : label(end)}` },
    posts, unfinished,
    insights: insights && insights.weekStart === ymd(start) ? insights : null,
    state,
  });
}

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

async function action(env, kind, body) {
  const client = await getClient(env, body.c);
  if (!client) return json({ error: 'unknown link' }, 404);
  const name = clean(body.name, 60);
  if (!name) return json({ error: 'name required' }, 400);
  const { start } = reviewWeek(client.tz);
  const key = `review:${body.c}:${ymd(start)}`;
  const state = (await env.REVIEW.get(key, 'json')) || { approvals: {}, comments: [], submitted: null };

  if (kind === 'approve' || kind === 'comment') {
    const [tableId, recordId] = String(body.post || '').split(':');
    if (!/^tbl\w{14}$/.test(tableId || '') || !/^rec\w{14}$/.test(recordId || '')) return json({ error: 'bad post' }, 400);
    // Only posts that are actually on this week's page can be touched.
    const { posts } = await loadPosts(env, client, start, reviewWeek(client.tz).end);
    if (!posts.some(x => x.id === body.post)) return json({ error: 'post not in this week' }, 400);
    let text;
    if (kind === 'approve') {
      const on = !!body.approved;
      if (on) state.approvals[body.post] = { by: name, at: new Date().toISOString() };
      else delete state.approvals[body.post];
      text = on ? `Client review: approved by ${name}.` : `Client review: approval withdrawn by ${name}.`;
    } else {
      const msg = clean(body.text, 2000);
      if (!msg) return json({ error: 'empty' }, 400);
      state.comments.push({ post: body.post, by: name, text: msg, at: new Date().toISOString() });
      text = `Client review, ${name}: ${msg}`;
    }
    await at(env, `${client.baseId}/${tableId}/${recordId}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
    await env.REVIEW.put(key, JSON.stringify(state));
    return json({ ok: true, state });
  }

  if (kind === 'submit') {
    const { posts } = await loadPosts(env, client, start, reviewWeek(client.tz).end);
    const approved = posts.filter(x => state.approvals[x.id]).length;
    const commented = new Set(state.comments.map(c => c.post)).size;
    const open = posts.filter(x => !state.approvals[x.id] && !state.comments.some(c => c.post === x.id)).length;
    state.submitted = { by: name, at: new Date().toISOString(), approved, commented, open };
    await env.REVIEW.put(key, JSON.stringify(state));
    const lines = [`${client.name} weekly review sent by ${name}: ${approved} approved, ${commented} with comments, ${open} left open.`];
    for (const c of state.comments) {
      const x = posts.find(y => y.id === c.post);
      lines.push('', `${x ? `${x.day} ${x.dateLabel}, ${x.title}` : 'A post'}`, `${c.by}: "${c.text}"`);
    }
    await telegram(env, lines.join('\n').replace(/[—–]/g, ','));
    return json({ ok: true, state });
  }
  return json({ error: 'not found' }, 404);
}

async function telegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
  }).catch(() => {});
}

async function img(env, url) {
  const c = url.searchParams.get('c'), k = url.searchParams.get('k');
  if (!(await getClient(env, c)) || !/^[\w.-]{1,80}$/.test(k || '')) return new Response('not found', { status: 404 });
  const { value, metadata } = await env.REVIEW.getWithMetadata(`img:${c}:${k}`, 'arrayBuffer');
  if (!value) return new Response('not found', { status: 404 });
  return new Response(value, { headers: { 'Content-Type': metadata?.type || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', ...CORS } });
}

async function admin(req, env, url) {
  if (req.headers.get('Authorization') !== 'Bearer ' + env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
  const c = url.searchParams.get('c');
  const p = url.pathname;
  if (p === '/admin/clients' && req.method === 'GET') {
    const list = await env.REVIEW.list({ prefix: 'client:' });
    const out = [];
    for (const k of list.keys) out.push({ code: k.name.slice(7), ...(await env.REVIEW.get(k.name, 'json')) });
    return json(out);
  }
  if (!/^[a-z0-9]{8,24}$/.test(c || '')) return json({ error: 'bad code' }, 400);
  if (p === '/admin/client' && req.method === 'PUT') {
    const b = await req.json();
    if (!/^app\w{14}$/.test(b.baseId || '') || !b.name) return json({ error: 'name and baseId required' }, 400);
    await env.REVIEW.put('client:' + c, JSON.stringify({ name: b.name, baseId: b.baseId, tz: b.tz || 'America/Chicago' }));
    return json({ ok: true });
  }
  if (p === '/admin/insights' && req.method === 'PUT') {
    const b = await req.json();
    if (!/^\d{4}-\d\d-\d\d$/.test(b.weekStart || '')) return json({ error: 'weekStart required' }, 400);
    if (/[—–]/.test(JSON.stringify(b))) return json({ error: 'em or en dash in client copy' }, 400);
    await env.REVIEW.put('insights:' + c, JSON.stringify(b));
    return json({ ok: true });
  }
  if (p === '/admin/insights' && req.method === 'DELETE') { await env.REVIEW.delete('insights:' + c); return json({ ok: true }); }
  // Drafts: Morgan previews at /review/?c=<code>&d=<draftKey> before anything reaches the client.
  if (p === '/admin/draft' && req.method === 'PUT') {
    const b = await req.json();
    if (!/^\d{4}-\d\d-\d\d$/.test(b.weekStart || '')) return json({ error: 'weekStart required' }, 400);
    if (/[—–]/.test(JSON.stringify(b))) return json({ error: 'em or en dash in client copy' }, 400);
    const draftKey = [...crypto.getRandomValues(new Uint8Array(12))].map(x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');
    await env.REVIEW.put('draft:' + c, JSON.stringify({ ...b, draftKey }), { expirationTtl: 60 * 60 * 24 * 14 });
    return json({ ok: true, draftKey });
  }
  if (p === '/admin/approve' && req.method === 'POST') {
    const d = await env.REVIEW.get('draft:' + c, 'json');
    if (!d) return json({ error: 'no draft' }, 404);
    const { draftKey, ...live } = d;
    await env.REVIEW.put('insights:' + c, JSON.stringify(live));
    await env.REVIEW.delete('draft:' + c);
    return json({ ok: true, weekStart: live.weekStart });
  }
  if (p === '/admin/img' && req.method === 'PUT') {
    const k = url.searchParams.get('k');
    if (!/^[\w.-]{1,80}$/.test(k || '')) return json({ error: 'bad key' }, 400);
    await env.REVIEW.put(`img:${c}:${k}`, await req.arrayBuffer(), { metadata: { type: req.headers.get('Content-Type') || 'image/jpeg' }, expirationTtl: 60 * 60 * 24 * 60 });
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

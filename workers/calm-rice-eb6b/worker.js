export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

    // ── AUTH ──
    // Every /sync call and the Anthropic proxy need either a dashboard login
    // token (issued by messick-marketing-ai-proxy /login, same DASH_TOKEN_SECRET)
    // or the machine key (SYNC_ADMIN_KEY). The one open door is appending to the
    // engagement inbox, which Chrome harvest jobs post to from arbitrary pages;
    // it can only add posts (deduped, capped at 2000), never read or replace.
    // AUTH_MODE "log" lets unauthenticated calls through and logs them, for
    // rollout; "enforce" rejects them.
    const isInboxAppend = url.pathname === "/sync" && request.method === "POST"
      && url.searchParams.get("key") === "engagement_inbox" && url.searchParams.get("append") === "1";
    // The Gmail receipt parser (Apps Script, expenses-intake-script.gs) holds INTAKE_KEY. That key
    // can do exactly one thing: append candidate charges to expenses_inbox. It cannot read any
    // key, replace any key, or touch the ledger. The body is validated below.
    const isIntakeAppend = url.pathname === "/sync" && request.method === "POST"
      && url.searchParams.get("key") === "expenses_inbox" && url.searchParams.get("append") === "1"
      && !!env.INTAKE_KEY && timingSafeEq((request.headers.get("Authorization") || "").replace(/^Bearer /, ""), env.INTAKE_KEY);
    const needsAuth = url.pathname === "/sync" || (request.method === "POST" && url.pathname !== "/moxie-sync");
    // The expenses Google Sheet pulls on a timer with SHEET_READ_KEY, which can
    // read the expenses key and nothing else.
    const isSheetRead = request.method === "GET" && url.pathname === "/sync" && url.searchParams.get("key") === "expenses"
      && !!env.SHEET_READ_KEY && timingSafeEq((request.headers.get("Authorization") || "").replace(/^Bearer /, ""), env.SHEET_READ_KEY);
    if (needsAuth && !isInboxAppend && !isIntakeAppend && !isSheetRead && !(await isAuthorized(request, env))) {
      if (env.AUTH_MODE === "enforce") {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      console.log("unauthenticated", request.method, url.pathname, url.searchParams.get("key") || "", request.headers.get("Origin") || "");
    }

    // ── MOXIE SYNC: manual run, admin key required ──
    if (url.pathname === "/moxie-sync") {
      const auth = request.headers.get("Authorization") || "";
      if (!env.SYNC_ADMIN_KEY || auth !== "Bearer " + env.SYNC_ADMIN_KEY) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (url.searchParams.get("ping") === "1") {
        // Read-only auth check: status code only, never the response body.
        const r = await fetch(env.MOXIE_BASE_URL.replace(/\/+$/, "") + "/action/clients/list", { headers: { "X-API-KEY": env.MOXIE_API_KEY } });
        return new Response(JSON.stringify({ moxieStatus: r.status }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const result = await syncToMoxie(env, { dry: url.searchParams.get("dry") === "1" });
      return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── SYNC: GET /sync?key=dashboard or /sync?key=expenses ──
    if (url.pathname === "/sync" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (!key) return new Response(JSON.stringify({ error: "Missing key" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const data = await env.MM_SYNC.get(key);
      return new Response(data || "{}", { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── SYNC: POST /sync?key=dashboard or /sync?key=expenses ──
    if (url.pathname === "/sync" && request.method === "POST") {
      const key = url.searchParams.get("key");
      if (!key) return new Response(JSON.stringify({ error: "Missing key" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const body = await request.text();

      // ── APPEND MODE: POST /sync?key=X&append=1 ──
      // Default POST replaces the whole value, so two writers racing means the
      // second silently destroys the first. Append merges server-side instead,
      // which is what the engagement inbox needs when several harvest jobs
      // report in independently. Purely additive: without &append=1 nothing
      // below changes.
      if (url.searchParams.get("append") === "1") {
        let incoming;
        try {
          incoming = JSON.parse(body);
        } catch (e) {
          return new Response(JSON.stringify({ error: "Body must be JSON" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
          return new Response(JSON.stringify({ error: "Body must be a JSON object with a posts array" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        let prev = {};
        const prevRaw = await env.MM_SYNC.get(key);
        if (prevRaw) { try { prev = JSON.parse(prevRaw) || {}; } catch (e) { prev = {}; } }

        if (key === "expenses_inbox") {
          const r = appendInboxItems(prev, incoming);
          if (r.error) return new Response(JSON.stringify({ error: r.error }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          // Resolve what needs no decision right here, so the ledger stays current
          // without the app being opened: already logged, skipped merchant, a
          // template-day entry to re-date, or a known merchant to log outright.
          const auto = await processInbox(env, r.merged, ctx);
          await env.MM_SYNC.put(key, JSON.stringify(r.merged));
          return new Response(JSON.stringify({ ok: true, appended: r.added, duplicates: r.dupes, rejected: r.rejected, total: r.merged.items.length, ...auto }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const prevPosts = Array.isArray(prev.posts) ? prev.posts : [];
        const newPosts = Array.isArray(incoming.posts) ? incoming.posts : [];

        // Same URL normalisation the app uses, so a post that arrives twice
        // from two different jobs is stored once.
        const norm = (u) => String(u || "").trim().toLowerCase()
          .replace(/^https?:\/\//, "").replace(/^www\./, "")
          .replace(/[?#].*$/, "").replace(/\/+$/, "");

        const seen = new Set(prevPosts.map((p) => norm(p && (p.postUrl || p.url))).filter(Boolean));
        const added = [];
        for (const p of newPosts) {
          const k = norm(p && (p.postUrl || p.url));
          if (k && seen.has(k)) continue;
          if (k) seen.add(k);
          added.push(p);
        }

        // Scalar fields from the newest writer win; posts accumulate.
        const merged = { ...prev, ...incoming, posts: prevPosts.concat(added) };

        // Backstop so a runaway job cannot grow the value without limit.
        const CAP = 2000;
        let capped = 0;
        if (merged.posts.length > CAP) {
          capped = merged.posts.length - CAP;
          merged.posts = merged.posts.slice(-CAP);
        }

        await env.MM_SYNC.put(key, JSON.stringify(merged));
        return new Response(JSON.stringify({
          ok: true,
          appended: added.length,
          duplicates: newPosts.length - added.length,
          total: merged.posts.length,
          dropped: capped,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      await env.MM_SYNC.put(key, body);

      // Push new Messick entries to Moxie right after every expenses save. The
      // account's cron slots are all taken, so the save is the trigger.
      if (key === "expenses") {
        // Hand over the body just saved: a KV read straight after the put can
        // return the previous copy, which made the sync miss the new entries.
        let saved = null, removed = null;
        try { const b = JSON.parse(body); saved = b.expenses; removed = b.deleted; } catch (e) {}
        ctx.waitUntil(syncToMoxie(env, { expenses: saved, deleted: removed })
          .then(r => console.log("moxie sync", JSON.stringify(r)))
          .catch(e => console.error("moxie sync failed", e)));
      }

      // The expenses Google Sheet used to be pushed from here, but its Apps Script
      // is domain-restricted, so every anonymous push landed on a sign-in page.
      // The sheet now pulls instead (expenses-sheet-script.gs, SHEET_READ_KEY).

      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── POST PREVIEW IMAGES: GET /pimg?k=<key> (public; these are already-public post graphics) ──
    if (url.pathname === "/pimg" && request.method === "GET") {
      const k = url.searchParams.get("k") || "";
      if (!/^[a-f0-9]{40}$/.test(k)) return new Response("bad key", { status: 400, headers: corsHeaders });
      const { value, metadata } = await env.MM_SYNC.getWithMetadata("pimg:" + k, "arrayBuffer");
      if (!value) return new Response("not found", { status: 404, headers: corsHeaders });
      return new Response(value, { headers: { ...corsHeaders, "Content-Type": (metadata && metadata.type) || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
    }

    // ── POST PREVIEWS: POST /post-previews (Stats app share links) ──
    if (url.pathname === "/post-previews" && request.method === "POST") {
      try {
        const out = await postPreviews(env, await request.json(), url.origin);
        return new Response(JSON.stringify(out), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // ── CLAUDE PROXY (existing — unchanged) ──
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const apiKey = env.ANTHROPIC_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "ANTHROPIC_KEY secret is not configured." }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body.payload),
        });
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }
    return new Response("Bridge Ready", { headers: corsHeaders });
  }
};

// ── EXPENSES INBOX (receipt candidates from Gmail) ──
// Items are small, typed records; anything else is dropped. Only `items` from the
// caller is honoured, so an append can never change skip rules or resolved statuses.
const INBOX_STR = { id: 120, kind: 10, date: 10, merchant: 80, detail: 200, source: 40, msgId: 40, viewUrl: 300, currency: 3 };
function cleanInboxItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const it = {};
  for (const [k, max] of Object.entries(INBOX_STR)) {
    if (raw[k] == null) continue;
    if (typeof raw[k] !== "string") return null;
    it[k] = raw[k].slice(0, max);
  }
  if (!it.id || !it.merchant) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || "")) return null;
  if (it.kind !== "income") it.kind = "expense";
  if (raw.amount != null) {
    const a = Number(raw.amount);
    if (!isFinite(a) || a < 0 || a > 1000000) return null;
    it.amount = Math.round(a * 100) / 100;
  } else it.amount = null;
  if (Array.isArray(raw.lines)) {
    it.lines = raw.lines.slice(0, 20).map(l => ({ name: String(l && l.name || "").slice(0, 80), amount: Number(l && l.amount) || 0 }));
  }
  if (!/^https:\/\/mail\.google\.com\//.test(it.viewUrl || "")) delete it.viewUrl;
  it.status = "pending";
  it.receivedAt = new Date().toISOString();
  return it;
}
function appendInboxItems(prev, incoming) {
  const list = Array.isArray(incoming.items) ? incoming.items : null;
  if (!list) return { error: "Body must be {items:[...]}" };
  if (list.length > 200) return { error: "At most 200 items per call" };
  const prevItems = Array.isArray(prev.items) ? prev.items : [];
  const seen = new Set(prevItems.map(i => i.id));
  let added = 0, dupes = 0, rejected = 0;
  for (const raw of list) {
    const it = cleanInboxItem(raw);
    if (!it) { rejected++; continue; }
    if (seen.has(it.id)) { dupes++; continue; }
    seen.add(it.id); prevItems.push(it); added++;
  }
  // Keep the newest 1000; resolved items older than a year fall off.
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();
  let items = prevItems.filter(i => i.status === "pending" || (i.receivedAt || "9") >= cutoff);
  if (items.length > 1000) items = items.slice(-1000);
  const merged = { ...prev, items, lastAppendAt: new Date().toISOString() };
  return { merged, added, dupes, rejected };
}

// ── INBOX AUTO-PROCESSING ──
// Runs on every intake delivery. Rules, in order, for each pending expense item:
//  1. merchant on the skip list                          -> skipped
//  2. same merchant and amount already logged within 3d  -> matched
//  3. same merchant and amount within 12d on an entry a
//     recurring template generated                       -> that entry is re-dated to the
//                                                          receipt, template follows (accepted)
//  4. merchant has 2+ prior entries agreeing on category
//     and business                                       -> logged now from that history (accepted)
//  5. anything else                                      -> stays pending for the Inbox tab
// Income items are never touched. A ledger write here goes through the same Moxie
// sync as a save from the app.
const normM = v => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const dayDiff = (a, b) => Math.abs(Math.round((new Date(a + "T12:00:00Z") - new Date(b + "T12:00:00Z")) / 86400000));
function advanceDate(dateStr, freq, anchorDay) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = anchorDay || d, pad = n => String(n).padStart(2, "0");
  const clamp = (yy, mm0) => { const last = new Date(Date.UTC(yy, mm0 + 1, 0)).getUTCDate(); return yy + "-" + pad(mm0 + 1) + "-" + pad(Math.min(day, last)); };
  if (freq === "weekly") { const t = new Date(Date.UTC(y, m - 1, d + 7)); return t.toISOString().slice(0, 10); }
  if (freq === "yearly") return clamp(y + 1, m - 1);
  return clamp(m === 12 ? y + 1 : y, m % 12);
}
function newId() { return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function processInbox(env, inbox, ctx) {
  const pending = (inbox.items || []).filter(it => it.status === "pending" && it.kind !== "income");
  const out = { autoMatched: 0, autoSkipped: 0, autoRedated: 0, autoLogged: 0, leftPending: 0 };
  if (!pending.length) return out;
  const raw = await env.MM_SYNC.get("expenses");
  const store = raw ? JSON.parse(raw) : { expenses: [] };
  const expenses = Array.isArray(store.expenses) ? store.expenses : [];
  // Snapshot of the ledger as read, for the drift check before writing.
  const readFingerprint = JSON.stringify(expenses.map(e => e.id + ":" + e.date));
  const skip = new Set((inbox.skipMerchants || []).map(normM));
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  let ledgerChanged = false;

  for (const it of pending) {
    const key = normM(it.merchant);
    if (!key) { out.leftPending++; continue; }
    if (skip.has(key)) { it.status = "skipped"; it.auto = true; it.resolvedAt = now; out.autoSkipped++; continue; }
    if (it.amount == null) { out.leftPending++; continue; }
    const sameAmt = expenses.filter(e => !e.recurring && normM(e.merchant) === key && Math.abs(Number(e.amount) - Number(it.amount)) < 0.01);
    const hit = sameAmt.find(e => dayDiff(e.date, it.date) <= 3);
    if (hit) { it.status = "matched"; it.auto = true; it.expenseId = hit.id; it.resolvedAt = now; out.autoMatched++; continue; }
    const near = sameAmt.find(e => e.fromTemplate && dayDiff(e.date, it.date) <= 12);
    if (near) {
      near.date = it.date;
      const day = Number(it.date.slice(8, 10));
      for (const t of expenses.filter(t => t.recurring && normM(t.merchant) === key && Math.abs(Number(t.amount) - Number(it.amount)) < 0.01)) {
        let next = advanceDate(it.date, t.recurringFrequency, day), guard = 0;
        while (next <= today && guard++ < 120) next = advanceDate(next, t.recurringFrequency, day);
        t.recurringNextDue = next; t.recurringDay = day;
      }
      it.status = "accepted"; it.auto = true; it.expenseId = near.id; it.resolvedAt = now; it.note = "re-dated";
      ledgerChanged = true; out.autoRedated++; continue;
    }
    const prior = expenses.filter(e => normM(e.merchant) === key);
    if (prior.length >= 2) {
      const top = f => { const c = {}; prior.forEach(e => { const v = String(e[f]); c[v] = (c[v] || 0) + 1; }); const [val, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return { val, share: n / prior.length }; };
      const cat = top("category"), biz = top("business"), tax = top("taxDeductible"), name = top("merchant");
      if (cat.share >= 0.7 && biz.share >= 0.7) {
        const entry = {
          id: newId(), date: it.date, merchant: name.val, amount: Number(it.amount),
          note: ((it.detail || "").slice(0, 140) + " · auto-logged from Gmail receipt").trim(),
          category: cat.val, business: biz.val, taxDeductible: tax.val === "true", aiCategorized: false,
          recurring: false, recurringFrequency: null, recurringNextDue: null, recurringDay: null, fromTemplate: null
        };
        expenses.push(entry);
        it.status = "accepted"; it.auto = true; it.expenseId = entry.id; it.resolvedAt = now; it.note = "logged from history";
        ledgerChanged = true; out.autoLogged++; continue;
      }
    }
    out.leftPending++;
  }

  if (ledgerChanged) {
    // Re-read right before writing so a save from the app in the meantime is not lost.
    const fresh = await env.MM_SYNC.get("expenses");
    const freshStore = fresh ? JSON.parse(fresh) : { expenses: [] };
    const freshFingerprint = JSON.stringify((freshStore.expenses || []).map(e => e.id + ":" + e.date));
    if (freshFingerprint !== readFingerprint) {
      // The ledger moved under us: drop our changes, leave the items pending for the app to settle.
      for (const it of pending) if (it.auto && it.status === "accepted") { it.status = "pending"; delete it.auto; delete it.expenseId; delete it.resolvedAt; delete it.note; }
      out.conflict = true; out.autoRedated = 0; out.autoLogged = 0;
      return out;
    }
    store.expenses = expenses;
    await env.MM_SYNC.put("expenses", JSON.stringify(store));
    ctx.waitUntil(syncToMoxie(env, { expenses, deleted: store.deleted || [] })
      .then(r => console.log("moxie sync (inbox)", JSON.stringify(r)))
      .catch(e => console.error("moxie sync (inbox) failed", e)));
  }
  return out;
}

// ── MOXIE SYNC ──
// Pushes new Messick Marketing entries from the expenses store into Moxie, so an
// expense is logged once and lands in both. Moxie's API can create expenses but
// cannot list them, so what has been sent is tracked here in KV (moxie_sync).
//
// The first run only records a baseline: everything already dated today or
// earlier is marked as seen and nothing is sent, because those entries were
// reconciled into Moxie by hand. Future-dated entries (planned renewals, the
// first charge of a recurring template) are sent once their date arrives.
//
// Skipped on purpose: Virtueasy entries, "Stripe Fees" (they are copied FROM
// Moxie), and Contractors (Moxie records the ACH/Payoneer payment itself, and
// the app splits one payment across work items).
//
// Edits: each send records Moxie's id and a fingerprint of the fields that
// matter; when the app later saves a different fingerprint, Moxie is PATCHed.
// Deletes: Moxie has no delete endpoint, so a deleted entry that was sent goes
// on a follow-up list (KV moxie_todo) that the app shows as a banner. Entries
// sent before ids were recorded, and the 309 hand-reconciled baseline entries,
// cannot be edited automatically either; those edits go on the same list.
const MOXIE_STATE_KEY = "moxie_sync";
const MOXIE_TODO_KEY = "moxie_todo";

function moxieFingerprint(e) {
  return [e.date, Number(e.amount).toFixed(2), e.merchant || "", e.category || "", e.note || ""].join("|");
}

function moxieBody(e) {
  return {
    // Moxie wants a full timestamp; noon UTC keeps the same calendar day in US time zones.
    date: e.date + "T12:00:00Z",
    amount: Number(e.amount),
    currency: "USD",
    vendor: e.merchant,
    description: e.merchant,
    category: MOXIE_CATEGORY[e.category] || e.category,
    paid: true,
    reimbursable: false,
    // Required in practice: without it Moxie creates the expense, then fails
    // writing its response (500 "markupPercent is null").
    markupPercentage: 0,
    notes: e.note || "",
  };
}

async function addMoxieTodo(env, items) {
  if (!items.length) return;
  const raw = await env.MM_SYNC.get(MOXIE_TODO_KEY);
  let cur = { items: [] };
  if (raw) { try { cur = JSON.parse(raw) || { items: [] }; } catch (e) {} }
  if (!Array.isArray(cur.items)) cur.items = [];
  const have = new Set(cur.items.map(i => i.type + ":" + i.id + ":" + (i.fp || "")));
  for (const it of items) {
    const k = it.type + ":" + it.id + ":" + (it.fp || "");
    if (!have.has(k)) { have.add(k); cur.items.push(it); }
  }
  cur.items = cur.items.slice(-200);
  await env.MM_SYNC.put(MOXIE_TODO_KEY, JSON.stringify(cur));
}
const MOXIE_CATEGORY = { Software: "Software Subscriptions" };

// Contractor pay is matched by name too: entries sometimes land in "Other".
const CONTRACTOR_RE = /\b(rida|jacob|mutnansky|maqbool|payoneer|emelou)\b/i;

function moxieEligible(e) {
  return e && e.id && e.business === "Messick Marketing"
    && e.merchant !== "Stripe Fees" && e.category !== "Contractors"
    && !CONTRACTOR_RE.test(e.merchant || "")
    && Number(e.amount) > 0;
}

async function syncToMoxie(env, { dry, expenses: given, deleted: givenDeleted }) {
  if (!env.MOXIE_API_KEY || !env.MOXIE_BASE_URL) return { error: "MOXIE_API_KEY or MOXIE_BASE_URL secret missing" };
  let expenses = Array.isArray(given) ? given : null;
  let deleted = Array.isArray(givenDeleted) ? givenDeleted : null;
  if (!expenses || !deleted) {
    const raw = await env.MM_SYNC.get("expenses");
    const parsed = raw ? JSON.parse(raw) : {};
    if (!expenses) expenses = parsed.expenses || [];
    if (!deleted) deleted = Array.isArray(parsed.deleted) ? parsed.deleted : [];
  }
  const today = new Date().toISOString().slice(0, 10);
  const base = env.MOXIE_BASE_URL.replace(/\/+$/, "");
  const headers = { "X-API-KEY": env.MOXIE_API_KEY, "Content-Type": "application/json" };

  const stateRaw = await env.MM_SYNC.get(MOXIE_STATE_KEY);
  const state = stateRaw ? JSON.parse(stateRaw) : null;

  if (!state) {
    const seen = {};
    for (const e of expenses) if (e.id && e.date <= today) seen[e.id] = "baseline";
    if (!dry) await env.MM_SYNC.put(MOXIE_STATE_KEY, JSON.stringify({ baselineAt: today, seen }));
    return { baseline: true, marked: Object.keys(seen).length, dry: !!dry };
  }
  // moxie[id] = { moxieId, fp, todoFp?, deleteNoted? } for entries this worker sent.
  if (!state.moxie) state.moxie = {};
  const save = () => dry ? Promise.resolve() : env.MM_SYNC.put(MOXIE_STATE_KEY, JSON.stringify(state));

  // ── 1. New entries ──
  const due = expenses.filter(e => moxieEligible(e) && !state.seen[e.id] && e.date <= today);
  const sent = [], failed = [], updated = [], todo = [];
  for (const e of due) {
    const body = moxieBody(e);
    if (dry) { sent.push({ id: e.id, ...body }); continue; }
    try {
      const res = await fetch(base + "/action/expenses/create", { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) { failed.push({ id: e.id, status: res.status, error: text.slice(0, 300) }); continue; }
      let moxieId = null;
      try { moxieId = (JSON.parse(text) || {}).id || null; } catch (err) {}
      state.seen[e.id] = "sent:" + new Date().toISOString();
      state.moxie[e.id] = { moxieId, fp: moxieFingerprint(e) };
      // Save after every success so a later failure can never cause a resend.
      await save();
      sent.push({ id: e.id, moxieId, merchant: e.merchant, amount: body.amount, date: e.date });
    } catch (err) {
      failed.push({ id: e.id, error: String(err) });
    }
  }

  // ── 2. Edits to entries already sent ──
  const byId = new Map(expenses.map(e => [e.id, e]));
  for (const [id, rec] of Object.entries(state.moxie)) {
    const e = byId.get(id);
    if (!e) continue;
    const fp = moxieFingerprint(e);
    if (fp === rec.fp) continue;
    if (!rec.moxieId) {
      // Sent, but Moxie never returned an id (its 500-after-create quirk): hand it over.
      if (rec.todoFp !== fp) {
        todo.push({ type: "edit", id, fp, merchant: e.merchant, amount: e.amount, date: e.date,
          detail: "now " + e.category + (e.note ? ", " + e.note : ""), at: new Date().toISOString() });
        rec.todoFp = fp;
      }
      continue;
    }
    // The update route resolves vendor by object, not name (a string is a 500),
    // so the vendor is left alone; a renamed merchant is handed over instead.
    const { vendor, ...rest } = moxieBody(e);
    const patch = { id: rec.moxieId, ...rest };
    const prevMerchant = String(rec.fp || "").split("|")[2];
    if (prevMerchant && prevMerchant !== e.merchant && rec.todoFp !== fp) {
      todo.push({ type: "edit", id, fp, merchant: e.merchant, amount: e.amount, date: e.date,
        detail: "vendor renamed from " + prevMerchant, at: new Date().toISOString() });
      rec.todoFp = fp;
    }
    if (dry) { updated.push({ id, ...patch }); continue; }
    try {
      const res = await fetch(base + "/action/expenses/update", { method: "PATCH", headers, body: JSON.stringify(patch) });
      const text = await res.text();
      if (!res.ok) { failed.push({ id, op: "update", status: res.status, error: text.slice(0, 300) }); continue; }
      rec.fp = fp;
      await save();
      updated.push({ id, moxieId: rec.moxieId, merchant: e.merchant, amount: Number(e.amount), date: e.date });
    } catch (err) {
      failed.push({ id, op: "update", error: String(err) });
    }
  }

  // ── 3. Deletes of entries already sent: no API for it, so list them ──
  for (const d of deleted) {
    if (!d || !d.id) continue;
    const wasSent = String(state.seen[d.id] || "").startsWith("sent");
    if (!wasSent) continue;
    const rec = state.moxie[d.id] || (state.moxie[d.id] = { moxieId: null, fp: null });
    if (rec.deleteNoted) continue;
    todo.push({ type: "delete", id: d.id, merchant: d.merchant || "", amount: d.amount, date: d.date || "",
      detail: rec.moxieId ? "Moxie id " + rec.moxieId : "", at: new Date().toISOString() });
    rec.deleteNoted = true;
  }
  if (todo.length && !dry) { await addMoxieTodo(env, todo); await save(); }

  return { sent, updated, todo, failed, dry: !!dry };
}

// ── POST PREVIEWS ──
// The Stats app's top posts come from a PDF or screenshot, so they carry a caption and platform but
// no image. This finds each post in the client's Metricool analytics by caption, copies its graphic
// into KV (social CDN links expire within days) and returns a stable /pimg URL per post.
// Body: { client, start: "YYYY-MM-DD", end: "YYYY-MM-DD", posts: [{ title, platform }] }
// Returns: { brand, previews: [url|null, ...] } in the order of posts.
const MC_API = "https://app.metricool.com/api";
const MC_NETS = {
  instagram: [["posts", p => p.content, p => p.imageUrl], ["reels", p => p.content, p => p.imageUrl]],
  facebook: [["posts", p => p.text || p.message || p.content, p => p.picture || p.imageUrl], ["reels", p => p.description || p.content || p.text, p => p.thumbnailUrl || p.imageUrl]],
  linkedin: [["posts", p => p.comment || p.text, p => p.picture]],
  tiktok: [["posts", p => p.videoDescription || p.title, p => p.coverImageUrl]],
  twitter: [["posts", p => p.text, p => p.picture || p.imageUrl]],
};
const MC_FIELD = { instagram: "instagram", facebook: "facebook", linkedin: "linkedinCompany", tiktok: "tiktok", twitter: "twitter", youtube: "youtube" };

const normText = s => String(s || "").toLowerCase().replace(/https?:\S+/g, " ").replace(/#\w+/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const netOf = p => { const s = String(p || "").toLowerCase(); return /insta/.test(s) ? "instagram" : /face|fb/.test(s) ? "facebook" : /linked/.test(s) ? "linkedin" : /tik/.test(s) ? "tiktok" : /you|yt/.test(s) ? "youtube" : /twitter|^x\b|\bx$/.test(s) ? "twitter" : ""; };

async function mcGet(env, path) {
  const r = await fetch(MC_API + path, { headers: { "X-Mc-Auth": env.METRICOOL_TOKEN } });
  if (!r.ok) throw new Error(`Metricool ${path.split("?")[0]} ${r.status}`);
  return r.json();
}

// How well a report title matches a Metricool caption, 0 to 1. Report titles are usually the
// caption's opening words, sometimes cut short or lightly reworded by the extractor.
function matchScore(title, text) {
  const a = normText(title), b = normText(text);
  if (!a || !b) return 0;
  const head = a.slice(0, 40);
  if (b.startsWith(head) || b.includes(head)) return 1;
  // Fallback: share of the title's distinctive words found in the caption. Common words are
  // dropped, or any title "matches" any caption (a made-up title once scored 0.8 on filler alone).
  const aw = [...new Set(a.split(" ").filter(w => w.length > 3 && !STOP.has(w)))], bw = new Set(b.split(" "));
  if (aw.length < 4) return 0;
  return aw.filter(w => bw.has(w)).length / aw.length;
}
const STOP = new Set("about after again also because been before being both could does doing down each even every from have here into just like look made make many more most much must need only other over post posts same should since some such than that their them then there these they this those through time very want were what when where which while will with would your youre yours don't dont isnt arent cant wont".split(" "));

function pickBrand(brands, name, blogId) {
  if (blogId) return brands.find(b => String(b.id) === String(blogId)) || null;
  const want = normText(name);
  if (!want) return null;
  const wantW = want.split(" ").filter(w => w.length > 1 && !["and", "the", "of"].includes(w));
  let best = null, bestS = 0;
  for (const b of brands) {
    const lab = normText(b.label);
    const initials = lab.split(" ").filter(w => !["and", "the", "of"].includes(w)).map(w => w[0]).join("");
    let s = lab === want ? 2 : (lab.includes(want) || want.includes(lab)) ? 1.5 : want.replace(/ /g, "") === initials ? 1.2 : 0;
    if (!s && wantW.length) { const lw = new Set(lab.split(" ")); s = wantW.filter(w => lw.has(w)).length / wantW.length; }
    if (s > bestS) { best = b; bestS = s; }
  }
  return bestS >= 0.6 ? best : null;
}

async function sha1Hex(s) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)));
  return [...h].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function postPreviews(env, body, origin) {
  if (!env.METRICOOL_TOKEN) throw new Error("METRICOOL_TOKEN secret missing");
  const posts = Array.isArray(body.posts) ? body.posts.slice(0, 20) : [];
  const raw = await mcGet(env, "/admin/simpleProfiles");
  const brand = pickBrand(Array.isArray(raw) ? raw : raw.data || [], body.client, body.blogId);
  if (!brand) return { brand: null, previews: posts.map(() => null) };
  const day = 864e5, iso = d => new Date(d).toISOString().slice(0, 10);
  // Pad the window: report periods are hand-typed, and a post near the edge still belongs.
  const s = Date.parse(body.start), e = Date.parse(body.end);
  const from = iso((isNaN(s) ? Date.now() - 100 * day : s) - 7 * day), to = iso((isNaN(e) ? Date.now() : e) + 7 * day);
  const tz = encodeURIComponent(brand.timezone || "America/Chicago");
  const wanted = new Set(posts.map(p => netOf(p.platform)).filter(Boolean));
  if (!wanted.size) Object.keys(MC_FIELD).forEach(n => wanted.add(n));
  const cands = [];
  const jobs = [];
  for (const net of wanted) {
    if (!brand[MC_FIELD[net]]) continue;
    if (net === "youtube") {
      jobs.push(mcGet(env, `/stats/youtube/videos?blogId=${brand.id}&start=${from.replace(/-/g, "")}&end=${to.replace(/-/g, "")}`).then(j => {
        for (const v of (Array.isArray(j) ? j : j.data || [])) cands.push({ net, text: v.title + " " + (v.description || ""), img: (v.thumbnailUrl || "").replace("/default.", "/hqdefault.") });
      }).catch(() => {}));
      continue;
    }
    for (const [kind, txt, img] of MC_NETS[net] || []) {
      jobs.push(mcGet(env, `/v2/analytics/${kind}/${net}?blogId=${brand.id}&from=${from}T00:00:00&to=${to}T23:59:59&timezone=${tz}`).then(j => {
        for (const p of j.data || []) cands.push({ net, text: txt(p), img: img(p) });
      }).catch(() => {}));
    }
  }
  await Promise.all(jobs);
  const previews = await Promise.all(posts.map(async p => {
    const net = netOf(p.platform);
    let best = null, bestS = 0;
    for (const c of cands) {
      if (!c.img) continue;
      // Facebook only serves a 130px thumbnail, so the same cross-posted graphic from Instagram or
      // LinkedIn wins over it; otherwise the post's own network wins a tie.
      const sc = matchScore(p.title, c.text) + (net && c.net === net ? 0.05 : 0) - (/p130x130/.test(c.img) ? 0.1 : 0);
      if (sc > bestS) { best = c; bestS = sc; }
    }
    if (!best || bestS < 0.6) return null;
    const k = await sha1Hex(best.img.split("?")[0] + "|" + brand.id);
    if (!(await env.MM_SYNC.get("pimg:" + k, "arrayBuffer"))) {
      const r = await fetch(best.img);
      if (!r.ok) return null;
      const type = r.headers.get("content-type") || "image/jpeg";
      if (!/^image\//.test(type)) return null;
      await env.MM_SYNC.put("pimg:" + k, await r.arrayBuffer(), { metadata: { type } });
    }
    return `${origin}/pimg?k=${k}`;
  }));
  return { brand: brand.label, previews };
}

// ── AUTH HELPERS ──
// Token format matches messick-marketing-ai-proxy: "<expiryMs>.<base64url HMAC-SHA256(expiryMs)>".
async function isAuthorized(request, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
  if (!m) return false;
  const token = m[1];
  if (env.SYNC_ADMIN_KEY && timingSafeEq(token, env.SYNC_ADMIN_KEY)) return true;
  if (!env.DASH_TOKEN_SECRET) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  return timingSafeEq(sig, await hmacSign(env.DASH_TOKEN_SECRET, exp));
}

async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

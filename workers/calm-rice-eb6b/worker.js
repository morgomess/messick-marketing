export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

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
        ctx.waitUntil(syncToMoxie(env, {})
          .then(r => console.log("moxie sync", JSON.stringify(r)))
          .catch(e => console.error("moxie sync failed", e)));
      }

      // Mirror expenses to Google Sheet (non-blocking; a Sheet failure never breaks KV sync)
      if (key === "expenses" && env.SHEET_WEBHOOK_URL) {
        ctx.waitUntil(
          fetch(env.SHEET_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }).catch((e) => console.error("Sheet mirror failed:", e))
        );
      }

      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
const MOXIE_STATE_KEY = "moxie_sync";
const MOXIE_CATEGORY = { Software: "Software Subscriptions" };

function moxieEligible(e) {
  return e && e.id && e.business === "Messick Marketing"
    && e.merchant !== "Stripe Fees" && e.category !== "Contractors"
    && Number(e.amount) > 0;
}

async function syncToMoxie(env, { dry }) {
  if (!env.MOXIE_API_KEY || !env.MOXIE_BASE_URL) return { error: "MOXIE_API_KEY or MOXIE_BASE_URL secret missing" };
  const raw = await env.MM_SYNC.get("expenses");
  const expenses = (raw && JSON.parse(raw).expenses) || [];
  const today = new Date().toISOString().slice(0, 10);

  const stateRaw = await env.MM_SYNC.get(MOXIE_STATE_KEY);
  const state = stateRaw ? JSON.parse(stateRaw) : null;

  if (!state) {
    const seen = {};
    for (const e of expenses) if (e.id && e.date <= today) seen[e.id] = "baseline";
    if (!dry) await env.MM_SYNC.put(MOXIE_STATE_KEY, JSON.stringify({ baselineAt: today, seen }));
    return { baseline: true, marked: Object.keys(seen).length, dry: !!dry };
  }

  const due = expenses.filter(e => moxieEligible(e) && !state.seen[e.id] && e.date <= today);
  const sent = [], failed = [];
  for (const e of due) {
    const body = {
      date: e.date,
      amount: Number(e.amount),
      currency: "USD",
      vendor: e.merchant,
      description: e.merchant,
      category: MOXIE_CATEGORY[e.category] || e.category,
      paid: true,
      reimbursable: false,
      notes: e.note || "",
    };
    if (dry) { sent.push({ id: e.id, ...body }); continue; }
    try {
      const res = await fetch(env.MOXIE_BASE_URL.replace(/\/+$/, "") + "/action/expenses/create", {
        method: "POST",
        headers: { "X-API-KEY": env.MOXIE_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) { failed.push({ id: e.id, status: res.status, error: text.slice(0, 300) }); continue; }
      state.seen[e.id] = "sent:" + new Date().toISOString();
      // Save after every success so a later failure can never cause a resend.
      await env.MM_SYNC.put(MOXIE_STATE_KEY, JSON.stringify(state));
      sent.push({ id: e.id, merchant: e.merchant, amount: body.amount, date: e.date });
    } catch (err) {
      failed.push({ id: e.id, error: String(err) });
    }
  }
  return { sent, failed, dry: !!dry };
}

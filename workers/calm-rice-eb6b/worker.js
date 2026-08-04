export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

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

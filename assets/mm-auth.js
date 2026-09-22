/* Shared login for the internal tools (expenses, engagement, stats).
   The password is checked by the AI proxy worker, never held in the page. A
   successful login returns a signed token kept in localStorage "mm_auth", the
   same slot the dashboard uses, so one login covers every tool on this site.
   mmAuth.fetch adds the token to requests for the calm-rice store and proxy. */
(function () {
  var LOGIN_URL = "https://messick-marketing-ai-proxy.morgan-2bf.workers.dev/login";

  function token() {
    try {
      var a = JSON.parse(localStorage.getItem("mm_auth") || "null");
      if (a && a.t && a.exp && Date.now() < a.exp) return a.t;
    } catch (e) {}
    return null;
  }

  async function login(password) {
    var r = await fetch(LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password })
    });
    if (!r.ok) {
      throw new Error(r.status === 429 ? "Too many attempts. Try again in 15 minutes."
        : r.status === 401 ? "Incorrect password. Try again."
        : "Could not sign in. Try again.");
    }
    var b = await r.json();
    localStorage.setItem("mm_auth", JSON.stringify({ t: b.token, exp: b.exp }));
    return b.token;
  }

  function logout() { localStorage.removeItem("mm_auth"); }

  async function authFetch(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;
    var r = await fetch(url, Object.assign({}, opts, { headers: headers }));
    if (r.status === 401) { logout(); location.reload(); }
    return r;
  }

  window.mmAuth = { token: token, login: login, logout: logout, fetch: authFetch };
})();

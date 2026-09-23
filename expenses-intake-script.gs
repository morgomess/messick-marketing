// Messick Marketing — Gmail receipt intake (Apps Script)
// Runs every morning, reads receipt and charge emails from known senders, and appends
// candidate charges to the expense store's inbox. Morgan accepts or skips them in the
// expense app's Inbox tab. Nothing is written to the ledger from here.
//
// SECURITY
// - Gmail access is READ ONLY (see the manifest scopes below). The script never sends,
//   labels, moves or deletes mail.
// - The store key (INTAKE_KEY) lives in Script Properties, encrypted by Google and readable
//   only by the script owner. It is never in this file or in the repo.
// - INTAKE_KEY can only APPEND to the inbox key. The store refuses reads, replaces and every
//   other key with it. Bodies are validated server-side and capped.
// - Only merchant, amount, date, a one-line detail and a link back to the email are sent.
//   No email bodies leave Gmail.
//
// SETUP (once)
// 1. script.google.com > New project. Replace Code.gs with this file.
// 2. Project Settings (gear) > tick "Show appsscript.json manifest file in editor". Open
//    appsscript.json and replace it with expenses-intake-appsscript.json from this repo
//    (it pins the read-only Gmail scope).
// 3. Project Settings > Script properties > Add property: INTAKE_KEY = contents of
//    ~/.secrets/mm-intake-key.txt (never paste it anywhere else).
// 4. Run > setup. Approve access (Gmail read-only, external requests, triggers).
//    setup() creates the daily trigger (5 to 6am ET, before the morning brief) and does a first pull of the last 3 days.
// 5. Optional: Run > runIntake any time for a manual pull.

var STORE_URL = "https://calm-rice-eb6b.morgan-2bf.workers.dev/sync?key=expenses_inbox&append=1";
var LOOKBACK_DAYS_FIRST_RUN = 3;
var OVERLAP_DAYS = 2;   // re-scan a little; the store drops duplicates by id

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "runIntake") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("runIntake").timeBased().everyDays(1).atHour(5).create();   // 5 to 6am ET, ahead of the 6:45 morning brief
  runIntake();
}

function runIntake() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty("INTAKE_KEY");
  if (!key) throw new Error("INTAKE_KEY script property is missing");

  var last = props.getProperty("LAST_RUN");
  var since = new Date(Date.now() - (last ? OVERLAP_DAYS : LOOKBACK_DAYS_FIRST_RUN) * 86400000);
  if (last && new Date(last) < since) since = new Date(new Date(last).getTime() - OVERLAP_DAYS * 86400000);
  var after = Utilities.formatDate(since, "America/New_York", "yyyy/MM/dd");

  var items = [];
  SENDERS.forEach(function (rule) {
    var q = "from:(" + rule.from + ") after:" + after + (rule.subject ? " subject:(" + rule.subject + ")" : "");
    var threads = GmailApp.search(q, 0, 100);
    threads.forEach(function (th) {
      th.getMessages().forEach(function (msg) {
        if (msg.getDate() < since) return;
        try {
          var out = rule.parse(msg);
          if (out) (Array.isArray(out) ? out : [out]).forEach(function (it) { if (it) items.push(finish(it, msg, rule.source)); });
        } catch (e) {
          items.push(finish({ merchant: msg.getSubject().slice(0, 80), amount: firstAmount(msg.getPlainBody()), detail: "parser error: " + e.message }, msg, rule.source));
        }
      });
    });
  });

  // De-duplicate within this run (the same Google email arrives in both inboxes).
  var seen = {}, unique = [];
  items.forEach(function (it) { if (!seen[it.id]) { seen[it.id] = 1; unique.push(it); } });

  var result = { appended: 0 };
  for (var i = 0; i < unique.length; i += 150) {
    var res = UrlFetchApp.fetch(STORE_URL, {
      method: "post", contentType: "application/json",
      headers: { Authorization: "Bearer " + key },
      payload: JSON.stringify({ items: unique.slice(i, i + 150) }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw new Error("Store refused: " + res.getResponseCode() + " " + res.getContentText().slice(0, 200));
    var r = JSON.parse(res.getContentText()); result.appended += r.appended || 0;
  }
  props.setProperty("LAST_RUN", new Date().toISOString());
  Logger.log("scanned " + unique.length + " candidates since " + after + ", appended " + result.appended);
}

// ─── helpers ───
// Names the store already uses, so a candidate matches its history and its template.
var ALIASES = { "automattic": "WordPress.com", "eleven labs": "Elevenlabs", "opusclip": "Opus Clip",
  "anthropic": "Anthropic/Claude", "mailerlite": "Mailerlite Upgrade", "spotify usa": "Spotify",
  "boomerang": "Boomerang (Baydin Inc.)", "baydin": "Boomerang (Baydin Inc.)", "wispr flow": "Wispr Flow",
  "descript": "Descript AI", "openai": "Chat GPT Pro", "airtable": "Airtable", "metricool": "Metricool" };
function alias(name) {
  var k = String(name || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (var a in ALIASES) if (k === a || k.indexOf(a + " ") === 0) return ALIASES[a];
  return name;
}
function finish(it, msg, source) {
  it.merchant = alias(it.merchant);
  var d = it.date || Utilities.formatDate(msg.getDate(), "America/New_York", "yyyy-MM-dd");
  var idBase = it.id || (source + ":" + msg.getId() + (it.idx != null ? ":" + it.idx : ""));
  return {
    id: idBase.slice(0, 120),
    kind: it.kind || "expense",
    date: d,
    merchant: String(it.merchant || "").trim().slice(0, 80),
    amount: it.amount == null ? null : Math.round(Number(it.amount) * 100) / 100,
    detail: String(it.detail || "").slice(0, 200),
    lines: it.lines,
    source: source,
    msgId: msg.getId(),
    viewUrl: "https://mail.google.com/mail/#all/" + msg.getId()
  };
}
function money(s) { var m = /\$\s?([\d,]+\.\d{2})/.exec(s || ""); return m ? Number(m[1].replace(/,/g, "")) : null; }
function firstAmount(body) { return money(body); }
function usDate(s) {   // "Sep 20, 2026" or "September 20, 2026" or "09/11/2026" -> yyyy-mm-dd
  if (!s) return null;
  var m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return m[3] + "-" + pad(m[1]) + "-" + pad(m[2]);
  var d = new Date(s.replace(/(\d)(st|nd|rd|th)\b/, "$1"));
  return isNaN(d) ? null : Utilities.formatDate(d, "America/New_York", "yyyy-MM-dd");
}
function pad(n) { return ("0" + n).slice(-2); }
function grab(re, s) { var m = re.exec(s || ""); return m ? m[1].trim() : null; }

// ─── sender rules ───
// Each rule: from (Gmail from: filter), optional subject filter, parse(msg) -> item | item[] | null.
// Returning null drops the email. kind "income" marks money coming in.
var SENDERS = [
  // PayPal: "You paid $X USD to MERCHANT". Skip the vendors whose own receipt is parsed below
  // (Apple, Paddle/Localo, Upwork escrow) so a charge is not offered twice.
  { from: "service@paypal.com", source: "paypal", parse: function (msg) {
      var b = msg.getPlainBody(), subj = msg.getSubject();
      var sent = /sent you \$/.test(subj);
      if (sent) return { kind: "income", merchant: grab(/^(.*?) sent you/, subj) || "PayPal", amount: money(subj), detail: (grab(/Note from [^\n|]+\|?\s*([^\n|]{0,120})/, b) || "PayPal payment received") };
      if (/transfer|withdraw/i.test(subj)) return null;                       // her own money moving
      var merchant = grab(/You (?:paid|authorized) \$[\d,.]+ USD to (.+?)\s*\|/, b) || grab(/^(.*?):\s*\$/, subj);
      if (!merchant) return null;
      if (/apple services|paddle\.com|payment escrow/i.test(merchant)) return null;
      var item = grab(/\|\s*([^|]{3,80}?)\s*Qty:\s*\d+\s*\|/, b);
      return { merchant: merchant.replace(/,?\s*Inc\.?$/i, "").replace(/\.\.\.$/, ""), amount: money(subj) || money(b),
               date: usDate(grab(/Transaction date\s*\|\s*([A-Za-z]{3} \d{1,2}, \d{4})/, b)),
               detail: (item ? item + " · " : "") + (/authorized/i.test(b) ? "PayPal authorization (may still be pending)" : "PayPal") };
    } },
  // Apple: itemized receipt, one candidate per app.
  { from: "no_reply@email.apple.com", subject: "receipt", source: "apple", parse: function (msg) {
      var b = msg.getPlainBody();
      var date = usDate(grab(/Receipt\s*\n+\s*([A-Za-z]+ \d{1,2}, \d{4})/, b)) || null;
      var out = [], re = /\|\s*\|\s*([^|]+?)\s*\|\s*\$([\d,]+\.\d{2})\s*\|/g, m, i = 0;
      while ((m = re.exec(b))) {
        var name = m[1].replace(/\s+/g, " ").trim();
        var app = name.split(/:|\(| Monthly| 1 Week| Renews/)[0].trim();
        if (/^iCloud/i.test(app)) app = "Apple ICloud";
        if (/^AppleCare/i.test(app)) app = "Apple";
        out.push({ idx: i++, merchant: app, amount: Number(m[2].replace(/,/g, "")), date: date, detail: name.slice(0, 120) + " (via Apple)" });
      }
      return out.length ? out : { merchant: "Apple", amount: money(b), date: date, detail: "Apple receipt, items not parsed" };
    } },
  // Stripe-hosted receipts (Anthropic, ElevenLabs, OpusClip and any vendor that bills through Stripe).
  { from: "invoice+statements@mail.anthropic.com OR invoice+statements+*@stripe.com OR invoice+statements@stripe.com OR receipts+*@stripe.com", source: "stripe-receipt", parse: function (msg) {
      var b = msg.getPlainBody(), subj = msg.getSubject();
      var vendor = grab(/Your receipt from (.+?) #/, subj) || grab(/Receipt from (.+?) \$/, b) || "Stripe vendor";
      vendor = vendor.replace(/,?\s*(Inc\.?|PBC|LLC|Ltd\.?)$/i, "").trim();
      var amt = money(grab(/Receipt from .+? (\$[\d,]+\.\d{2}) Paid/, b) || "") || money(b);
      var date = usDate(grab(/Paid ([A-Za-z]+ \d{1,2}, \d{4})/, b));
      var plan = null, lre = /(?:\d{4} |^|\$[\d,.]+ (?:each )?)([A-Za-z][^$]{2,60}?) Qty [\d,]+ \$([\d,]+\.\d{2})/g, lm;
      while ((lm = lre.exec(b))) { var la = Number(lm[2].replace(/,/g, "")); if (amt == null || Math.abs(la - amt) < 0.005) plan = lm[1].trim(); }
      if (/anthropic/i.test(vendor) && /Auto-recharge/i.test(b)) vendor = "Anthropic Console";
      return { merchant: vendor, amount: amt, date: date, detail: (plan || "Stripe receipt").slice(0, 120) };
    } },
  // Google payments: Cloud auto-recharges carry the amount; Workspace invoices only announce a PDF.
  { from: "payments-noreply@google.com", source: "google", parse: function (msg) {
      var b = msg.getPlainBody(), subj = msg.getSubject();
      if (/Workspace/i.test(subj)) return { id: "google:ws:" + Utilities.formatDate(msg.getDate(), "America/New_York", "yyyy-MM"), merchant: "Google Workspace", amount: money(b), detail: "Monthly Workspace invoice (amount in the PDF if blank)" };
      var pid = grab(/Payment ID:\s*([A-Z ]*[A-Za-z0-9]+)/, b);
      var amt = money(grab(/payment amount of (\$[\d,.]+)/, b) || "");
      var forWhat = grab(/Payment for:\s*(.+?)(?:\s+Payment ID|\s+Payment method|\n|$)/, b) || "Google";
      if (!amt) return null;
      return { id: pid ? "google:" + pid.replace(/\s+/g, "") : null, merchant: /cloud/i.test(forWhat) ? "Google Cloud" : forWhat.trim(),
               amount: amt, date: usDate(grab(/received on ([A-Za-z]{3} \d{1,2}, \d{4})/, b)), detail: forWhat.trim() + (pid ? " · " + pid : "") };
    } },
  // Bluevine: ACH out (contractor pay) and money in. Card-alert emails (once enabled) fall to the generic amount.
  { from: "noreply@bluevine.com", source: "bluevine", parse: function (msg) {
      var b = msg.getPlainBody(), subj = msg.getSubject();
      if (/received a payment/i.test(subj)) return { kind: "income", merchant: "Bluevine deposit", amount: money(grab(/payment of (\$[\d,.]+)/, b) || "") || money(b), detail: "Deposit posted" };
      if (/bank transfer/i.test(subj)) return null;                            // between her own accounts
      var m = /ACH payment of \$([\d,]+\.\d{2}) to ([^\n|]+?) (?:has been scheduled|is being processed)/.exec(b);
      if (m) {
        var run = usDate(grab(/scheduled to run on (\d{2}\/\d{2}\/\d{4})/, b));
        var payee = m[2].trim().replace(/\s+/g, " ");
        var amt = Number(m[1].replace(/,/g, ""));
        return { id: "bluevine:ach:" + payee.toLowerCase().replace(/\W+/g, "") + ":" + amt + ":" + (run || Utilities.formatDate(msg.getDate(), "America/New_York", "yyyy-MM-dd")),
                 merchant: titleCase(payee), amount: amt, date: run, detail: "ACH from Bluevine Payroll" };
      }
      if (/statement|verification code|sign.?in|password/i.test(subj)) return null;
      // Debit card alerts (enabled 2026-09-23, purchases over $1). Exact wording unknown until the
      // first one lands, so anything else from Bluevine with an amount is delivered for review.
      var amt2 = money(b) || money(subj); if (!amt2) return null;
      var who = grab(/(?:purchase|transaction|charge|payment)[^.\n]{0,40}?\b(?:at|with|to|from)\s+([A-Za-z0-9][^\n|.]{2,50}?)(?:\s+(?:on|for|was|has|in)\b|[.\n|]|$)/i, b)
             || grab(/\$[\d,.]+\s+(?:at|with|to)\s+([A-Za-z0-9][^\n|.]{2,50}?)(?:\s+(?:on|for|was|has|in)\b|[.\n|]|$)/i, b);
      return { merchant: (who || subj).replace(/\s+/g, " ").trim().slice(0, 60), amount: amt2,
               date: usDate(grab(/\b(\d{2}\/\d{2}\/\d{4})\b/, b) || grab(/\b([A-Za-z]{3,9} \d{1,2}, \d{4})\b/, b)),
               detail: "Bluevine alert: " + subj.slice(0, 100) };
    } },
  // Payoneer: Rida's payments.
  { from: "NoReply@payoneer.com", subject: "Thanks for your payment", source: "payoneer", parse: function (msg) {
      var b = msg.getPlainBody();
      var amt = money(grab(/Amount\s*([\d,]+\.\d{2}) USD/, b) ? "$" + grab(/Amount\s*([\d,]+\.\d{2}) USD/, b) : "");
      var to = grab(/payment to ([^\s]+@[^\s]+)/, msg.getSubject()) || "";
      var pid = grab(/Payment ID\s*(\d+)/, b);
      return { id: pid ? "payoneer:" + pid : null, merchant: /rida/i.test(to) ? "Rida Maqbool" : "Payoneer to " + to, amount: amt, detail: "Payoneer payment" + (pid ? " " + pid : "") };
    } },
  // Vendors with their own receipt emails.
  { from: "no-reply@account.canva.com", subject: "invoice", source: "canva", parse: function (msg) {
      var b = msg.getPlainBody(); return { merchant: "Canva", amount: money(grab(/Charged:\s*(\$[\d,.]+)/, b) || "") || money(b), date: usDate(grab(/Date of Issue\s*\n?\s*([A-Za-z]{3} \d{1,2}, \d{4})/, b)), detail: grab(/Item Team Members Amount\s*\n?\s*([^\n]+)/, b) || "Canva invoice" };
    } },
  { from: "help@paddle.com", subject: "receipt", source: "paddle", parse: function (msg) {
      var b = msg.getPlainBody(), subj = msg.getSubject();
      return { merchant: grab(/Your (.+?) receipt/, subj) || "Paddle vendor", amount: money(grab(/Amount Paid\s*(\$[\d,.]+)/, b) || "") || money(b), date: usDate(grab(/Receipt Date\s*([0-9]{1,2}(?:st|nd|rd|th)? [A-Za-z]+ \d{4})/, b)), detail: grab(/Payment Method\s*([^\n$]+)/, b) || "Paddle receipt" };
    } },
  { from: "billing@withmoxie.com", source: "moxie", parse: function (msg) {
      var b = msg.getPlainBody(); return { merchant: "Moxie", amount: money(b), detail: "Moxie subscription" + (grab(/Invoice #(\d+)/, b) ? " invoice #" + grab(/Invoice #(\d+)/, b) : "") };
    } },
  { from: "donotreply@upwork.com", subject: "Payment Received", source: "upwork", parse: function (msg) {
      var b = msg.getPlainBody(); return { merchant: "Upwork", amount: money(grab(/payment of (\$[\d,.]+)/, b) || "") || money(b), detail: "Upwork payment applied (contractor hours)" };
    } },
  { from: "no-reply@2book.com OR no-reply@appmail.2book.com OR petparadise@mailgun.gingrapp.com OR receipts@email.discounttire.com", source: "other-receipt", parse: function (msg) {
      var b = msg.getPlainBody(); return { merchant: (grab(/Receipt from (.+)/, msg.getSubject()) || grab(/Invoice From (.+?) for/, msg.getSubject()) || msg.getSubject()).slice(0, 60), amount: money(b) || money(msg.getSubject()), detail: "Receipt email (likely personal)" };
    } },
  { from: "no.reply.alerts@chase.com", subject: "transaction", source: "chase", parse: function (msg) {
      var b = msg.getPlainBody(); var amt = money(b); if (!amt) return null;
      return { merchant: grab(/transaction of \$[\d,.]+ with ([^\n|]+?) Account/, b) || "Chase card charge", amount: amt, date: usDate(grab(/Made on ([A-Za-z]{3} \d{1,2}, \d{4})/, b)), detail: "Chase debit card alert" };
    } },
  { from: "auto-confirm@amazon.com", subject: "Ordered", source: "amazon", parse: function (msg) {
      var b = msg.getPlainBody(); return { merchant: "Amazon", amount: money(grab(/Grand Total:\s*([\d,.]+ USD)/, b) ? "$" + grab(/Grand Total:\s*([\d,.]+) USD/, b) : "") || money(b), detail: msg.getSubject().slice(0, 100) + (grab(/Order #\s*\n?\s*([\d-]+)/, b) ? " · order " + grab(/Order #\s*\n?\s*([\d-]+)/, b) : "") };
    } },
  // Income: client payments (kept for the income layer, shown read-only in the app).
  { from: "notifications@stripe.com", subject: "Payment of", source: "stripe-income", parse: function (msg) {
      var subj = msg.getSubject(); var b = msg.getPlainBody();
      return { kind: "income", merchant: grab(/from ([^\s]+) for/, subj) || "Stripe payment", amount: money(subj), detail: grab(/Invoice ([A-Z0-9.-]+)/, b) ? "Invoice " + grab(/Invoice ([A-Z0-9.-]+)/, b) : "Stripe payment" };
    } },
  { from: "communications@ramp.com", subject: "Payment received", source: "ramp-income", parse: function (msg) {
      var subj = msg.getSubject(); return { kind: "income", merchant: grab(/from (.+)$/, subj) || "Ramp payment", amount: money(msg.getPlainBody()), detail: grab(/Payment received: ([A-Z0-9.-]+)/, subj) || "Ramp payment" };
    } }
];

function titleCase(s) { return s.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

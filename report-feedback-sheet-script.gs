// Messick Marketing — Client Report Feedback + Shared Report Store
// One Apps Script web app that: (a) receives report-page feedback (Sheet + email),
// (b) stores shared-report payloads so share links can be short (?r=<id>),
// (c) serves feedback to the internal viewer (key-gated) and reports publicly by id.
//
// SETUP: create a Google Sheet > Extensions > Apps Script > paste this > set READ_KEY
// below to your own secret > Deploy > New deployment > Web app (Execute as: Me,
// Who has access: Anyone). Re-deploy a NEW VERSION whenever you change this file.

const SHEET_NAME    = "Report Feedback";
const REPORTS_SHEET = "Reports";
const NOTIFY_EMAIL  = "morgan@messickmarketing.com";
// Reading ALL feedback (doGet) requires this key — only the internal viewer sends it.
// Shared reports (?r=<id>) are public by design. Set your own secret; don't publish it.
const READ_KEY      = "PASTE_A_SECRET_READ_KEY_HERE";
const COLUMNS = ["timestamp", "clientSlug", "clientName", "rating", "message", "page"];

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}
function getReportSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REPORTS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(REPORTS_SHEET);
    sheet.appendRow(["id", "data", "createdAt"]);
    sheet.getRange(1, 1, 1, 3).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doPost(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  if (p.action === "report") return saveReport(p);   // store a shared-report payload
  return saveFeedback(p);                              // otherwise it's report feedback
}

// Save a shared report payload keyed by id (upsert). Lets share links stay short.
function saveReport(p) {
  try {
    if (!p.id || !p.data) return json({ ok: false, error: "missing id/data" });
    const sh = getReportSheet();
    const last = sh.getLastRow();
    let rowIdx = -1;
    if (last >= 1) {
      const ids = sh.getRange(1, 1, last, 1).getValues();
      for (let i = 0; i < ids.length; i++) { if (ids[i][0] === p.id) { rowIdx = i + 1; break; } }
    }
    if (rowIdx > 0) sh.getRange(rowIdx, 2).setValue(p.data);
    else sh.appendRow([p.id, p.data, new Date()]);
    return json({ ok: true, id: p.id });
  } catch (err) { return json({ ok: false, error: err.message }); }
}

function saveFeedback(p) {
  try {
    // Honeypot: bots fill "company_url"; accept but drop.
    if (p.company_url || p._honey) return json({ ok: true, skipped: "honeypot" });

    const row = {
      timestamp:  new Date(),
      clientSlug: p.client_slug || "",
      clientName: p.client_name || "",
      rating:     p.rating || "",
      message:    p.message || "",
      page:       p.page || ""
    };
    getSheet().appendRow(COLUMNS.map(c => row[c] || ""));

    try {
      const who = row.clientName || row.clientSlug || "a client";
      MailApp.sendEmail(NOTIFY_EMAIL, "Report feedback — " + who, [
        "Client: " + (row.clientName || "(unknown)") + "  [" + row.clientSlug + "]",
        "Rating: " + (row.rating || "(none)"), "",
        "Message:", row.message || "(no message)", "",
        "Page: " + row.page, "Time: " + row.timestamp
      ].join("\n"));
    } catch (mailErr) { /* row already saved */ }

    return json({ ok: true });
  } catch (err) { return json({ ok: false, error: err.message }); }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const cb = p.callback;
  const wrap = (obj) => cb
    ? ContentService.createTextOutput(cb + "(" + JSON.stringify(obj) + ")").setMimeType(ContentService.MimeType.JAVASCRIPT)
    : json(obj);

  // Public: fetch ONE shared report by id (these links are meant to be shared).
  if (p.report) {
    const sh = getReportSheet();
    const last = sh.getLastRow();
    let found = null;
    if (last >= 1) {
      const rows = sh.getRange(1, 1, last, 2).getValues();
      for (let i = 0; i < rows.length; i++) { if (rows[i][0] === p.report) found = rows[i][1]; }
    }
    if (!found) return wrap({ error: "not found" });
    try { return wrap(JSON.parse(found)); } catch (e2) { return wrap({ error: "bad data" }); }
  }

  // Gated: ALL feedback (internal viewer only).
  if (p.key !== READ_KEY) return wrap({ error: "unauthorized" });
  const data = getSheet().getDataRange().getValues();
  let rows = [];
  if (data.length > 1) {
    const headers = data[0];
    rows = data.slice(1).map(r => { const o = {}; headers.forEach((h, i) => o[h] = r[i]); return o; });
  }
  return wrap(rows);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

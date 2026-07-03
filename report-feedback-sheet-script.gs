// Messick Marketing — Client Report Feedback (Google Sheet + email notification)
// Collects feedback submitted from the standalone quarterly client report pages.
//
// SETUP (one time):
//   1. Create a Google Sheet (or open an existing one).
//   2. Extensions > Apps Script, paste this file, save.
//   3. Set NOTIFY_EMAIL below to where you want notifications.
//   4. Deploy > New deployment > type "Web app":
//        Execute as: Me    |    Who has access: Anyone
//      Copy the /exec Web App URL — that is the [FORM ENDPOINT URL] you paste
//      into each report page's feedback form.
//   5. Re-deploy (Manage deployments > edit > new version) whenever you change this file.

const SHEET_NAME   = "Report Feedback";
const NOTIFY_EMAIL = "morgan@messickmarketing.com";
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

// POST from a report page's feedback form (sent as FormData / form-encoded fields).
function doPost(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};

    // Honeypot: humans never see the "company_url" field. If it's filled, it's a bot —
    // return ok so the bot thinks it worked, but don't save or email.
    if (p.company_url || p._honey) {
      return json({ ok: true, skipped: "honeypot" });
    }

    const row = {
      timestamp:  new Date(),
      clientSlug: p.client_slug || "",
      clientName: p.client_name || "",
      rating:     p.rating || "",
      message:    p.message || "",
      page:       p.page || ""
    };

    getSheet().appendRow(COLUMNS.map(c => row[c] || ""));

    // Email notification (sheet write already succeeded even if this fails).
    try {
      const who = row.clientName || row.clientSlug || "a client";
      const subject = "Report feedback — " + who;
      const body = [
        "Client: " + (row.clientName || "(unknown)") + "  [" + row.clientSlug + "]",
        "Rating: " + (row.rating || "(none)"),
        "",
        "Message:",
        row.message || "(no message)",
        "",
        "Page: " + row.page,
        "Time: " + row.timestamp
      ].join("\n");
      MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
    } catch (mailErr) { /* ignore — the row is already saved */ }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

// GET → return all feedback. Supports JSONP (?callback=fn) so the internal viewer
// can read it cross-origin from the messickmarketing.com pages (Apps Script sends
// no CORS headers, so a plain fetch would be blocked; JSONP via <script> is not).
function doGet(e) {
  const data = getSheet().getDataRange().getValues();
  let rows = [];
  if (data.length > 1) {
    const headers = data[0];
    rows = data.slice(1).map(r => {
      const o = {}; headers.forEach((h, i) => o[h] = r[i]); return o;
    });
  }
  const cb = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService.createTextOutput(cb + "(" + JSON.stringify(rows) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json(rows);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

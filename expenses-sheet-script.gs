// Messick Marketing — Expenses Google Sheet (pull)
// Pulls the expense app's data from the calm-rice store every hour and rewrites
// the "App Sync" tab, in the same layout the old push script wrote. The old push
// web app was domain-restricted, so the store's anonymous pushes never landed.
//
// SETUP (once):
// 1. In the expenses Sheet: Extensions > Apps Script. Replace ALL the code with this file.
// 2. Project Settings (gear) > Script properties > Add property:
//      STORE_KEY = the contents of ~/.secrets/mm-sheet-read-key.txt
//    That key can only READ expenses; it cannot change anything.
// 3. Back in the editor, pick "setup" in the function dropdown and click Run. Approve access.
// 4. Deploy > Manage deployments > archive the old web app deployment, so its link stops working.

const STORE_URL  = "https://calm-rice-eb6b.morgan-2bf.workers.dev/sync?key=expenses";
const SHEET_NAME = "App Sync";

function pullExpenses() {
  const key = PropertiesService.getScriptProperties().getProperty("STORE_KEY");
  if (!key) throw new Error("Add the STORE_KEY script property first (see SETUP).");

  const res = UrlFetchApp.fetch(STORE_URL, {
    headers: { Authorization: "Bearer " + key },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("Store returned HTTP " + res.getResponseCode());
  }
  const expenses = (JSON.parse(res.getContentText()) || {}).expenses;
  // Never wipe the sheet on an empty or malformed read.
  if (!Array.isArray(expenses) || expenses.length === 0) return;

  const header = ["Date", "Purchase Description", "Cost", "Merchant", "Category", "Business", "Tax Deductible", "Recurring"];
  const rows = expenses.map(x => [
    fmtDate(x.date),
    x.note || x.category || "",
    Number(x.amount) || 0,
    x.merchant || "",
    x.category || "",
    x.business || "",
    x.taxDeductible ? "Yes" : "",
    x.recurring ? (x.recurringFrequency || "Yes") : ""
  ]);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  sh.getRange(2, 1, rows.length, header.length).setValues(rows);
}

// "2026-09-22" -> "9/22/2026", matching the old push script.
function fmtDate(d) {
  if (!d) return "";
  const p = String(d).split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}/${p[0]}` : String(d);
}

// Run once: creates the hourly trigger (replacing any old one) and does a first pull.
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "pullExpenses")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("pullExpenses").timeBased().everyHours(1).create();
  pullExpenses();
}

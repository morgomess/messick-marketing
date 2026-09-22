// Messick Marketing — Expenses Google Sheet (pull)
// Pulls the expense app's data from the calm-rice store every hour and rewrites
// the "Expenses" tab. Replaces the old push web app, which was domain-restricted
// so the store's anonymous pushes never landed.
//
// SETUP (once):
// 1. In the expenses Sheet: Extensions > Apps Script. Replace ALL the code with this file.
// 2. Project Settings (gear) > Script properties > Add property:
//      STORE_KEY = the contents of ~/.secrets/mm-sheet-read-key.txt
//    That key can only READ expenses; it cannot change anything.
// 3. Back in the editor, pick "setup" in the function dropdown and click Run. Approve access.
// 4. Deploy > Manage deployments > archive the old web app deployment, so its link stops working.

const STORE_URL  = "https://calm-rice-eb6b.morgan-2bf.workers.dev/sync?key=expenses";
const SHEET_NAME = "Expenses";
const COLUMNS    = ["date", "merchant", "amount", "category", "business", "taxDeductible", "recurring", "note", "id"];

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

  expenses.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const rows = expenses.map(e => COLUMNS.map(c => {
    const v = e[c];
    if (c === "amount") return Number(v) || 0;
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return v == null ? "" : v;
  }));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  sheet.getRange(2, 1, rows.length, COLUMNS.length).setValues(rows);
  sheet.getRange(2, 3, rows.length, 1).setNumberFormat("$#,##0.00");
}

// Run once: creates the hourly trigger (replacing any old one) and does a first pull.
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "pullExpenses")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("pullExpenses").timeBased().everyHours(1).create();
  pullExpenses();
}

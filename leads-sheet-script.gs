// Messick Marketing — Leads Google Sheets Sync
// Deploy as Web App: Execute as "Me", Access "Anyone"

const SHEET_NAME = "Leads";
const COLUMNS = ["id","practiceName","website","location","email","status","savedAt","pitchSnapshot"];

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight("bold");
  }
  return sheet;
}

// GET → return all leads as JSON
function doGet() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return ContentService
      .createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const headers = data[0];
  const leads = data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return ContentService
    .createTextOutput(JSON.stringify(leads))
    .setMimeType(ContentService.MimeType.JSON);
}

// POST → overwrite sheet with incoming leads array
function doPost(e) {
  try {
    const raw = (e.parameter && e.parameter.data) ? e.parameter.data : e.postData.contents;
    const leads = JSON.parse(raw);
    const sheet = getSheet();

    // Clear all rows except header
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

    // Write each lead
    if (Array.isArray(leads) && leads.length > 0) {
      const rows = leads.map(l => COLUMNS.map(col => l[col] || ""));
      sheet.getRange(2, 1, rows.length, COLUMNS.length).setValues(rows);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

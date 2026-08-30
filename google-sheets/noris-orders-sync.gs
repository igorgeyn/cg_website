const NORIS_EXPORT_URL = "https://csdsctyejlplcspvviys.supabase.co/functions/v1/export-orders";
const NORIS_SHEET_NAME = "Orders";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Nori's Orders")
    .addItem("Configure connection", "configureNorisOrders")
    .addItem("Refresh now", "syncNorisOrders")
    .addSeparator()
    .addItem("Enable hourly refresh", "enableHourlyNorisSync")
    .addItem("Disable automatic refresh", "disableAutomaticNorisSync")
    .addToUi();
}

function configureNorisOrders() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "Connect Nori's Orders",
    "Paste the private export key, then select OK.",
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const key = response.getResponseText().trim();
  if (!key) throw new Error("The export key cannot be blank.");
  PropertiesService.getScriptProperties().setProperty("NORI_ORDERS_EXPORT_KEY", key);
  syncNorisOrders();
}

function syncNorisOrders() {
  const key = PropertiesService.getScriptProperties().getProperty("NORI_ORDERS_EXPORT_KEY");
  if (!key) throw new Error("Use Nori's Orders → Configure connection before refreshing.");

  const response = UrlFetchApp.fetch(NORIS_EXPORT_URL, {
    method: "get",
    headers: { "x-export-key": key },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error(`Order refresh failed (${response.getResponseCode()}): ${response.getContentText()}`);
  }

  const payload = JSON.parse(response.getContentText());
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(NORIS_SHEET_NAME) || spreadsheet.insertSheet(NORIS_SHEET_NAME);
  const filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clearContents();
  sheet.clearFormats();

  const values = [payload.headers, ...payload.rows];
  sheet.getRange(1, 1, values.length, payload.headers.length).setValues(values);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, payload.headers.length)
    .setBackground("#14513b")
    .setFontColor("#ffffff")
    .setFontWeight("bold")
    .setWrap(true);
  if (payload.rows.length) {
    sheet.getRange(1, 1, values.length, payload.headers.length).createFilter();
    sheet.getRange(2, 17, payload.rows.length, 3).setNumberFormat("$0.00");
    sheet.getRange(2, 2, payload.rows.length, 1).setNumberFormat("m/d/yyyy h:mm am/pm");
    sheet.getRange(2, 24, payload.rows.length, 1).setNumberFormat("m/d/yyyy");
  }
  sheet.autoResizeColumns(1, payload.headers.length);
  for (let column = 1; column <= payload.headers.length; column += 1) {
    if (sheet.getColumnWidth(column) > 260) sheet.setColumnWidth(column, 260);
  }
  sheet.getRange("A1").setNote(`Last refreshed ${payload.generated_at}; ${payload.count} order(s).`);
}

function enableHourlyNorisSync() {
  disableAutomaticNorisSync(false);
  ScriptApp.newTrigger("syncNorisOrders").timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert("Hourly order refresh is enabled.");
}

function disableAutomaticNorisSync(showConfirmation = true) {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === "syncNorisOrders")
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  if (showConfirmation) SpreadsheetApp.getUi().alert("Automatic order refresh is disabled.");
}

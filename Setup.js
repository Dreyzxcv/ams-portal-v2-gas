/**
 * Setup.gs - repeatable provisioning. Run from the Apps Script editor:
 *   1. setup()            creates the spreadsheet, Drive folder, secrets, seed data
 *   2. createFirstAdmin() after filling ADMIN_USERNAME / ADMIN_NAME / ADMIN_EMAIL script properties
 *   3. installTriggers()  quiz auto-submit + cleanup jobs
 *   upgradeSchema() is safe to re-run after code updates; integrityCheck() reports orphans.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('HMAC_SECRET')) props.setProperty('HMAC_SECRET', U.randomHex(64));
  var id = props.getProperty('SPREADSHEET_ID'), ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create('AMS Portal Data'); props.setProperty('SPREADSHEET_ID', ss.getId()); }
  Repo.resetAll();
  upgradeSchema();
  if (!props.getProperty('DRIVE_FOLDER_ID')) {
    var f = DriveApp.createFolder('AMS Portal - Certificates (private)');
    f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    props.setProperty('DRIVE_FOLDER_ID', f.getId());
  }
  Repo.withLock(function () {
    if (!Repo.all('grade_components').length) {
      Repo.insertMany('grade_components', GRADE_COMPONENT_SEED.map(function (c) { return Object.assign({ active: true }, c); }));
    }
    var m = Repo.find('meta', 'schema_version');
    if (!m) Repo.insert('meta', { key: 'schema_version', value: String(SCHEMA_VERSION) });
    else Repo.update('meta', 'schema_version', { value: String(SCHEMA_VERSION) });
  });
  Logger.log('Spreadsheet: ' + ss.getUrl());
  Logger.log('Drive folder id: ' + props.getProperty('DRIVE_FOLDER_ID'));
  return ss.getUrl();
}

/** Creates missing worksheets and appends missing columns (never drops or reorders data). */
function upgradeSchema() {
  var ss = Repo.spreadsheet();
  Object.keys(SCHEMA).forEach(function (name) {
    var def = SCHEMA[name], sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); }
    var width = def.cols.length;
    if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    var existing = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].filter(String) : [];
    if (!existing.length) sh.getRange(1, 1, 1, width).setValues([def.cols]);
    else {
      for (var i = 0; i < existing.length; i++) if (existing[i] !== def.cols[i]) throw new Error('Column mismatch in ' + name + ' at position ' + (i + 1) + ': found "' + existing[i] + '", expected "' + def.cols[i] + '". Fix manually before upgrading.');
      if (existing.length < width) sh.getRange(1, existing.length + 1, 1, width - existing.length).setValues([def.cols.slice(existing.length)]);
    }
    sh.getRange(1, 1, sh.getMaxRows(), width).setNumberFormat('@');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#ecfdf5');
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  Repo.resetAll();
}

function createFirstAdmin() {
  var props = PropertiesService.getScriptProperties();
  var username = props.getProperty('ADMIN_USERNAME'), name = props.getProperty('ADMIN_NAME'), email = props.getProperty('ADMIN_EMAIL');
  if (!username || !name) throw new Error('Set ADMIN_USERNAME and ADMIN_NAME (and optionally ADMIN_EMAIL) in Project Settings > Script properties first.');
  var res = Repo.withLock(function () {
    var admin = { id: 'admin', name: name, role: ROLE.ADMIN, status: USER_STATUS.ACTIVE, username: username.toLowerCase(), email: email || null };
    return Users.create({ user: admin }, { name: name, username: username, email: email || '', role: ROLE.ADMIN }, true);
  });
  props.deleteProperty('ADMIN_USERNAME'); props.deleteProperty('ADMIN_NAME'); props.deleteProperty('ADMIN_EMAIL');
  Logger.log('Admin created. Username: ' + res.credentials.username + '  Temporary password: ' + res.credentials.password + '  (you must change it at first login; this is shown only once)');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['jobSubmitExpiredQuizAttempts', 'jobCleanup'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('jobSubmitExpiredQuizAttempts').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('jobCleanup').timeBased().everyHours(6).create();
}

/** Orphaned references and duplicate checks. Run from the editor; results go to the log. */
function integrityCheck() {
  Repo.resetAll();
  var problems = [];
  FOREIGN_KEYS.forEach(function (fk) {
    var idx = Repo.index(fk[2], SCHEMA[fk[2]].pk);
    Repo.all(fk[0]).forEach(function (r) { if (r[fk[1]] && !idx[r[fk[1]]]) problems.push(fk[0] + '.' + fk[1] + ' -> missing ' + fk[2] + ' ' + r[fk[1]]); });
  });
  var seen = {};
  Repo.all('grade_records').forEach(function (r) { var k = r.trainee_id + '|' + r.component_id; if (seen[k]) problems.push('duplicate grade record ' + k); seen[k] = 1; });
  var active = {};
  Repo.all('batch_assignments').forEach(function (a) { if (!a.unassigned_at) { if (active[a.user_id]) problems.push('trainee ' + a.user_id + ' has multiple active batches'); active[a.user_id] = 1; } });
  var names = {};
  Repo.all('users').forEach(function (u) { var k = (u.username || '').toLowerCase(); if (k && names[k]) problems.push('duplicate username ' + k); names[k] = 1; });
  Logger.log(problems.length ? problems.join('\n') : 'No integrity problems found.');
  return problems;
}

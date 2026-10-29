/**
 * MigrationService.gs - one-time import of data exported from the old PostgreSQL database.
 *
 * Export each table as JSON (see docs/DEPLOYMENT.md), merge into ONE JSON file in Drive:
 *   { users:[], batches:[], batch_assignments:[], grade_records:[], violations:[], trainee_progress:[],
 *     chain_of_command_entries:[], announcements:[], intake_settings:[] }
 * Old numeric ids are kept in legacy_id columns and remapped to new string ids.
 *
 * What cannot be migrated: password hashes (bcrypt, not verifiable here) -> every user gets a new temporary
 * password, written to a private Drive file; certificate PDFs/images (re-upload them); quiz data and audit logs
 * (not imported by design - archive the old DB for those).
 *
 * Safety: refuses to run unless backupConfirmed is true and the users sheet only holds the bootstrap admin
 * (or is empty). It never deletes or overwrites existing rows.
 */
function migrateLegacyData(fileId, options) {
  options = options || {};
  if (options.backupConfirmed !== true) throw new Error('Set options.backupConfirmed = true after backing up the spreadsheet (File > Make a copy) and the source database.');
  var raw = JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString());
  var report = { imported: {}, skipped: [], credentials_file: null };
  return Repo.withLock(function () {
    var existing = Repo.all('users').filter(function (u) { return !(options.keepUsernames || []).concat(['admin']).some(function (n) { return n === u.username; }) && u.role !== ROLE.ADMIN; });
    if (existing.length) throw new Error('Users already exist besides admins. Migration refuses to merge into a populated database.');
    var map = { users: {}, batches: {}, comps: {} };
    Repo.all('grade_components').forEach(function (c) { map.comps[c.key] = c.id; });
    var existingNames = {}; Repo.all('users').forEach(function (u) { existingNames[(u.username || '').toLowerCase()] = true; });
    var creds = ['username,temporary_password'], n = 0;

    (raw.users || []).forEach(function (u) {
      var uname = String(u.username || '').toLowerCase().trim();
      if (!ROLE_LABELS[u.role] || !/^[a-z0-9._-]{3,50}$/.test(uname)) { report.skipped.push('user ' + u.id + ': invalid role/username'); return; }
      if (existingNames[uname]) { report.skipped.push('user ' + u.id + ': username already exists'); return; }
      var status = [USER_STATUS.ACTIVE, USER_STATUS.INACTIVE, USER_STATUS.SUSPENDED].indexOf(u.status) !== -1 ? u.status : USER_STATUS.ACTIVE;
      var rec = Repo.insert('users', { name: String(u.name || uname).slice(0, 255), username: uname, email: u.email ? String(u.email).toLowerCase() : null, role: u.role, status: status,
        email_verified_at: u.email_verified_at || null, force_password_change: true, password_hash: '', password_salt: '', legacy_id: String(u.id), created_at: u.created_at || U.nowIso() });
      var temp = U.randomPassword(16); Auth.setPassword(rec.id, temp, true);
      if (rec.role === ROLE.TRAINEE) Users.ensureTraineeProfile_(rec);
      map.users[String(u.id)] = rec.id; existingNames[uname] = true; creds.push(uname + ',' + temp); n++;
    });
    report.imported.users = n;

    n = 0; (raw.batches || []).forEach(function (b) {
      var rec = Repo.insert('batches', { legacy_id: String(b.id), name: String(b.name).slice(0, 100), starts_on: b.starts_on || null, ends_on: b.ends_on || null });
      map.batches[String(b.id)] = rec.id; n++;
    }); report.imported.batches = n;

    n = 0; (raw.batch_assignments || []).forEach(function (a) {
      var bid = map.batches[String(a.batch_id)], uid = map.users[String(a.user_id)];
      if (!bid || !uid) { report.skipped.push('assignment ' + a.id + ': unknown batch/user'); return; }
      Repo.insert('batch_assignments', { batch_id: bid, user_id: uid, assigned_at: a.assigned_at || U.nowIso(), unassigned_at: a.unassigned_at || null }); n++;
    }); report.imported.batch_assignments = n;

    n = 0; var seen = {}; (raw.grade_records || []).forEach(function (g) {
      var uid = map.users[String(g.trainee_id)], cid = map.comps[g.grade_component_key], k = uid + '|' + cid;
      if (!uid || !cid || seen[k] || g.score === null || g.score === undefined) { report.skipped.push('grade ' + g.id + ': unknown trainee/component, duplicate or empty'); return; }
      seen[k] = 1; Repo.insert('grade_records', { trainee_id: uid, component_id: cid, score: U.round2(g.score), graded_by: map.users[String(g.graded_by)] || null, graded_at: g.graded_at || null }); n++;
    }); report.imported.grade_records = n;

    n = 0; (raw.violations || []).forEach(function (v) {
      var uid = map.users[String(v.trainee_id)]; if (!uid) { report.skipped.push('violation ' + v.id + ': unknown trainee'); return; }
      var issuer = v.issued_by ? Repo.find('users', map.users[String(v.issued_by)]) : null;
      Repo.insert('violations', { legacy_id: String(v.id), trainee_id: uid, issued_by: issuer ? issuer.id : null, issued_by_name: issuer ? issuer.name : (v.issued_by_name || null),
        occurred_on: v.occurred_on, description: String(v.description || '').slice(0, 2000), created_at: v.created_at || U.nowIso(), deleted_at: v.deleted_at || null }); n++;
    }); report.imported.violations = n;

    n = 0; (raw.trainee_progress || []).forEach(function (p) {
      var uid = map.users[String(p.trainee_id)]; if (!uid || Repo.find('trainee_progress', uid)) return;
      Repo.insert('trainee_progress', { trainee_id: uid, current_phase: Math.min(Math.max(parseInt(p.current_phase, 10) || 1, 1), Config.getInt('MAX_PHASE') || 4), started_on: p.started_on || null }); n++;
    }); report.imported.trainee_progress = n;

    n = 0; (raw.chain_of_command_entries || []).forEach(function (e) {
      Repo.insert('chain_of_command_entries', { legacy_id: String(e.id), name: e.name, rank: e.rank, position: e.position, note: e.note || null, image_url: e.image_url || null, sort_order: parseInt(e.sort_order, 10) || 0 }); n++;
    }); report.imported.chain_of_command_entries = n;

    n = 0; (raw.announcements || []).forEach(function (a) {
      Repo.insert('announcements', { recipient: a.recipient, sender: a.sender, subject: a.subject, body: a.body, signature: a.signature, published_at: a.published_at || null, pinned_at: a.pinned_at || null,
        discord_status: a.published_at ? DISCORD.SENT : DISCORD.NOT_SENT }); n++;   // imported as already-sent so nothing is re-posted to Discord
    }); report.imported.announcements = n;

    var intake = (raw.intake_settings || [])[0];
    if (intake && ['open', 'closed'].indexOf(intake.status) !== -1 && !Repo.find('intake_settings', '1')) { Repo.insert('intake_settings', { id: '1', status: intake.status }); report.imported.intake_settings = 1; }

    var f = DriveApp.createFile('AMS migration credentials ' + U.nowIso().slice(0, 10) + '.csv', creds.join('\n'));
    report.credentials_file = f.getId();
    Audit.record('migration.completed', null, 'system', 'legacy-import', { counts: report.imported, skipped: report.skipped.length });
    Logger.log(JSON.stringify(report, null, 1));
    return report;
  });
}

/**
 * Repo.gs - SpreadsheetRepository: the only place that touches Sheets.
 *
 * - One worksheet per table; row 1 = header; every cell is plain text (see Schema.gs).
 * - Reads are one batched getValues() per table per execution (memoized).
 * - Writes are one setValues() per record (or one per table for bulk updates).
 * - Mutations must run inside Repo.withLock() (the API router does this) so the
 *   memo is fresh and read-modify-write sequences are serialized.
 * - Hard limits (documented): Sheets has no transactions, FKs or unique indexes;
 *   the services enforce them under the script lock.
 */
var Repo = (function () {
  var memo = {}, ssRef = null, sheets = {}, lockDepth = 0;

  function ss() {
    if (!ssRef) {
      var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
      if (!id) throw new Error('SPREADSHEET_ID is not configured. Run setup() first.');
      ssRef = SpreadsheetApp.openById(id);
    }
    return ssRef;
  }
  function sheet(name) {
    if (!sheets[name]) {
      var sh = ss().getSheetByName(name);
      if (!sh) throw new Error('Missing worksheet "' + name + '". Run upgradeSchema().');
      sheets[name] = sh;
    }
    return sheets[name];
  }
  function def(name) { var d = SCHEMA[name]; if (!d) throw new Error('Unknown table ' + name); return d; }

  function fromCell(v, type) {
    if (v === '' || v === null || v === undefined) return null;
    if (v instanceof Date) v = v.toISOString();
    switch (type) {
      case 'i': var n = parseInt(v, 10); return isNaN(n) ? null : n;
      case 'n': var f = parseFloat(v); return isNaN(f) ? null : f;
      case 'b': return v === true || String(v).toLowerCase() === 'true';
      case 'j': try { return JSON.parse(v); } catch (e) { return null; }
      default: return unsanitizeCell_(String(v));
    }
  }
  function toCell(v, type) {
    if (v === null || v === undefined) return '';
    switch (type) {
      case 'b': return v ? 'true' : 'false';
      case 'j': return JSON.stringify(v);
      case 'i': case 'n': return String(v);
      default: return sanitizeCell_(String(v));
    }
  }
  function rowOf(d, rec) { return d.cols.map(function (c) { return toCell(rec[c], d.types[c]); }); }

  function load(name) {
    if (memo[name]) return memo[name];
    var d = def(name), sh = sheet(name), last = sh.getLastRow(), rows = [], byPk = {};
    if (last > 1) {
      var vals = sh.getRange(2, 1, last - 1, d.cols.length).getValues();
      for (var i = 0; i < vals.length; i++) {
        var o = {};
        for (var c = 0; c < d.cols.length; c++) o[d.cols[c]] = fromCell(vals[i][c], d.types[d.cols[c]]);
        if (o[d.pk] === null) continue;
        Object.defineProperty(o, '__row', { value: i + 2, writable: true, enumerable: false });
        rows.push(o); byPk[o[d.pk]] = o;
      }
    }
    memo[name] = { rows: rows, byPk: byPk, nextRow: Math.max(last, 1) + 1 };
    return memo[name];
  }

  function ensureRows(sh, upto, ncols) {
    var max = sh.getMaxRows();
    if (upto > max) {
      var add = Math.max(upto - max, 500);
      sh.insertRowsAfter(max, add);
      sh.getRange(max + 1, 1, add, ncols).setNumberFormat('@');
    }
  }
  function checkKeys(name, obj) {
    var d = def(name);
    Object.keys(obj).forEach(function (k) { if (d.types[k] === undefined) throw new Error('Unknown column ' + name + '.' + k); });
  }
  function writeRow(name, rec) {
    var d = def(name), sh = sheet(name);
    sh.getRange(rec.__row, 1, 1, d.cols.length).setValues([rowOf(d, rec)]);
  }

  var api = {
    reset: function () { memo = {}; },
    resetAll: function () { memo = {}; ssRef = null; sheets = {}; lockDepth = 0; },
    inLock: function () { return lockDepth > 0; },

    withLock: function (fn, timeoutMs) {
      if (lockDepth > 0) { lockDepth++; try { return fn(); } finally { lockDepth--; } }
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(timeoutMs || 25000)) {
        throw new AppError('BUSY', 'The system is busy. Please try again in a moment.', null, 503);
      }
      lockDepth = 1; memo = {};
      try { return fn(); }
      finally { lockDepth = 0; memo = {}; try { lock.releaseLock(); } catch (e) { /* ignore */ } }
    },

    all: function (name) { return load(name).rows; },
    find: function (name, pk) { return load(name).byPk[pk] || null; },
    where: function (name, pred) { return load(name).rows.filter(pred); },
    first: function (name, pred) { var r = load(name).rows; for (var i = 0; i < r.length; i++) if (pred(r[i])) return r[i]; return null; },
    count: function (name, pred) { var r = load(name).rows, n = 0; for (var i = 0; i < r.length; i++) if (!pred || pred(r[i])) n++; return n; },
    index: function (name, col) { var m = {}; load(name).rows.forEach(function (r) { m[r[col]] = r; }); return m; },

    insert: function (name, obj) { return api.insertMany(name, [obj])[0]; },
    insertMany: function (name, objs) {
      if (!objs.length) return [];
      var d = def(name), t = load(name), sh = sheet(name), now = U.nowIso(), out = [], matrix = [];
      objs.forEach(function (obj) {
        checkKeys(name, obj);
        var rec = {};
        d.cols.forEach(function (c) { rec[c] = obj[c] === undefined ? null : obj[c]; });
        if (d.pk === 'id' && !rec.id) rec.id = U.uid(name.slice(0, 3));
        if (d.types.created_at && !rec.created_at) rec.created_at = now;
        if (d.types.updated_at && !rec.updated_at) rec.updated_at = now;
        if (rec[d.pk] === null || rec[d.pk] === undefined) throw new Error('Missing primary key for ' + name);
        if (t.byPk[rec[d.pk]]) throw new AppError('CONFLICT', 'Duplicate record.', null, 409);
        Object.defineProperty(rec, '__row', { value: t.nextRow + out.length, writable: true, enumerable: false });
        out.push(rec); matrix.push(rowOf(d, rec));
      });
      var startRow = t.nextRow;
      ensureRows(sh, startRow + out.length - 1, d.cols.length);
      sh.getRange(startRow, 1, out.length, d.cols.length).setValues(matrix);
      out.forEach(function (rec) { t.rows.push(rec); t.byPk[rec[d.pk]] = rec; });
      t.nextRow = startRow + out.length;
      Pulse.touch(name);
      return out;
    },

    update: function (name, pk, patch) {
      var d = def(name);
      if (d.appendOnly) throw new AppError('IMMUTABLE', 'This table is append-only.', null, 409);
      var rec = load(name).byPk[pk];
      if (!rec) throw new AppError('NOT_FOUND', 'Record not found.', null, 404);
      checkKeys(name, patch);
      Object.keys(patch).forEach(function (k) { if (k !== d.pk) rec[k] = patch[k] === undefined ? null : patch[k]; });
      if (d.types.updated_at && patch.updated_at === undefined) rec.updated_at = U.nowIso();
      writeRow(name, rec);
      Pulse.touch(name);
      return rec;
    },

    /** Apply many patches with a single sheet write: [{pk, patch}]. */
    updateMany: function (name, items) {
      var d = def(name);
      if (d.appendOnly) throw new AppError('IMMUTABLE', 'This table is append-only.', null, 409);
      if (!items.length) return;
      Pulse.touch(name);
      var t = load(name), now = U.nowIso();
      items.forEach(function (it) {
        var rec = t.byPk[it.pk];
        if (!rec) throw new AppError('NOT_FOUND', 'Record not found.', null, 404);
        checkKeys(name, it.patch);
        Object.keys(it.patch).forEach(function (k) { if (k !== d.pk) rec[k] = it.patch[k] === undefined ? null : it.patch[k]; });
        if (d.types.updated_at && it.patch.updated_at === undefined) rec.updated_at = now;
      });
      if (items.length <= 6) { items.forEach(function (it) { writeRow(name, t.byPk[it.pk]); }); return; }
      var lastRow = t.nextRow - 1, matrix = [], blank = d.cols.map(function () { return ''; });
      for (var r = 2; r <= lastRow; r++) matrix.push(blank.slice());
      t.rows.forEach(function (rec) { matrix[rec.__row - 2] = rowOf(d, rec); });
      sheet(name).getRange(2, 1, matrix.length, d.cols.length).setValues(matrix);
    },

    /** Hard delete (not allowed on append-only tables). Rows are removed bottom-up. */
    removeWhere: function (name, pred) {
      var d = def(name);
      if (d.appendOnly) throw new AppError('IMMUTABLE', 'This table is append-only.', null, 409);
      var victims = load(name).rows.filter(pred).sort(function (a, b) { return b.__row - a.__row; });
      if (!victims.length) return 0;
      var sh = sheet(name);
      victims.forEach(function (rec) { sh.deleteRow(rec.__row); });
      delete memo[name];
      Pulse.touch(name);
      return victims.length;
    },
    remove: function (name, pk) {
      return api.removeWhere(name, function (r) { return r[def(name).pk] === pk; });
    },

    /** Sheet-level helpers used by Setup. */
    spreadsheet: ss
  };
  return api;
})();

function paginate_(list, page) { return U.paginate(list, page, PAGE_SIZE); }

/**
 * Change stamps for near-real-time pages. GAS cannot push, so the browser polls these (cache reads only, no sheet access).
 * Any write to a mapped table bumps its channel's stamp; pages subscribe to channels (see LIVE in Scripts.html).
 * Channels mirror the Laravel broadcast events: announcements, grades, batches, quizzes.
 * quiz_answers is deliberately not mapped: it is autosaved during an attempt and would cause constant refreshes.
 */
var Pulse = {
  NAMES: ['announcements', 'grades', 'batches', 'quizzes'],
  CH: { announcements: 'announcements', intake_settings: 'announcements',
    grade_records: 'grades', grade_revisions: 'grades', grade_components: 'grades', trainee_progress: 'grades',
    batches: 'batches', batch_assignments: 'batches',
    quizzes: 'quizzes', quiz_questions: 'quizzes', quiz_accesses: 'quizzes', quiz_attempts: 'quizzes' },
  touch: function (table) {
    var ch = Pulse.CH[table]; if (!ch) return;
    try { CacheService.getScriptCache().put('pulse:' + ch, String(Date.now()), 21600); } catch (e) { /* non-fatal */ }
  },
  /** {announcements, grades, batches, quizzes} -> stamp strings. A missing (evicted) stamp is re-seeded, which at worst causes one extra refresh. */
  all: function () {
    var c = CacheService.getScriptCache(), keys = Pulse.NAMES.map(function (n) { return 'pulse:' + n; }), got = {};
    try { got = typeof c.getAll === 'function' ? c.getAll(keys) : keys.reduce(function (m, k) { m[k] = c.get(k); return m; }, {}); } catch (e) { got = {}; }
    var out = {};
    Pulse.NAMES.forEach(function (n) {
      var v = got['pulse:' + n];
      if (!v) { v = String(Date.now()); try { c.put('pulse:' + n, v, 21600); } catch (e) { /* non-fatal */ } }
      out[n] = v;
    });
    return out;
  }
};
/** Util.gs - ids, time, crypto, validation and error primitives. */

/** Domain error returned to the browser as a structured failure. */
class AppError extends Error {
  constructor(code, message, fields, status) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fields = fields || null;
    this.status = status || 400;
  }
}
function fail_(code, message, fields) { throw new AppError(code, message, fields || null); }
function forbidden_(msg) { throw new AppError('FORBIDDEN', msg || 'You are not allowed to do that.', null, 403); }
function notFound_(msg) { throw new AppError('NOT_FOUND', msg || 'Record not found.', null, 404); }
function invalid_(field, message) { var f = {}; f[field] = message; throw new AppError('VALIDATION_ERROR', message, f, 422); }

var U = {
  uid: function (prefix) { return (prefix || 'id') + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20); },
  nowIso: function () { return new Date().toISOString(); },
  nowMs: function () { return Date.now(); },
  addMinutes: function (iso, m) { return new Date(new Date(iso).getTime() + m * 60000).toISOString(); },
  addDays: function (iso, d) { return new Date(new Date(iso).getTime() + d * 86400000).toISOString(); },
  /** Today as yyyy-MM-dd in the display timezone. */
  today: function () { return Utilities.formatDate(new Date(), Config.tz(), 'yyyy-MM-dd'); },
  dayOf: function (iso) { return iso ? Utilities.formatDate(new Date(iso), Config.tz(), 'yyyy-MM-dd') : null; },
  /** Whole days from a to b (yyyy-MM-dd strings); b - a. */
  daysBetween: function (a, b) {
    var pa = a.split('-'), pb = b.split('-');
    var da = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]), db = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
    return Math.round((db - da) / 86400000);
  },
  /** Monday-start week key for a yyyy-MM-dd date. */
  weekStart: function (day) {
    var p = day.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    var dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  },
  addDaysStr: function (day, n) {
    var p = day.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
  },
  label: function (iso) { return iso ? Utilities.formatDate(new Date(iso), Config.tz(), 'd MMM yyyy, HH:mm') : null; },
  lower: function (s) { return s === null || s === undefined ? '' : String(s).toLowerCase(); },
  trim: function (s) { return s === null || s === undefined ? '' : String(s).trim(); },
  round2: function (n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; },
  hex: function (bytes) {
    return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
  },
  sha256: function (s) { return U.hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); },
  sha256Bytes: function (bytes) { return U.hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)); },
  secret: function () {
    var s = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
    if (!s) throw new Error('HMAC_SECRET is not configured. Run setup().');
    return s;
  },
  hmac: function (message) {
    return U.hex(Utilities.computeHmacSha256Signature(message, U.secret()));
  },
  /** Random hex string with 4 bits per char, drawn from UUIDv4 values. */
  randomHex: function (len) {
    var out = '';
    while (out.length < len) out += Utilities.getUuid().replace(/-/g, '');
    return out.slice(0, len);
  },
  randomInt: function (max) {
    // rejection sampling over 32-bit values from UUID hex
    var limit = Math.floor(4294967296 / max) * max, n;
    do { n = parseInt(U.randomHex(8), 16); } while (n >= limit);
    return n % max;
  },
  randomPassword: function (len) {
    var a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', o = '';
    for (var i = 0; i < len; i++) o += a.charAt(U.randomInt(a.length));
    return o;
  },
  otpCode: function () { var n = U.randomInt(1000000); return ('000000' + n).slice(-6); },
  constEq: function (a, b) {
    a = String(a); b = String(b);
    var r = a.length ^ b.length;
    for (var i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return r === 0;
  },
  /** Salted, iterated HMAC-SHA256 (see docs: PBKDF2/bcrypt are not available in Apps Script). */
  hashPassword: function (password, salt, iterations) {
    var key = Utilities.newBlob(salt).getBytes();
    var h = Utilities.computeHmacSha256Signature(Utilities.newBlob(password).getBytes(), key);
    for (var i = 1; i < iterations; i++) h = Utilities.computeHmacSha256Signature(h, key);
    return U.hex(h);
  },
  maskEmail: function (email) {
    var p = String(email).split('@'); var local = p[0], domain = p[1] || '';
    var stars = ''; for (var i = 0; i < Math.max(local.length - 1, 2); i++) stars += '*';
    return local.charAt(0) + stars + '@' + domain;
  },
  escapeHtml: function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  },
  paginate: function (list, page, perPage) {
    perPage = perPage || PAGE_SIZE;
    var total = list.length, last = Math.max(1, Math.ceil(total / perPage));
    page = Math.min(Math.max(parseInt(page, 10) || 1, 1), last);
    return { data: list.slice((page - 1) * perPage, page * perPage),
      meta: { page: page, per_page: perPage, total: total, last_page: last } };
  },
  cmp: function (a, b) { return a < b ? -1 : a > b ? 1 : 0; },
  byName: function (a, b) { return U.cmp(U.lower(a.name), U.lower(b.name)) || U.cmp(a.id, b.id); },
  matches: function (term, fields) {
    term = U.lower(term);
    for (var i = 0; i < fields.length; i++) if (U.lower(fields[i]).indexOf(term) !== -1) return true;
    return false;
  },
  isActive: function (user) { return !!user && user.status === USER_STATUS.ACTIVE; }
};

/** Spreadsheet formula-injection guard: text that starts with = + - @ TAB CR is stored with a leading apostrophe. */
function sanitizeCell_(v) {
  if (typeof v !== 'string' || v === '') return v;
  return /^[=+\-@\t\r']/.test(v) ? "'" + v : v;
}
function unsanitizeCell_(v) {
  return (typeof v === 'string' && v.length > 1 && v.charAt(0) === "'" && /[=+\-@\t\r']/.test(v.charAt(1))) ? v.slice(1) : v;
}

/**
 * Declarative payload validation (replaces Laravel FormRequest rules).
 * rules: { field: {type, required, nullable, max, min, gt, regex, regexMsg, in, decimals, label, email, notNewline, lower, trim} }
 * Unknown keys are dropped (strict allow-list).
 */
function validate_(payload, rules) {
  payload = payload || {};
  var out = {}, errors = {};
  Object.keys(rules).forEach(function (f) {
    var r = rules[f], label = r.label || f.replace(/_/g, ' ');
    var v = payload[f];
    var has = Object.prototype.hasOwnProperty.call(payload, f);
    if (r.optional && !has) return;                // "sometimes"
    if (typeof v === 'string' && r.trim !== false) v = v.trim();
    if (typeof v === 'string' && r.lower) v = v.toLowerCase();
    var empty = v === undefined || v === null || v === '';
    if (empty) {
      if (r.required) { errors[f] = 'The ' + label + ' field is required.'; return; }
      out[f] = (r.type === 'bool') ? false : null; return;
    }
    var type = r.type || 'string';
    if (type === 'string' || type === 'email' || type === 'date' || type === 'enum') {
      if (typeof v !== 'string') { errors[f] = 'The ' + label + ' must be text.'; return; }
      if (r.max && v.length > r.max) { errors[f] = 'The ' + label + ' may not be longer than ' + r.max + ' characters.'; return; }
      if (r.min && v.length < r.min) { errors[f] = 'The ' + label + ' must be at least ' + r.min + ' characters.'; return; }
      if (r.notNewline && /[\r\n]/.test(v)) { errors[f] = 'The ' + label + ' must be a single line.'; return; }
      if (r.regex && !r.regex.test(v)) { errors[f] = r.regexMsg || 'The ' + label + ' format is invalid.'; return; }
      if (type === 'email' && !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(v)) {
        errors[f] = 'The ' + label + ' must be a valid email address.'; return; }
      if (type === 'date') {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
        var d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        if (!m || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) { errors[f] = 'The ' + label + ' is not a valid date.'; return; }
      }
      if (type === 'enum' && r['in'].indexOf(v) === -1) { errors[f] = 'The selected ' + label + ' is invalid.'; return; }
      out[f] = v;
    } else if (type === 'int' || type === 'num') {
      var n = typeof v === 'number' ? v : (/^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : NaN);
      if (isNaN(n)) { errors[f] = 'The ' + label + ' must be a number.'; return; }
      if (type === 'int' && Math.floor(n) !== n) { errors[f] = 'The ' + label + ' must be a whole number.'; return; }
      if (r.decimals !== undefined && String(v).indexOf('.') !== -1 && String(v).split('.')[1].length > r.decimals) {
        errors[f] = 'Use at most ' + r.decimals + ' decimal places.'; return; }
      if (r.min !== undefined && n < r.min) { errors[f] = 'The ' + label + ' must be at least ' + r.min + '.'; return; }
      if (r.gt !== undefined && !(n > r.gt)) { errors[f] = 'The ' + label + ' must be greater than ' + r.gt + '.'; return; }
      if (r.max !== undefined && n > r.max) { errors[f] = r.maxMsg || 'The ' + label + ' may not be greater than ' + r.max + '.'; return; }
      out[f] = n;
    } else if (type === 'bool') {
      out[f] = v === true || v === 'true' || v === 1 || v === '1';
    }
  });
  if (Object.keys(errors).length) throw new AppError('VALIDATION_ERROR', 'Please correct the highlighted fields.', errors, 422);
  return out;
}

/** Password policy (Laravel Password::min(12) in production). */
function assertPasswordPolicy_(password, field) {
  var min = Config.getInt('PASSWORD_MIN_LENGTH') || 12;
  if (typeof password !== 'string' || password.length < min) invalid_(field || 'password', 'The password must be at least ' + min + ' characters.');
  if (password.length > 200) invalid_(field || 'password', 'The password is too long.');
}

/**
 * Auth.gs - sessions, OTP, trusted devices, login flow.
 *
 * Identity model: the web app runs as the deploying account and is reachable by
 * anyone, so identity is established by this module (username + password, then an
 * emailed one-time code), exactly like the Laravel/Fortify original. Passwords are
 * stored only as salted iterated HMAC hashes. Session tokens are random, only their
 * SHA-256 is stored, and the browser sends the token on every call. The server never
 * trusts a role sent by the client.
 */
var RateLimit = {
  hit: function (key, max, windowSec) {
    var cache = CacheService.getScriptCache(), k = 'rl:' + U.sha256(key).slice(0, 32);
    var n = parseInt(cache.get(k) || '0', 10) + 1;
    cache.put(k, String(n), windowSec);
    if (n > max) throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait a minute and try again.', null, 429);
  }
};

/** Short-lived multi-step login state (temporary by design; losing it just restarts login). */
var Pending = {
  ttl: function () { return (Config.getInt('PENDING_MINUTES') || 15) * 60; },
  create: function (kind, data) {
    var token = U.randomHex(40), rec = Object.assign({ kind: kind, exp: U.nowMs() + Pending.ttl() * 1000 }, data);
    CacheService.getScriptCache().put('pend:' + U.sha256(token), JSON.stringify(rec), Math.min(Pending.ttl(), 21600));
    return token;
  },
  get: function (token, kind) {
    if (typeof token !== 'string' || token.length !== 40) return null;
    var raw = CacheService.getScriptCache().get('pend:' + U.sha256(token));
    if (!raw) return null;
    var rec = JSON.parse(raw);
    if (rec.kind !== kind || rec.exp < U.nowMs()) return null;
    return rec;
  },
  put: function (token, rec) {
    CacheService.getScriptCache().put('pend:' + U.sha256(token), JSON.stringify(rec), Math.min(Pending.ttl(), 21600));
  },
  clear: function (token) { CacheService.getScriptCache().remove('pend:' + U.sha256(token)); }
};

var Sessions = {
  TOUCH_MS: 5 * 60000,
  create: function (user, remember) {
    var token = U.randomHex(96), id = U.sha256(token), now = U.nowIso();
    var hardMs = remember ? (Config.getInt('REMEMBER_DAYS') || 30) * 86400000 : 12 * 3600000;
    var row = Repo.insert('sessions', { id: id, user_id: user.id, created_at: now, last_seen_at: now,
      expires_at: new Date(U.nowMs() + hardMs).toISOString(), remember: !!remember });
    Sessions.cachePut_(row);
    return token;
  },
  cachePut_: function (row) {
    CacheService.getScriptCache().put('sess:' + row.id, JSON.stringify({ user_id: row.user_id, last: row.last_seen_at,
      exp: row.expires_at, remember: !!row.remember }), 21600);
  },
  /** Returns the session {id,user_id} or null. Enforces absolute expiry and idle timeout. */
  resolve: function (token) {
    if (typeof token !== 'string' || token.length !== 96) return null;
    var id = U.sha256(token), cache = CacheService.getScriptCache(), raw = cache.get('sess:' + id), s = null;
    if (raw) s = JSON.parse(raw);
    else {
      var row = Repo.find('sessions', id);
      if (!row) return null;
      s = { user_id: row.user_id, last: row.last_seen_at, exp: row.expires_at, remember: row.remember };
    }
    var now = U.nowMs();
    var idleMs = (s.remember ? (Config.getInt('REMEMBER_DAYS') || 30) * 1440 : (Config.getInt('SESSION_MINUTES') || 120)) * 60000;
    if (now > new Date(s.exp).getTime() || now - new Date(s.last).getTime() > idleMs) { Sessions.destroyById_(id); return null; }
    if (now - new Date(s.last).getTime() > Sessions.TOUCH_MS) {
      try {
        Repo.withLock(function () {
          var r = Repo.find('sessions', id);
          if (r) { Repo.update('sessions', id, { last_seen_at: U.nowIso() }); Sessions.cachePut_(Repo.find('sessions', id)); }
        }, 3000);
      } catch (e) { /* touch is best effort */ }
    }
    return { id: id, user_id: s.user_id };
  },
  destroyById_: function (id) {
    CacheService.getScriptCache().remove('sess:' + id);
    try { Repo.withLock(function () { Repo.remove('sessions', id); }, 5000); } catch (e) { /* ignore */ }
  },
  destroy: function (token) { if (typeof token === 'string' && token.length === 96) Sessions.destroyById_(U.sha256(token)); },
  /** Must run inside the lock. keepId: session id to preserve. */
  revokeAllForUser: function (userId, keepId) {
    var rows = Repo.where('sessions', function (s) { return s.user_id === userId && s.id !== keepId; });
    var cache = CacheService.getScriptCache();
    rows.forEach(function (r) { cache.remove('sess:' + r.id); });
    Repo.removeWhere('sessions', function (s) { return s.user_id === userId && s.id !== keepId; });
  },
  purgeExpired: function () {
    var now = U.nowIso();
    return Repo.withLock(function () { return Repo.removeWhere('sessions', function (s) { return s.expires_at < now; }); });
  }
};

var Devices = {
  consume: function (user, token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    var h = U.sha256(token), now = U.nowIso();
    var d = Repo.first('trusted_devices', function (r) { return r.user_id === user.id && r.token_hash === h && !r.revoked_at && r.expires_at > now; });
    if (!d) return null;
    var fresh = U.randomHex(64);
    Repo.update('trusted_devices', d.id, { token_hash: U.sha256(fresh), last_used_at: now });
    return fresh;
  },
  trust: function (user, label) {
    var token = U.randomHex(64), days = Config.getInt('TRUSTED_DEVICE_DAYS') || 30;
    Repo.insert('trusted_devices', { user_id: user.id, token_hash: U.sha256(token), label: String(label || 'Browser').slice(0, 100),
      last_used_at: U.nowIso(), expires_at: U.addDays(U.nowIso(), days) });
    var keep = Config.getInt('MAX_TRUSTED_DEVICES') || 10;
    var live = Repo.where('trusted_devices', function (r) { return r.user_id === user.id && !r.revoked_at; })
      .sort(function (a, b) { return U.cmp(b.created_at, a.created_at); });
    live.slice(keep).forEach(function (r) { Repo.update('trusted_devices', r.id, { revoked_at: U.nowIso() }); });
    return token;
  },
  revokeAll: function (userId) {
    Repo.where('trusted_devices', function (r) { return r.user_id === userId && !r.revoked_at; })
      .forEach(function (r) { Repo.update('trusted_devices', r.id, { revoked_at: U.nowIso() }); });
  }
};

var Otp = {
  SENT: 'sent', COOLDOWN: 'cooldown', FAILED: 'failed',
  hash_: function (user, purpose, code, email) {
    return U.hmac(user.id + '|' + purpose + '|' + code + (email ? '|' + email : ''));
  },
  cooldownSeconds: function (user, purpose) {
    var base = Config.getInt('OTP_RESEND_SECONDS') || 60, max = Config.getInt('OTP_MAX_RESEND_SECONDS') || 900;
    var since = U.addMinutes(U.nowIso(), -(Config.getInt('OTP_ESCALATION_WINDOW_MINUTES') || 60));
    var sent = Repo.where('otp_challenges', function (c) { return c.user_id === user.id && c.purpose === purpose && c.created_at > since; });
    if (!sent.length) return 0;
    var last = sent.reduce(function (a, c) { return c.created_at > a ? c.created_at : a; }, '');
    var cooldown = Math.min(base * Math.pow(2, sent.length - 1), max);
    return Math.max(0, Math.floor(new Date(last).getTime() / 1000) + cooldown - Math.floor(U.nowMs() / 1000));
  },
  subject_: function (purpose) {
    return { login: 'Your AMS sign-in code', email_verification: 'Verify your email for AMS',
      password_reset: 'Your AMS password reset code', password_change: 'Your AMS security code' }[purpose] || 'Your AMS code';
  },
  /** Must run inside the lock. */
  issue: function (user, purpose, email) {
    if (Otp.cooldownSeconds(user, purpose) > 0) return Otp.COOLDOWN;
    var dest = email || user.email;
    if (!dest) return Otp.FAILED;
    var code = U.otpCode(), minutes = Config.getInt('OTP_TTL_MINUTES') || 5;
    try {
      MailApp.sendEmail({ to: dest, name: APP_NAME, subject: Otp.subject_(purpose),
        htmlBody: '<div style="font-family:Arial,sans-serif;max-width:420px"><h2 style="margin:0 0 8px">' + U.escapeHtml(APP_NAME) + '</h2>' +
          '<p>Your verification code is:</p><p style="font-size:30px;letter-spacing:6px;font-weight:700;margin:12px 0">' + code + '</p>' +
          '<p>It expires in ' + minutes + ' minutes. If you did not request it, you can ignore this email.</p></div>',
        body: 'Your ' + APP_NAME + ' verification code is ' + code + '. It expires in ' + minutes + ' minutes.' });
    } catch (e) {
      console.error('OTP mail failed: ' + e);
      return Otp.FAILED;
    }
    var now = U.nowIso();
    Repo.where('otp_challenges', function (c) { return c.user_id === user.id && c.purpose === purpose && !c.consumed_at; })
      .forEach(function (c) { Repo.update('otp_challenges', c.id, { consumed_at: now }); });
    Repo.insert('otp_challenges', { user_id: user.id, purpose: purpose, code_hash: Otp.hash_(user, purpose, code, email),
      expires_at: U.addMinutes(now, minutes), attempts: 0, created_at: now });
    return Otp.SENT;
  },
  /** Must run inside the lock. */
  verify: function (user, purpose, code, email) {
    var now = U.nowIso();
    var ch = Repo.where('otp_challenges', function (c) { return c.user_id === user.id && c.purpose === purpose && !c.consumed_at && c.expires_at > now; })
      .sort(function (a, b) { return U.cmp(b.created_at, a.created_at); })[0];
    if (!ch || ch.attempts >= (Config.getInt('OTP_MAX_ATTEMPTS') || 5)) return false;
    Repo.update('otp_challenges', ch.id, { attempts: ch.attempts + 1 });
    if (!U.constEq(ch.code_hash, Otp.hash_(user, purpose, String(code), email))) return false;
    Repo.removeWhere('otp_challenges', function (c) { return c.user_id === user.id && c.purpose === purpose; });
    return true;
  },
  purgeExpired: function () {
    var cutoff = U.addMinutes(U.nowIso(), -60);
    return Repo.withLock(function () { return Repo.removeWhere('otp_challenges', function (c) { return c.expires_at < cutoff; }); });
  }
};

var Auth = {
  mePayload: function (u) {
    return { id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, role_label: ROLE_LABELS[u.role] || u.role,
      status: u.status, force_password_change: !!u.force_password_change, permissions: Authz.permissionsFor(u) };
  },
  findByUsername_: function (username) {
    return Repo.first('users', function (u) { return !u.deleted_at && u.username && u.username.toLowerCase() === username; });
  },
  setPassword: function (userId, password, force) {
    var salt = U.randomHex(32), iters = Config.getInt('PASSWORD_ITERATIONS') || 1500;
    Repo.update('users', userId, { password_hash: U.hashPassword(password, salt, iters) + ':' + iters, password_salt: salt, force_password_change: !!force });
  },
  checkPassword_: function (user, password) {
    var parts = String(user.password_hash || '').split(':'), iters = parseInt(parts[1], 10) || (Config.getInt('PASSWORD_ITERATIONS') || 1500);
    return U.constEq(parts[0] || '', U.hashPassword(password, user.password_salt || 'x', iters));
  },
  finish_: function (user, remember, extra) {
    return Repo.withLock(function () {
      var token = Sessions.create(user, remember);
      Repo.update('users', user.id, { last_login_at: U.nowIso() });
      Audit.record('auth.login', user, 'user', user.id);
      return Object.assign({ step: 'done', token: token, user: Auth.mePayload(Repo.find('users', user.id)) }, extra || {});
    });
  },
  pendingUser_: function (rec, requireEmail) {
    var u = rec && Repo.find('users', rec.user_id);
    if (!u || u.deleted_at || !U.isActive(u)) return null;
    if (requireEmail === true && !u.email) return null;
    if (requireEmail === false && u.email) return null;
    return u;
  },

  login: function (p) {
    var v = validate_(p, { username: { required: true, lower: true, max: 100 }, password: { required: true, trim: false, max: 200 },
      remember: { type: 'bool' }, device_token: { max: 64 } });
    RateLimit.hit('login:' + v.username, 5, 60);
    RateLimit.hit('login:global', 120, 60);
    var user = Auth.findByUsername_(v.username);
    var ok = user ? Auth.checkPassword_(user, v.password) : (U.hashPassword(v.password, 'unknown-user-salt', Config.getInt('PASSWORD_ITERATIONS') || 1500) && false);
    function bad(reason, subj) {
      Repo.withLock(function () { Audit.record(reason, null, subj ? 'user' : null, subj, subj ? undefined : { username: /^[a-z0-9._-]{3,50}$/.test(v.username) ? v.username : '[invalid]' }); });
      fail_('AUTH_FAILED', 'These credentials do not match our records.', { username: 'These credentials do not match our records.' });
    }
    if (!user) bad('auth.login_failed');
    if (!ok) bad('auth.login_failed', user.id);
    if (!U.isActive(user)) bad('auth.login_blocked', user.id);
    if (!Config.getBool('OTP_REQUIRED')) return Auth.finish_(user, v.remember);
    if (!user.email) {
      Repo.withLock(function () { Audit.record('auth.email_setup_started', null, 'user', user.id); });
      return { step: 'email_setup', pending: Pending.create('email_setup', { user_id: user.id, remember: v.remember, email: null }) };
    }
    var fresh = Repo.withLock(function () { return Devices.consume(user, v.device_token); });
    if (fresh) return Auth.finish_(user, v.remember, { device_token: fresh });
    var res = Repo.withLock(function () {
      var r = Otp.issue(user, OTP_PURPOSE.LOGIN);
      if (r === Otp.FAILED) Audit.record('auth.otp_send_failed', null, 'user', user.id);
      if (r === Otp.SENT) Audit.record('auth.otp_sent', null, 'user', user.id);
      return r;
    });
    if (res === Otp.FAILED) bad('auth.login_failed', user.id);
    return { step: 'otp', pending: Pending.create('otp', { user_id: user.id, remember: v.remember }),
      email: U.maskEmail(user.email), resend_in: Otp.cooldownSeconds(user, OTP_PURPOSE.LOGIN) };
  },

  pendingInfo: function (p) {
    var rec = Pending.get(p && p.pending, 'otp'), kind = 'otp';
    if (!rec) { rec = Pending.get(p && p.pending, 'email_setup'); kind = 'email_setup'; }
    if (!rec) fail_('SESSION_EXPIRED', 'Your sign-in session expired. Please start again.');
    var u = Auth.pendingUser_(rec, kind === 'otp' ? true : false);
    if (!u) fail_('SESSION_EXPIRED', 'Your sign-in session expired. Please start again.');
    return { step: kind, email: kind === 'otp' ? U.maskEmail(u.email) : rec.email || null,
      resend_in: Otp.cooldownSeconds(u, kind === 'otp' ? OTP_PURPOSE.LOGIN : OTP_PURPOSE.EMAIL_VERIFICATION) };
  },

  otpVerify: function (p) {
    var v = validate_(p, { pending: { required: true, max: 40 }, code: { required: true, regex: /^\d{6}$/, regexMsg: 'Enter the 6-digit code.' }, trust: { type: 'bool' } });
    RateLimit.hit('otp:' + v.pending, 10, 60);
    var rec = Pending.get(v.pending, 'otp'), user = Auth.pendingUser_(rec, true);
    if (!user) fail_('SESSION_EXPIRED', 'Your sign-in session expired. Please start again.');
    var ok = Repo.withLock(function () {
      var good = Otp.verify(user, OTP_PURPOSE.LOGIN, v.code);
      if (!good) Audit.record('auth.otp_failed', null, 'user', user.id);
      return good;
    });
    if (!ok) fail_('INVALID_CODE', 'The code is invalid or has expired.', { code: 'The code is invalid or has expired.' });
    Pending.clear(v.pending);
    var extra = {};
    if (v.trust) extra.device_token = Repo.withLock(function () { var t = Devices.trust(user, p.device_label); Audit.record('auth.device_trusted', user, 'user', user.id); return t; });
    Repo.withLock(function () { Audit.record('auth.otp_verified', user, 'user', user.id); });
    return Auth.finish_(user, rec.remember, extra);
  },

  otpResend: function (p) {
    var rec = Pending.get(p && p.pending, 'otp'), user = Auth.pendingUser_(rec, true);
    if (!user) fail_('SESSION_EXPIRED', 'Your sign-in session expired. Please start again.');
    RateLimit.hit('otp-resend:' + p.pending, 3, 60);
    var r = Repo.withLock(function () {
      var res = Otp.issue(user, OTP_PURPOSE.LOGIN);
      Audit.record(res === Otp.SENT ? 'auth.otp_resent' : 'auth.otp_send_failed', null, 'user', user.id);
      return res;
    });
    if (r === Otp.FAILED) fail_('OTP_SEND_FAILED', 'We could not send the code. Try again shortly.', { code: 'We could not send the code. Try again shortly.' });
    if (r === Otp.COOLDOWN) fail_('COOLDOWN', 'Please wait before requesting another code.', { code: 'Please wait before requesting another code.' });
    return { resend_in: Otp.cooldownSeconds(user, OTP_PURPOSE.LOGIN) };
  },

  emailSubmit: function (p) {
    var rec = Pending.get(p && p.pending, 'email_setup'), user = Auth.pendingUser_(rec, false);
    if (!user) fail_('SESSION_EXPIRED', 'Your sign-in session expired. Please start again.');
    var v = validate_(p, { email: { required: true, type: 'email', lower: true, max: 255 } });
    var res = Repo.withLock(function () {
      if (Repo.first('users', function (u) { return u.email && u.email.toLowerCase() === v.email && u.id !== user.id; })) return 'taken';
      var r = Otp.issue(user, OTP_PURPOSE.EMAIL_VERIFICATION, v.email);
      if (r === Otp.SENT) Audit.record('auth.email_otp_sent', null, 'user', user.id);
      if (r === Otp.FAILED) Audit.record('auth.otp_send_failed', null, 'user', user.id);
      return r;
    });
    if (res === 'taken') fail_('VALIDATION_ERROR', 'That email cannot be used. Please enter a different one.', { email: 'That email cannot be used. Please enter a different one.' });
    if (res === Otp.FAILED) fail_('OTP_SEND_FAILED', 'We could not send the code. Try again shortly.', { email: 'We could not send the code. Try again shortly.' });
    if (res === Otp.COOLDOWN) fail_('COOLDOWN', 'Please wait before requesting another code.', { email: 'Please wait before requesting another code.' });
    rec.email = v.email; Pending.put(p.pending, rec);
    return { email: v.email, resend_in: Otp.cooldownSeconds(user, OTP_PURPOSE.EMAIL_VERIFICATION) };
  },
  emailChange: function (p) {
    var rec = Pending.get(p && p.pending, 'email_setup');
    if (!rec) fail_('SESSION_EXPIRED', 'Your sign-in session expired. Please start again.');
    rec.email = null; Pending.put(p.pending, rec); return {};
  },
  emailResend: function (p) {
    var rec = Pending.get(p && p.pending, 'email_setup'), user = Auth.pendingUser_(rec, false);
    if (!user) fail_('SESSION_EXPIRED', 'Your sign-in session expired. Please start again.');
    if (!rec.email) fail_('VALIDATION_ERROR', 'Enter your email first.');
    RateLimit.hit('email-resend:' + p.pending, 3, 60);
    var r = Repo.withLock(function () { return Otp.issue(user, OTP_PURPOSE.EMAIL_VERIFICATION, rec.email); });
    if (r === Otp.FAILED) fail_('OTP_SEND_FAILED', 'We could not send the code. Try again shortly.', { code: 'We could not send the code. Try again shortly.' });
    if (r === Otp.COOLDOWN) fail_('COOLDOWN', 'Please wait before requesting another code.', { code: 'Please wait before requesting another code.' });
    return { resend_in: Otp.cooldownSeconds(user, OTP_PURPOSE.EMAIL_VERIFICATION) };
  },
  emailVerify: function (p) {
    var v = validate_(p, { pending: { required: true, max: 40 }, code: { required: true, regex: /^\d{6}$/, regexMsg: 'Enter the 6-digit code.' }, trust: { type: 'bool' } });
    RateLimit.hit('otp:' + v.pending, 10, 60);
    var rec = Pending.get(v.pending, 'email_setup'), user = Auth.pendingUser_(rec, false);
    if (!user) fail_('SESSION_EXPIRED', 'Your sign-in session expired. Please start again.');
    if (!rec.email) fail_('VALIDATION_ERROR', 'Enter your email first.');
    var out = Repo.withLock(function () {
      if (!Otp.verify(user, OTP_PURPOSE.EMAIL_VERIFICATION, v.code, rec.email)) { Audit.record('auth.email_otp_failed', null, 'user', user.id); return 'bad'; }
      if (Repo.first('users', function (u) { return u.email && u.email.toLowerCase() === rec.email && u.id !== user.id; })) return 'taken';
      Repo.update('users', user.id, { email: rec.email, email_verified_at: U.nowIso() });
      return 'ok';
    });
    if (out === 'bad') fail_('INVALID_CODE', 'The code is invalid or has expired.', { code: 'The code is invalid or has expired.' });
    if (out === 'taken') { rec.email = null; Pending.put(v.pending, rec); fail_('EMAIL_TAKEN', 'That email cannot be used. Please enter a different one.', { email: 'That email cannot be used. Please enter a different one.' }); }
    Pending.clear(v.pending);
    var fresh = Repo.find('users', user.id), extra = {};
    if (v.trust) extra.device_token = Repo.withLock(function () { var t = Devices.trust(fresh, p.device_label); Audit.record('auth.device_trusted', fresh, 'user', fresh.id); return t; });
    Repo.withLock(function () { Audit.record('auth.email_verified', fresh, 'user', fresh.id, { source: 'first_login' }); });
    return Auth.finish_(fresh, rec.remember, extra);
  },

  /** Forgot password: always answers the same way so accounts cannot be enumerated. */
  forgot: function (p) {
    var v = validate_(p, { email: { required: true, type: 'email', lower: true, max: 255 } });
    RateLimit.hit('forgot:' + v.email, 3, 60);
    RateLimit.hit('forgot:global', 60, 60);
    var user = Repo.first('users', function (u) { return !u.deleted_at && u.email && u.email.toLowerCase() === v.email; });
    var uid = null;
    if (user && U.isActive(user)) {
      Repo.withLock(function () {
        var r = Otp.issue(user, OTP_PURPOSE.PASSWORD_RESET);
        if (r === Otp.SENT) { uid = user.id; Audit.record('auth.password_reset_requested', null, 'user', user.id); }
      });
    }
    return { pending: Pending.create('reset', { user_id: uid }) };
  },
  reset: function (p) {
    var v = validate_(p, { pending: { required: true, max: 40 }, code: { required: true, regex: /^\d{6}$/, regexMsg: 'Enter the 6-digit code.' },
      password: { required: true, trim: false }, password_confirmation: { required: true, trim: false } });
    RateLimit.hit('otp:' + v.pending, 10, 60);
    assertPasswordPolicy_(v.password, 'password');
    if (v.password !== v.password_confirmation) invalid_('password', 'The password confirmation does not match.');
    var rec = Pending.get(v.pending, 'reset'), user = rec && rec.user_id ? Repo.find('users', rec.user_id) : null;
    var ok = Repo.withLock(function () {
      if (!user || !U.isActive(user) || !Otp.verify(user, OTP_PURPOSE.PASSWORD_RESET, v.code)) return false;
      Auth.setPassword(user.id, v.password, false);
      Sessions.revokeAllForUser(user.id); Devices.revokeAll(user.id);
      Audit.record('auth.password_reset', user, 'user', user.id);
      return true;
    });
    if (!ok) fail_('INVALID_CODE', 'The code is invalid or has expired.', { code: 'The code is invalid or has expired.' });
    Pending.clear(v.pending);
    return {};
  },

  logout: function (ctx) {
    Repo.withLock(function () { Audit.record('auth.logout', ctx.user, 'user', ctx.user.id); });
    Sessions.destroy(ctx.token);
    return {};
  },

  updateProfile: function (ctx, p) {
    var v = validate_(p, { name: { required: true, max: 255 } });
    var changed = ctx.user.name !== v.name;
    Repo.update('users', ctx.user.id, { name: v.name });
    if (changed) Audit.record('profile.updated', ctx.user, 'user', ctx.user.id, { fields: ['name'] });
    return Auth.mePayload(Repo.find('users', ctx.user.id));
  },
  changePassword: function (ctx, p) {
    RateLimit.hit('pwchange:' + ctx.user.id, 6, 60);
    var v = validate_(p, { current_password: { required: true, trim: false }, password: { required: true, trim: false }, password_confirmation: { required: true, trim: false } });
    if (!Auth.checkPassword_(ctx.user, v.current_password)) invalid_('current_password', 'The password is incorrect.');
    assertPasswordPolicy_(v.password, 'password');
    if (v.password !== v.password_confirmation) invalid_('password', 'The password confirmation does not match.');
    Auth.setPassword(ctx.user.id, v.password, false);
    Devices.revokeAll(ctx.user.id);
    Sessions.revokeAllForUser(ctx.user.id, ctx.session.id);
    Audit.record('auth.password_changed', ctx.user, 'user', ctx.user.id);
    return Auth.mePayload(Repo.find('users', ctx.user.id));
  }
};

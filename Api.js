/**
 * Api.gs - single server entry point for google.script.run and the action table.
 *
 * Every call: resolve session -> load user -> status/permission checks -> (lock) -> handler.
 * lock: 'write' = whole handler runs in the script lock (default for mutations)
 *       'manual' = handler takes the lock itself (long external calls / login)
 *       'none'  = read-only
 * Responses: {success:true,data,message,pulse} | {success:false,error:{code,message,fields}}
 */
function api(action, token, payload) {
  try {
    Config.reset(); Repo.reset();
    var spec = actions_()[action];
    if (!spec) throw new AppError('NOT_FOUND', 'Unknown action.', null, 404);
    payload = (payload && typeof payload === 'object') ? payload : {};
    var ctx = { token: token, user: null, session: null };
    if (spec.auth !== false) {
      var s = Sessions.resolve(token), u = s ? Repo.find('users', s.user_id) : null;
      if (!s || !u || u.deleted_at || !U.isActive(u)) {
        if (s) Sessions.destroy(token);
        throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.', null, 401);
      }
      ctx.user = u; ctx.session = s;
      if (u.force_password_change && FORCED_CHANGE_ALLOWED.indexOf(action) === -1) {
        throw new AppError('PASSWORD_CHANGE_REQUIRED', 'You must change your temporary password before continuing.', null, 403);
      }
      if (spec.perm) Authz.require(u, spec.perm);
    }
    var pulse = Pulse.all(); // read BEFORE the handler so a page's baseline is never newer than its data
    var data;
    if (spec.lock === 'write') data = Repo.withLock(function () { ctx.user = ctx.user ? Repo.find('users', ctx.user.id) : null; return spec.fn(ctx, payload); });
    else data = spec.fn(ctx, payload);
    var message = null;
    if (data && typeof data === 'object' && data.message) message = data.message;
    return { success: true, data: data === undefined ? {} : data, message: message, pulse: pulse };
  } catch (e) {
    if (e instanceof AppError) return { success: false, error: { code: e.code, message: e.message, fields: e.fields } };
    console.error('api(' + action + ') failed: ' + (e && e.stack ? e.stack : e));
    return { success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.', fields: null } };
  }
}

var FORCED_CHANGE_ALLOWED = ['auth.me', 'auth.logout', 'settings.password'];

function W_(fn, perm) { return { lock: 'write', fn: fn, perm: perm }; }
function R_(fn, perm) { return { lock: 'none', fn: fn, perm: perm }; }
function M_(fn, perm) { return { lock: 'manual', fn: fn, perm: perm }; }
function PUB_(fn, lock) { return { auth: false, lock: lock || 'none', fn: fn }; }

function announcementSave_(ctx, p, isCreate) {
  var r = Repo.withLock(function () { return isCreate ? Announcements.create(ctx, p) : Announcements.update(ctx, p); });
  var msg = 'Announcement saved.';
  if (r.publish) msg = Announcements.publish(ctx, { id: r.id }).message;
  return { id: r.id, message: msg };
}

/** Built lazily: Apps Script loads files alphabetically, so services are not defined yet when Api.gs first runs. */
var ACTIONS_ = null;
function actions_() { if (!ACTIONS_) ACTIONS_ = buildActions_(); return ACTIONS_; }
function buildActions_() {
  return {
  // ---- public ----
  'public.landing': PUB_(function () { return { intake: Intake.banner(), announcements: Announcements.publicTop(3), app_name: APP_NAME }; }),
  'live.pulse': PUB_(function () { return Pulse.all(); }),
  'public.announcements': PUB_(function (c, p) { return Announcements.publicArchive(p); }),
  'public.chain': PUB_(function () { return Chain.publicList(); }),
  'auth.login': PUB_(function (c, p) { return Auth.login(p); }, 'manual'),
  'auth.pending': PUB_(function (c, p) { return Auth.pendingInfo(p); }),
  'auth.otpVerify': PUB_(function (c, p) { return Auth.otpVerify(p); }, 'manual'),
  'auth.otpResend': PUB_(function (c, p) { return Auth.otpResend(p); }, 'manual'),
  'auth.emailSubmit': PUB_(function (c, p) { return Auth.emailSubmit(p); }, 'manual'),
  'auth.emailChange': PUB_(function (c, p) { return Auth.emailChange(p); }),
  'auth.emailResend': PUB_(function (c, p) { return Auth.emailResend(p); }, 'manual'),
  'auth.emailVerify': PUB_(function (c, p) { return Auth.emailVerify(p); }, 'manual'),
  'auth.forgot': PUB_(function (c, p) { return Auth.forgot(p); }, 'manual'),
  'auth.reset': PUB_(function (c, p) { return Auth.reset(p); }, 'manual'),

  // ---- session / settings ----
  'auth.me': R_(function (c) { return { user: Auth.mePayload(c.user), intake: Intake.banner() }; }),
  'auth.logout': M_(function (c) { return Auth.logout(c); }),
  'settings.profile': W_(function (c, p) { return { user: Auth.updateProfile(c, p), message: 'Profile updated.' }; }),
  'settings.password': W_(function (c, p) { return { user: Auth.changePassword(c, p), message: 'Password updated.' }; }),

  // ---- dashboard ----
  'dashboard.get': R_(function (c) { return Dashboard.get(c); }),

  // ---- users ----
  'users.list': R_(Users.list), 'users.get': R_(Users.get),
  'users.create': W_(Users.create), 'users.update': W_(function (c, p) { var r = Users.update(c, p); r.message = 'User updated.'; return r; }),
  'users.status': W_(function (c, p) { var r = Users.changeStatus(c, p); r.message = 'Status updated.'; return r; }),
  'users.resetPassword': W_(Users.resetPassword),
  'users.resetData': W_(function (c, p) {
    var r = Users.resetData(c, p), n = r.counts;
    r.message = 'Data reset: ' + n.grades + ' grade' + (n.grades === 1 ? '' : 's') + ', ' + n.violations + ' violation' + (n.violations === 1 ? '' : 's') + ', ' + n.certificates + ' certificate' + (n.certificates === 1 ? '' : 's') + ' cleared.';
    return r;
  }),

  // ---- audit log ----
  'logs.list': R_(AuditLogs.list, PERM.LOGS_VIEW),

  // ---- batches ----
  'batches.list': R_(Batches.list), 'batches.show': R_(Batches.show),
  'batches.create': W_(function (c, p) { var r = Batches.create(c, p); r.message = 'Batch created.'; return r; }),
  'batches.update': W_(function (c, p) { var r = Batches.update(c, p); r.message = 'Batch updated.'; return r; }),
  'batches.delete': W_(function (c, p) { var r = Batches.remove(c, p); r.message = 'Batch deleted.'; return r; }),
  'batches.assign': W_(function (c, p) { var r = Batches.assign(c, p); r.message = 'Trainee assigned.'; return r; }),
  'batches.unassign': W_(function (c, p) { var r = Batches.unassign(c, p); r.message = 'Trainee removed from batch.'; return r; }),

  // ---- grades ----
  'grades.index': R_(Grades.index), 'grades.show': R_(Grades.show),
  'grades.save': W_(function (c, p) { var r = Grades.save(c, p); r.message = 'Grade saved.'; return r; }),

  // ---- violations ----
  'violations.list': R_(Violations.list), 'violations.options': R_(Violations.options), 'violations.get': R_(Violations.get),
  'violations.create': W_(function (c, p) { var r = Violations.create(c, p); r.message = 'Violation recorded.'; return r; }),
  'violations.update': W_(function (c, p) { var r = Violations.update(c, p); r.message = 'Violation updated.'; return r; }),
  'violations.delete': W_(function (c, p) { var r = Violations.remove(c, p); r.message = 'Violation deleted.'; return r; }),

  // ---- progress ----
  'progress.list': R_(Progress.list), 'progress.get': R_(Progress.get),
  'progress.save': W_(function (c, p) { var r = Progress.save(c, p); r.message = 'Progress updated.'; return r; }),

  // ---- certificates ----
  'certificates.list': R_(Certificates.list),
  'certificates.issue': W_(function (c, p) { var r = Certificates.issue(c, p); r.message = 'Certificate issued.'; return r; }),
  'certificates.revoke': W_(function (c, p) { var r = Certificates.revoke(c, p); r.message = 'Certificate revoked.'; return r; }),
  'certificates.download': W_(function (c, p) { return Certificates.file(c, p, 'download'); }),
  'certificates.preview': W_(function (c, p) { return Certificates.file(c, p, 'preview'); }),

  // ---- chain of command ----
  'chain.manage': R_(Chain.manage),
  'chain.create': W_(function (c, p) { var r = Chain.create(c, p); r.message = 'Entry added.'; return r; }),
  'chain.update': W_(function (c, p) { var r = Chain.update(c, p); r.message = 'Entry updated.'; return r; }),
  'chain.delete': W_(function (c, p) { var r = Chain.remove(c, p); r.message = 'Entry removed.'; return r; }),

  // ---- announcements ----
  'announcements.list': R_(Announcements.list), 'announcements.get': R_(Announcements.get),
  'announcements.create': M_(function (c, p) { return announcementSave_(c, p, true); }),
  'announcements.update': M_(function (c, p) { return announcementSave_(c, p, false); }),
  'announcements.delete': W_(function (c, p) { var r = Announcements.remove(c, p); r.message = 'Announcement removed.'; return r; }),
  'announcements.publish': M_(Announcements.publish), 'announcements.retry': M_(Announcements.retry),
  'announcements.unpublish': W_(Announcements.unpublish),
  'announcements.pin': W_(Announcements.pin), 'announcements.unpin': W_(Announcements.unpin),

  // ---- intake ----
  'intake.get': R_(Intake.get),
  'intake.update': W_(function (c, p) { var r = Intake.update(c, p); r.message = 'Recruitment status updated.'; return r; }),

  // ---- quizzes ----
  'quizzes.list': R_(Quizzes.list), 'quizzes.form': R_(Quizzes.form), 'quizzes.show': W_(Quizzes.show),
  'quizzes.create': W_(function (c, p) { var r = Quizzes.create(c, p); r.message = 'Quiz created.'; return r; }),
  'quizzes.update': W_(function (c, p) { var r = Quizzes.update(c, p); r.message = 'Quiz updated.'; return r; }),
  'quizzes.grant': W_(function (c, p) { var r = Quizzes.grant(c, p); r.message = 'Access granted.'; return r; }),
  'quizzes.revoke': W_(function (c, p) { var r = Quizzes.revoke(c, p); r.message = 'Access revoked.'; return r; }),
  'quizzes.take': W_(Quizzes.take), 'quizzes.start': W_(Quizzes.start), 'quizzes.attempt': W_(Quizzes.attempt),
  'quizzes.saveAnswers': W_(Quizzes.saveAnswers), 'quizzes.submit': W_(function (c, p) { var r = Quizzes.submit(c, p); r.message = 'Quiz submitted.'; return r; }),
  'quizzes.event': W_(Quizzes.event),
  'quizzes.reviewGet': R_(Quizzes.reviewGet),
  'quizzes.reviewSave': W_(function (c, p) { var r = Quizzes.reviewSave(c, p); r.message = 'Review saved and grade recorded.'; return r; }),
  'quizzes.resetAttempt': W_(function (c, p) { var r = Quizzes.resetAttempt(c, p); r.message = 'Attempt reset.'; return r; })
  };
}
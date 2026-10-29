/** ViolationService.gs - violations (ViolationController/ViolationService/ViolationPolicy). */
var Violations = {
  live_: function () { return Repo.where('violations', function (v) { return !v.deleted_at; }); },
  mustFind_: function (id) {
    var v = typeof id === 'string' ? Repo.find('violations', id) : null;
    if (!v || v.deleted_at) notFound_('Violation not found.');
    return v;
  },
  rules_: function () {
    return { occurred_on: { required: true, type: 'date' }, description: { required: true, max: 2000 } };
  },
  assertNotFuture_: function (d) { if (d > U.today()) invalid_('occurred_on', 'The occurred on must be a date before or equal to today.'); },

  list: function (ctx, p) {
    var isManager = Authz.allows(ctx.user, PERM.VIOLATIONS_MANAGE);
    if (!isManager && !(U.isActive(ctx.user) && ctx.user.role === ROLE.TRAINEE)) forbidden_();
    p = p || {};
    var search = U.trim(p.search), users = Repo.index('users', 'id');
    var rows = Violations.live_().filter(function (v) {
      if (!isManager) return v.trainee_id === ctx.user.id;
      if (!search) return true;
      var t = users[v.trainee_id]; return !!t && U.matches(search, [t.name, t.username]);
    }).sort(function (a, b) { return U.cmp(b.occurred_on, a.occurred_on) || U.cmp(b.id, a.id); });
    var pg = paginate_(rows, p.page);
    return { violations: pg.data.map(function (v) {
      var t = users[v.trainee_id] || {}, i = v.issued_by ? users[v.issued_by] : null;
      return { id: v.id, trainee_name: t.name, trainee_username: t.username, issued_by: i ? i.name : v.issued_by_name, occurred_on: v.occurred_on,
        description: v.description, can_edit: isManager };
    }), meta: pg.meta, filters: { search: search }, can: { create: isManager } };
  },
  options: function (ctx) {
    Authz.require(ctx.user, PERM.VIOLATIONS_MANAGE);
    return { trainees: Users.live_().filter(function (u) { return u.role === ROLE.TRAINEE && u.status === USER_STATUS.ACTIVE; }).sort(U.byName).slice(0, 500)
      .map(function (u) { return { id: u.id, name: u.name, username: u.username }; }) };
  },
  get: function (ctx, p) {
    Authz.require(ctx.user, PERM.VIOLATIONS_MANAGE);
    var v = Violations.mustFind_(p && p.id), t = Repo.find('users', v.trainee_id) || {};
    return { violation: { id: v.id, trainee_name: t.name, trainee_username: t.username, occurred_on: v.occurred_on, description: v.description } };
  },
  create: function (ctx, p) {
    Authz.require(ctx.user, PERM.VIOLATIONS_MANAGE);
    var rules = Violations.rules_(); rules.trainee_id = { required: true, max: 64 };
    var v = validate_(p, rules);
    var t = Repo.find('users', v.trainee_id);
    if (!t || t.deleted_at || t.role !== ROLE.TRAINEE) invalid_('trainee_id', 'Choose a valid trainee.');
    Violations.assertNotFuture_(v.occurred_on);
    var rec = Repo.insert('violations', { trainee_id: t.id, issued_by: ctx.user.id, occurred_on: v.occurred_on, description: v.description });
    Audit.record('violation.created', ctx.user, 'violation', rec.id, { trainee_id: t.id });
    return { id: rec.id };
  },
  update: function (ctx, p) {
    Authz.require(ctx.user, PERM.VIOLATIONS_MANAGE);
    var cur = Violations.mustFind_(p && p.id), v = validate_(p, Violations.rules_());
    Violations.assertNotFuture_(v.occurred_on);
    var changed = ['occurred_on', 'description'].filter(function (k) { return cur[k] !== v[k]; });
    if (!changed.length) return {};
    Repo.update('violations', cur.id, { occurred_on: v.occurred_on, description: v.description });
    Audit.record('violation.updated', ctx.user, 'violation', cur.id, { fields: changed });
    return {};
  },
  remove: function (ctx, p) {
    Authz.require(ctx.user, PERM.VIOLATIONS_MANAGE);
    var cur = Violations.mustFind_(p && p.id);
    Repo.update('violations', cur.id, { deleted_by: ctx.user.id, deleted_at: U.nowIso() });
    Audit.record('violation.deleted', ctx.user, 'violation', cur.id, { trainee_id: cur.trainee_id });
    return {};
  }
};

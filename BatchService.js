/** BatchService.gs - batches and trainee assignments (BatchController/BatchService/BatchPolicy). */
var Batches = {
  live_: function () { return Repo.where('batches', function (b) { return !b.deleted_at; }); },
  mustFind_: function (id) {
    var b = typeof id === 'string' ? Repo.find('batches', id) : null;
    if (!b || b.deleted_at) notFound_('Batch not found.');
    return b;
  },
  daysLeft: function (b) {
    if (!b || !b.ends_on) return null;
    return Math.max(0, U.daysBetween(U.today(), b.ends_on));
  },
  hasEnded: function (b) { return !!(b && b.ends_on && b.ends_on < U.today()); },
  activeAssignments_: function (batchId) {
    return Repo.where('batch_assignments', function (a) { return !a.unassigned_at && (!batchId || a.batch_id === batchId); });
  },
  activeAssignmentOf: function (userId) {
    return Repo.first('batch_assignments', function (a) { return a.user_id === userId && !a.unassigned_at; });
  },
  canViewAny_: function (u) { return Authz.allows(u, PERM.BATCHES_VIEW) || Authz.allows(u, PERM.BATCHES_MANAGE); },
  canView_: function (u, b) {
    if (Batches.canViewAny_(u)) return true;
    return U.isActive(u) && Batches.activeAssignments_(b.id).some(function (a) { return a.user_id === u.id; });
  },
  rules_: function () {
    return { name: { required: true, max: 100 }, starts_on: { type: 'date' }, ends_on: { type: 'date' } };
  },
  validate_: function (p, ignoreId) {
    var v = validate_(p, Batches.rules_());
    var lower = v.name.toLowerCase();
    if (Repo.first('batches', function (b) { return !b.deleted_at && b.id !== ignoreId && b.name.toLowerCase() === lower; })) invalid_('name', 'A batch with this name already exists.');
    if (v.starts_on && v.ends_on && v.ends_on < v.starts_on) invalid_('ends_on', 'The end date must be on or after the start date.');
    return v;
  },

  list: function (ctx, p) {
    if (!Batches.canViewAny_(ctx.user)) forbidden_();
    p = p || {};
    var search = U.trim(p.search), counts = {};
    Batches.activeAssignments_().forEach(function (a) { counts[a.batch_id] = (counts[a.batch_id] || 0) + 1; });
    var rows = Batches.live_().filter(function (b) { return !search || U.matches(search, [b.name]); })
      .sort(function (a, b) { return U.cmp(b.starts_on || '', a.starts_on || '') || U.cmp(a.name, b.name); });
    var pg = paginate_(rows, p.page);
    return { batches: pg.data.map(function (b) {
      return { id: b.id, name: b.name, starts_on: b.starts_on, ends_on: b.ends_on, days_left: Batches.daysLeft(b), is_ended: Batches.hasEnded(b), trainee_count: counts[b.id] || 0 };
    }), meta: pg.meta, filters: { search: search }, can: { create: Authz.allows(ctx.user, PERM.BATCHES_MANAGE) } };
  },
  show: function (ctx, p) {
    var b = Batches.mustFind_(p && p.id);
    if (!Batches.canView_(ctx.user, b)) forbidden_();
    var canAssign = Authz.allows(ctx.user, PERM.BATCHES_MANAGE), users = Repo.index('users', 'id');
    var members = Batches.activeAssignments_(b.id).sort(function (a, c) { return U.cmp(a.assigned_at, c.assigned_at); }).map(function (a) {
      var u = users[a.user_id] || {};
      return { id: a.id, user_id: a.user_id, name: u.name, username: u.username, assigned_at: a.assigned_at };
    });
    var available = [];
    if (canAssign) {
      var batchNames = Repo.index('batches', 'id'), current = {};
      Batches.activeAssignments_().forEach(function (a) { current[a.user_id] = a; });
      available = Users.live_().filter(function (u) { return u.role === ROLE.TRAINEE && u.status === USER_STATUS.ACTIVE && !(current[u.id] && current[u.id].batch_id === b.id); })
        .sort(U.byName).slice(0, 500).map(function (u) {
          var cur = current[u.id];
          return { id: u.id, name: u.name, username: u.username, current_batch: cur && batchNames[cur.batch_id] ? batchNames[cur.batch_id].name : null };
        });
    }
    return { batch: { id: b.id, name: b.name, starts_on: b.starts_on, ends_on: b.ends_on, days_left: Batches.daysLeft(b), is_ended: Batches.hasEnded(b) }, members: members, available: available,
      can: { update: canAssign, 'delete': canAssign, assign: canAssign } };
  },
  create: function (ctx, p) {
    Authz.require(ctx.user, PERM.BATCHES_MANAGE);
    var v = Batches.validate_(p, null);
    var b = Repo.insert('batches', { name: v.name, starts_on: v.starts_on, ends_on: v.ends_on });
    Audit.record('batch.created', ctx.user, 'batch', b.id, { name: b.name });
    return { id: b.id };
  },
  update: function (ctx, p) {
    Authz.require(ctx.user, PERM.BATCHES_MANAGE);
    var b = Batches.mustFind_(p && p.id), v = Batches.validate_(p, b.id);
    var changed = ['name', 'starts_on', 'ends_on'].filter(function (k) { return (b[k] || null) !== (v[k] || null); });
    if (!changed.length) return { id: b.id };
    Repo.update('batches', b.id, { name: v.name, starts_on: v.starts_on, ends_on: v.ends_on });
    Audit.record('batch.updated', ctx.user, 'batch', b.id, { fields: changed });
    return { id: b.id };
  },
  remove: function (ctx, p) {
    Authz.require(ctx.user, PERM.BATCHES_MANAGE);
    var b = Batches.mustFind_(p && p.id);
    if (Batches.activeAssignments_(b.id).length) invalid_('batch', 'Remove all trainees from this batch before deleting it.');
    Repo.update('batches', b.id, { deleted_at: U.nowIso() });
    Audit.record('batch.deleted', ctx.user, 'batch', b.id, { name: b.name });
    return {};
  },
  assign: function (ctx, p) {
    Authz.require(ctx.user, PERM.BATCHES_MANAGE);
    var b = Batches.mustFind_(p && p.id), v = validate_(p, { user_id: { required: true, max: 64 } });
    var t = Repo.find('users', v.user_id);
    if (!t || t.deleted_at) invalid_('user_id', 'The selected trainee is invalid.');
    if (t.role !== ROLE.TRAINEE || !U.isActive(t)) invalid_('user_id', 'Only active trainees can be assigned to a batch.');
    var cur = Batches.activeAssignmentOf(t.id), now = U.nowIso();
    if (cur && cur.batch_id === b.id) return {};
    if (cur) {
      Repo.update('batch_assignments', cur.id, { unassigned_at: now });
      Audit.record('batch.trainee_unassigned', ctx.user, 'batch', cur.batch_id, { trainee_id: t.id, reason: 'transferred' });
    }
    Repo.insert('batch_assignments', { batch_id: b.id, user_id: t.id, assigned_at: now, assigned_by: ctx.user.id });
    Audit.record('batch.trainee_assigned', ctx.user, 'batch', b.id, { trainee_id: t.id, from_batch_id: cur ? cur.batch_id : null });
    if (!Repo.find('trainee_progress', t.id)) Repo.insert('trainee_progress', { trainee_id: t.id, current_phase: 1, updated_by: ctx.user.id });
    return {};
  },
  unassign: function (ctx, p) {
    Authz.require(ctx.user, PERM.BATCHES_MANAGE);
    var b = Batches.mustFind_(p && p.id), a = Repo.find('batch_assignments', p && p.assignment_id);
    if (!a || a.batch_id !== b.id) notFound_();
    if (a.unassigned_at) return {};
    Repo.update('batch_assignments', a.id, { unassigned_at: U.nowIso() });
    Audit.record('batch.trainee_unassigned', ctx.user, 'batch', b.id, { trainee_id: a.user_id, reason: 'removed' });
    return {};
  }
};

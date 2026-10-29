/** ProgressService.gs - trainee progress (ProgressController/ProgressService/TraineeProgressPolicy). */
var Progress = {
  maxPhase_: function () { return Config.getInt('MAX_PHASE') || 4; },
  batchOf_: function (userId) {
    var a = Batches.activeAssignmentOf(userId);
    return a ? Repo.find('batches', a.batch_id) : null;
  },
  list: function (ctx, p) {
    if (!Authz.allows(ctx.user, PERM.PROGRESS_MANAGE)) return { redirect: { page: 'dashboard' } };
    p = p || {};
    var search = U.trim(p.search), comps = GradeCalc.components(), users = Repo.index('users', 'id');
    var recs = {}; Repo.all('grade_records').forEach(function (r) { (recs[r.trainee_id] = recs[r.trainee_id] || {})[r.component_id] = r; });
    var rows = Users.live_().filter(function (u) { return u.role === ROLE.TRAINEE && u.status === USER_STATUS.ACTIVE && (!search || U.matches(search, [u.name, u.username])); }).sort(U.byName);
    var pg = paginate_(rows, p.page);
    return { trainees: pg.data.map(function (t) {
      var pr = Repo.find('trainee_progress', t.id), b = Progress.batchOf_(t.id), ph = resolveCurrentPhase_(comps, recs[t.id] || {});
      return { id: t.id, name: t.name, username: t.username, current_phase: ph ? ph.title : null, started_on: (b && b.starts_on) || (pr && pr.started_on) || null,
        remaining_days: Batches.daysLeft(b), batch_ended: Batches.hasEnded(b), updated_at: pr ? pr.updated_at : null,
        updated_by: pr && pr.updated_by && users[pr.updated_by] ? users[pr.updated_by].name : null };
    }), meta: pg.meta, filters: { search: search }, max_phase: Progress.maxPhase_() };
  },
  get: function (ctx, p) {
    Authz.require(ctx.user, PERM.PROGRESS_MANAGE);
    var t = Grades.trainee_(p && p.id), pr = Repo.find('trainee_progress', t.id), b = Progress.batchOf_(t.id);
    var up = pr && pr.updated_by ? Repo.find('users', pr.updated_by) : null;
    return { trainee: { id: t.id, name: t.name, username: t.username },
      progress: { current_phase: pr ? pr.current_phase : 1, started_on: pr ? pr.started_on : null, exists: !!pr, updated_at: pr ? pr.updated_at : null, updated_by: up ? up.name : null },
      batch_starts_on: b ? b.starts_on : null, batch_ends_on: b ? b.ends_on : null, remaining_days: Batches.daysLeft(b), batch_ended: Batches.hasEnded(b), max_phase: Progress.maxPhase_() };
  },
  save: function (ctx, p) {
    Authz.require(ctx.user, PERM.PROGRESS_MANAGE);
    var t = Grades.trainee_(p && p.id);
    var v = validate_(p, { current_phase: { required: true, type: 'int', min: 1, max: Progress.maxPhase_() } });
    var ex = Repo.find('trainee_progress', t.id), from = ex ? ex.current_phase : null;
    if (ex && from === v.current_phase) return {};
    if (ex) Repo.update('trainee_progress', t.id, { current_phase: v.current_phase, updated_by: ctx.user.id });
    else Repo.insert('trainee_progress', { trainee_id: t.id, current_phase: v.current_phase, updated_by: ctx.user.id });
    Audit.record('progress.updated', ctx.user, 'user', t.id, { phase_from: from, phase_to: v.current_phase });
    return {};
  }
};

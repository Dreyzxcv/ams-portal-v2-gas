/** GradeService.gs - grade components, records, revisions (GradeController/GradeService/GradeComponent). */
var GradeCalc = {
  components: function () {
    return Repo.where('grade_components', function (c) { return c.active; }).sort(function (a, b) { return a.sequence - b.sequence; });
  },
  /** Total points of the quiz attached to a quiz-based component, else null. */
  quizTotals: function () {
    var totalsByQuiz = {};
    Repo.all('quiz_questions').forEach(function (q) { totalsByQuiz[q.quiz_id] = (totalsByQuiz[q.quiz_id] || 0) + q.points; });
    var out = {};
    Repo.all('quizzes').forEach(function (qz) { if (totalsByQuiz[qz.id] > 0) out[qz.grade_component_key] = U.round2(totalsByQuiz[qz.id]); });
    return out;
  },
  effMax: function (c, totals) {
    totals = totals || GradeCalc.quizTotals();
    return QUIZ_KEYS.indexOf(c.key) !== -1 && totals[c.key] ? totals[c.key] : c.max_score;
  },
  effPass: function (c, totals) {
    totals = totals || GradeCalc.quizTotals();
    if (QUIZ_KEYS.indexOf(c.key) !== -1 && totals[c.key]) return U.round2(totals[c.key] * (c.pass_score / c.max_score));
    return c.pass_score;
  },
  isPassing: function (c, score, totals) { return U.round2(score) >= GradeCalc.effPass(c, totals); },
  fmt: function (n) { return n === null || n === undefined ? null : U.round2(n).toFixed(2); }
};

/** First active component with no score yet (app/Support/CurrentPhase.php). records keyed by component_id. */
function resolveCurrentPhase_(components, records) {
  if (!components.length) return null;
  var next = null;
  for (var i = 0; i < components.length; i++) {
    var r = records[components[i].id];
    if (!r || r.score === null) { next = components[i]; break; }
  }
  if (!next) return { short: 'Done', title: 'Completed' };
  if (next.key === 'final_exam') return { short: 'Final', title: 'Final Examination' };
  var short = next.key.replace(/^phase_/, '').replace(/_/g, '.');
  return { short: short, title: 'Phase ' + short };
}

var Grades = {
  recordsOf_: function (traineeId) {
    var m = {};
    Repo.where('grade_records', function (r) { return r.trainee_id === traineeId; }).forEach(function (r) { m[r.component_id] = r; });
    return m;
  },
  /** A "trainee" target for grading/certificates/progress: Medical Trainee or Graduate. */
  trainee_: function (id) {
    var t = typeof id === 'string' ? Repo.find('users', id) : null;
    if (!t || t.deleted_at || (t.role !== ROLE.TRAINEE && t.role !== ROLE.GRADUATE)) notFound_('Trainee not found.');
    return t;
  },

  index: function (ctx, p) {
    // Graduates only see their grades on their dashboard, not on the Grades pages.
    if (Authz.isGraduate(ctx.user)) forbidden_();
    if (!Authz.allows(ctx.user, PERM.GRADES_VIEW_ALL)) return { redirect: { page: 'grades/show', id: ctx.user.id } };
    p = p || {};
    // Medical Trainees only by default; staff can switch on "Include graduates" to list graduates too.
    var withGraduates = p.graduates === true || p.graduates === 1 || p.graduates === '1' || p.graduates === 'true';
    var search = U.trim(p.search), totals = GradeCalc.quizTotals(), comps = GradeCalc.components();
    var scoresByTrainee = {};
    Repo.all('grade_records').forEach(function (r) { (scoresByTrainee[r.trainee_id] = scoresByTrainee[r.trainee_id] || {})[r.component_id] = r.score; });
    var rows = Users.live_().filter(function (u) {
      return (u.role === ROLE.TRAINEE || (withGraduates && u.role === ROLE.GRADUATE)) && (!search || U.matches(search, [u.name, u.username]));
    }).sort(U.byName);
    var pg = paginate_(rows, p.page);
    return { trainees: pg.data.map(function (t) { return { id: t.id, name: t.name, username: t.username, role: t.role, scores: scoresByTrainee[t.id] || {} }; }), meta: pg.meta,
      components: comps.map(function (c) { return { id: c.id, label: c.label, max_score: GradeCalc.fmt(GradeCalc.effMax(c, totals)), pass_score: GradeCalc.fmt(GradeCalc.effPass(c, totals)) }; }),
      filters: { search: search, graduates: withGraduates } };
  },

  show: function (ctx, p) {
    // A graduate cannot open the Grades page, even their own (their grades are on the dashboard).
    var t = Grades.trainee_(p && p.id), isSelf = U.isActive(ctx.user) && ctx.user.id === t.id && !Authz.isGraduate(ctx.user);
    if (!isSelf && !Authz.allows(ctx.user, PERM.GRADES_VIEW_ALL)) forbidden_();
    var totals = GradeCalc.quizTotals(), records = Grades.recordsOf_(t.id), users = Repo.index('users', 'id');
    var rows = GradeCalc.components().map(function (c) {
      var r = records[c.id], score = r ? r.score : null;
      return { component_id: c.id, label: c.label, max_score: GradeCalc.fmt(GradeCalc.effMax(c, totals)), pass_score: GradeCalc.fmt(GradeCalc.effPass(c, totals)),
        is_final: c.is_final, score: score === null ? null : GradeCalc.fmt(score), passed: score === null ? null : GradeCalc.isPassing(c, score, totals),
        graded_by: r && r.graded_by && users[r.graded_by] ? users[r.graded_by].name : null, graded_at: r ? r.graded_at : null };
    });
    var recById = {}; Object.keys(records).forEach(function (k) { recById[records[k].id] = records[k]; });
    var comps = Repo.index('grade_components', 'id');
    var revisions = Repo.where('grade_revisions', function (r) { return !!recById[r.grade_record_id]; })
      .sort(function (a, b) { return U.cmp(b.changed_at, a.changed_at) || U.cmp(b.id, a.id); }).slice(0, 50).map(function (r) {
        var rec = recById[r.grade_record_id], c = comps[rec.component_id];
        return { id: r.id, component: c ? c.label : null, old_score: GradeCalc.fmt(r.old_score), new_score: GradeCalc.fmt(r.new_score),
          changed_by: r.changed_by && users[r.changed_by] ? users[r.changed_by].name : null, changed_at: r.changed_at, reason: r.reason };
      });
    return { trainee: { id: t.id, name: t.name, username: t.username }, rows: rows, revisions: revisions,
      can: { manage: !isSelf && Authz.allows(ctx.user, PERM.GRADES_MANAGE), viewAll: Authz.allows(ctx.user, PERM.GRADES_VIEW_ALL) } };
  },

  save: function (ctx, p) {
    Authz.require(ctx.user, PERM.GRADES_MANAGE);
    var t = Grades.trainee_(p && p.trainee_id);
    if (Authz.isSelf(ctx.user, t)) forbidden_('You cannot grade yourself.');
    var comp = Repo.find('grade_components', p && p.component_id);
    if (!comp) notFound_('Component not found.');
    var max = GradeCalc.effMax(comp);
    var v = validate_(p, { score: { required: true, type: 'num', min: 0, max: max, decimals: 2, maxMsg: 'The score cannot be higher than the maximum for this component.' }, reason: { max: 500 } });
    GradeWriter.save(ctx.user, t, comp, v.score, v.reason);
    return {};
  }
};

/** Shared write path used by manual grading and quiz review. Caller already holds the lock and authorization. */
var GradeWriter = {
  save: function (actor, trainee, comp, score, reason) {
    if (trainee.role !== ROLE.TRAINEE && trainee.role !== ROLE.GRADUATE) invalid_('score', 'Grades can only be recorded for trainees.');
    if (!comp.active) invalid_('score', 'This grading component is no longer active.');
    var rec = Repo.first('grade_records', function (r) { return r.trainee_id === trainee.id && r.component_id === comp.id; });
    var old = rec ? rec.score : null, nu = U.round2(score);
    if (old !== null && U.round2(old) === nu) return;
    reason = reason ? String(reason).trim() : null;
    if (old !== null && !reason) invalid_('reason', 'Give a reason when changing an existing score.');
    var now = U.nowIso();
    if (rec) Repo.update('grade_records', rec.id, { score: nu, graded_by: actor.id, graded_at: now });
    else rec = Repo.insert('grade_records', { trainee_id: trainee.id, component_id: comp.id, score: nu, graded_by: actor.id, graded_at: now });
    Repo.insert('grade_revisions', { grade_record_id: rec.id, old_score: old, new_score: nu, changed_by: actor.id, changed_at: now, reason: reason || null });
    Audit.record('grade.saved', actor, 'user', trainee.id, { component: comp.key, old: old, 'new': nu });
  },
  clear: function (actor, trainee, comp, reason) {
    var rec = Repo.first('grade_records', function (r) { return r.trainee_id === trainee.id && r.component_id === comp.id; });
    if (!rec || rec.score === null) return false;
    var old = rec.score;
    Repo.update('grade_records', rec.id, { score: null, graded_by: null, graded_at: null });
    Repo.insert('grade_revisions', { grade_record_id: rec.id, old_score: old, new_score: null, changed_by: actor.id, changed_at: U.nowIso(), reason: reason });
    Audit.record('grade.cleared', actor, 'user', trainee.id, { component: comp.key, old: old });
    return true;
  }
};
/** DashboardService.gs - staff and trainee dashboards (DashboardService.php). Every number is computed from stored records. */
var Dashboard = {
  get: function (ctx) { return ctx.user.role === ROLE.TRAINEE ? Dashboard.trainee_(ctx.user) : Dashboard.staff_(ctx.user); },

  staff_: function (u) {
    var groups = [], users = Users.live_(), today = U.today();
    if (Authz.allows(u, PERM.USERS_MANAGE)) {
      groups.push({ title: 'Users', stats: [
        { label: 'Total users', value: users.length, href: '#/users' },
        { label: 'Active users', value: users.filter(function (x) { return x.status === USER_STATUS.ACTIVE; }).length, href: '#/users?status=active' },
        { label: 'Trainees', value: users.filter(function (x) { return x.role === ROLE.TRAINEE; }).length, href: '#/users?role=trainee' }] });
    }
    var activeAs = Batches.activeAssignments_(), batches = Batches.live_();
    if (Authz.allows(u, PERM.BATCHES_VIEW)) {
      var inBatch = {}; activeAs.forEach(function (a) { inBatch[a.user_id] = true; });
      groups.push({ title: 'Batches', stats: [
        { label: 'Batches', value: batches.length, href: '#/batches' },
        { label: 'Trainees in a batch', value: activeAs.length, href: null },
        { label: 'Active trainees without a batch', value: users.filter(function (x) { return x.role === ROLE.TRAINEE && x.status === USER_STATUS.ACTIVE && !inBatch[x.id]; }).length, href: null }] });
    }
    if (Authz.allows(u, PERM.GRADES_VIEW_ALL)) {
      var totals = GradeCalc.quizTotals(), final = GradeCalc.components().filter(function (c) { return c.is_final; })[0];
      var passed = final ? Repo.count('grade_records', function (r) { return r.component_id === final.id && r.score !== null && r.score >= GradeCalc.effPass(final, totals); }) : 0;
      var since = U.addDays(U.nowIso(), -7);
      groups.push({ title: 'Grades', stats: [
        { label: 'Grades entered, last 7 days', value: Repo.count('grade_records', function (r) { return r.graded_at && r.graded_at >= since; }), href: '#/grades' },
        { label: 'Trainees who passed the final exam', value: passed, href: null }] });
    }
    if (Authz.allows(u, PERM.VIOLATIONS_MANAGE)) {
      var d30 = U.addDaysStr(today, -30), live = Violations.live_();
      groups.push({ title: 'Violations', stats: [
        { label: 'Last 30 days', value: live.filter(function (v) { return v.occurred_on >= d30; }).length, href: '#/violations' },
        { label: 'All time', value: live.length, href: '#/violations' }] });
    }
    if (Authz.allows(u, PERM.PROGRESS_MANAGE)) {
      var hasProg = {}; Repo.all('trainee_progress').forEach(function (p) { hasProg[p.trainee_id] = true; });
      groups.push({ title: 'Progress', stats: [
        { label: 'Active trainees with no phase set', value: users.filter(function (x) { return x.role === ROLE.TRAINEE && x.status === USER_STATUS.ACTIVE && !hasProg[x.id]; }).length, href: '#/progress' }] });
    }
    if (Authz.allows(u, PERM.CERTIFICATES_MANAGE)) {
      var cnt = function (s) { return Repo.count('certificates', function (c) { return c.status === s; }); };
      groups.push({ title: 'Certificates', stats: [{ label: 'Pending', value: cnt(CERT_STATUS.PENDING), href: null }, { label: 'Issued', value: cnt(CERT_STATUS.ISSUED), href: null }, { label: 'Revoked', value: cnt(CERT_STATUS.REVOKED), href: null }] });
    }
    var activity = null;
    if (Authz.allows(u, PERM.LOGS_VIEW)) {
      activity = Repo.all('audit_logs').slice(-200).sort(function (a, b) { return U.cmp(b.occurred_at, a.occurred_at) || U.cmp(b.id, a.id); }).slice(0, 10).map(function (l) {
        return { id: l.id, occurred_at: l.occurred_at, actor: l.actor_username || 'system', action: l.action, subject: l.subject_type ? l.subject_type + ' #' + l.subject_id : null };
      });
    }
    var batchList = null;
    if (Authz.allows(u, PERM.BATCHES_VIEW)) {
      var counts = {}; activeAs.forEach(function (a) { counts[a.batch_id] = (counts[a.batch_id] || 0) + 1; });
      batchList = batches.slice().sort(function (a, b) { return U.cmp(b.created_at, a.created_at) || U.cmp(b.id, a.id); }).map(function (b) { return { id: b.id, name: b.name, members: counts[b.id] || 0 }; });
    }
    return { mode: 'staff', batches: batchList, groups: groups, activity: activity, trainee: null, trend: Dashboard.trend_(u) };
  },

  trainee_: function (u) {
    var a = Batches.activeAssignmentOf(u.id), batch = a ? Repo.find('batches', a.batch_id) : null, prog = Repo.find('trainee_progress', u.id);
    var totals = GradeCalc.quizTotals(), comps = GradeCalc.components(), recs = Grades.recordsOf_(u.id);
    var phase = resolveCurrentPhase_(comps, recs);
    var entered = comps.filter(function (c) { return recs[c.id] && recs[c.id].score !== null; });
    var passed = entered.filter(function (c) { return GradeCalc.isPassing(c, recs[c.id].score, totals); });
    var cert = Repo.first('certificates', function (c) { return c.trainee_id === u.id && c.status === CERT_STATUS.ISSUED; });
    var file = cert && cert.file_id ? Repo.find('stored_files', cert.file_id) : null;
    return { mode: 'trainee', groups: [], activity: null, batches: null, trend: null, trainee: {
      batch: batch ? batch.name : null, current_phase: phase ? phase.short : null, current_phase_title: phase ? phase.title : null,
      started_on: (batch && batch.starts_on) || (prog && prog.started_on) || null,
      components: comps.slice().sort(function (x, y) { return U.cmp(x.id, y.id); }).map(function (c) {
        var s = recs[c.id] ? recs[c.id].score : null;
        return { name: c.label, score: s, max: GradeCalc.effMax(c, totals), passed: s === null ? null : GradeCalc.isPassing(c, s, totals) };
      }),
      grades_total: comps.length, grades_entered: entered.length, grades_passed: passed.length,
      violations: Repo.count('violations', function (v) { return !v.deleted_at && v.trainee_id === u.id; }),
      certificate_id: cert ? cert.id : null, certificate_mime: file ? file.mime_type : null, certificate_number: cert ? cert.certificate_number : null,
      certificate_issued_at: cert ? U.dayOf(cert.issued_at) : null, remaining_days: Batches.daysLeft(batch), batch_ended: Batches.hasEnded(batch), trend: null } };
  },

  /** Eight ISO weeks (Monday start) of grades entered and violations recorded. */
  trend_: function (u) {
    var weeks = 8, startDay = U.addDaysStr(U.weekStart(U.today()), -7 * (weeks - 1)), labels = [];
    for (var i = 0; i < weeks; i++) labels.push(U.addDaysStr(startDay, 7 * i));
    function bucket(days) {
      var counts = {}; labels.forEach(function (l) { counts[l] = 0; });
      days.forEach(function (d) { if (!d) return; var k = U.weekStart(d); if (counts[k] !== undefined) counts[k]++; });
      return labels.map(function (l) { return counts[l]; });
    }
    var series = [];
    if (Authz.allows(u, PERM.GRADES_VIEW_ALL)) series.push({ label: 'Grades entered', values: bucket(Repo.where('grade_records', function (r) { return !!r.graded_at; }).map(function (r) { return U.dayOf(r.graded_at); })) });
    if (Authz.allows(u, PERM.VIOLATIONS_MANAGE)) series.push({ label: 'Violations', values: bucket(Violations.live_().map(function (v) { return v.occurred_on; })) });
    return series.length ? { weeks: labels, series: series } : null;
  }
};

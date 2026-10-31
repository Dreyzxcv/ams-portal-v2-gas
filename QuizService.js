/**
 * QuizService.gs - timed quizzes (QuizController/QuizAttemptController/QuizReviewController/QuizService/QuizPolicy).
 * Quiz mutations run inside the script lock (API router) which replaces the row locks used in PostgreSQL.
 */
var Quizzes = {
  mustFind_: function (id) {
    var q = typeof id === 'string' ? Repo.find('quizzes', id) : null;
    if (!q) notFound_('Quiz not found.');
    return q;
  },
  mustFindAttempt_: function (id, quizId) {
    var a = typeof id === 'string' ? Repo.find('quiz_attempts', id) : null;
    if (!a || (quizId && a.quiz_id !== quizId)) notFound_('Attempt not found.');
    return a;
  },
  questionsOf_: function (quizId) {
    return Repo.where('quiz_questions', function (q) { return q.quiz_id === quizId; }).sort(function (a, b) { return a.position - b.position; });
  },
  componentOf_: function (key) { return Repo.first('grade_components', function (c) { return c.key === key; }); },
  totalPoints_: function (quizId) { return U.round2(Quizzes.questionsOf_(quizId).reduce(function (s, q) { return s + q.points; }, 0)); },
  activeAccess_: function (quizId, traineeId) {
    return Repo.first('quiz_accesses', function (a) { return a.quiz_id === quizId && a.trainee_id === traineeId && !a.revoked_at; });
  },
  attemptOf_: function (quizId, traineeId) {
    return Repo.first('quiz_attempts', function (a) { return a.quiz_id === quizId && a.trainee_id === traineeId; });
  },
  canManage_: function (u) { return Authz.allows(u, PERM.QUIZZES_MANAGE); },
  ensureManager_: function (u) { if (!Quizzes.canManage_(u)) forbidden_(); },
  /** Can open the staff quiz list/detail and grant or revoke trainee access (but not create or edit quizzes). */
  canView_: function (u) { return Authz.allows(u, PERM.QUIZZES_MANAGE) || Authz.allows(u, PERM.QUIZZES_ACCESS); },
  ensureViewer_: function (u) { if (!Quizzes.canView_(u)) forbidden_(); },
  hasAccess_: function (u, quiz) { return U.isActive(u) && u.role === ROLE.TRAINEE && !!Quizzes.activeAccess_(quiz.id, u.id); },
  ensureAccess_: function (u, quiz) { if (!Quizzes.hasAccess_(u, quiz)) forbidden_(); },
  isSubmitted_: function (a) { return !!a.submitted_at; },
  isReviewed_: function (a) { return !!a.reviewed_at; },
  attemptStatus_: function (a) {
    if (!a) return 'available';
    if (a.reviewed_at) return 'graded';
    if (a.submitted_at) return 'submitted';
    return 'in_progress';
  },

  /* ---------- queries ---------- */
  list: function (ctx) {
    var u = ctx.user, comps = Repo.index('grade_components', 'key');
    if (Quizzes.canView_(u)) {
      var attemptsBy = {}, accessBy = {};
      Repo.all('quiz_attempts').forEach(function (a) { (attemptsBy[a.quiz_id] = attemptsBy[a.quiz_id] || []).push(a); });
      Repo.all('quiz_accesses').forEach(function (a) { if (!a.revoked_at) accessBy[a.quiz_id] = (accessBy[a.quiz_id] || 0) + 1; });
      var qcount = {}, pts = {};
      Repo.all('quiz_questions').forEach(function (q) { qcount[q.quiz_id] = (qcount[q.quiz_id] || 0) + 1; pts[q.quiz_id] = (pts[q.quiz_id] || 0) + q.points; });
      var quizzes = Repo.all('quizzes').slice().sort(function (a, b) { return U.cmp(a.grade_component_key, b.grade_component_key); }).map(function (q) {
        var at = attemptsBy[q.id] || [];
        return { id: q.id, title: q.title, phase_key: q.grade_component_key, phase: comps[q.grade_component_key] ? comps[q.grade_component_key].label : q.grade_component_key,
          duration_minutes: q.duration_minutes, question_count: qcount[q.id] || 0, total_points: U.round2(pts[q.id] || 0), access_count: accessBy[q.id] || 0,
          attempt_count: at.length, submitted_count: at.filter(function (a) { return a.submitted_at; }).length,
          pending_review: at.filter(function (a) { return a.submitted_at && !a.reviewed_at; }).length };
      });
      var have = {}; Repo.all('quizzes').forEach(function (q) { have[q.grade_component_key] = true; });
      return { mode: 'manage', quizzes: quizzes, can_create: Quizzes.canManage_(u) && Quizzes.eligible_().some(function (c) { return !have[c.key]; }) };
    }
    if (U.isActive(u) && u.role === ROLE.TRAINEE) {
      var out = [], now = U.nowIso();
      Repo.where('quiz_accesses', function (a) { return a.trainee_id === u.id && !a.revoked_at; }).forEach(function (acc) {
        var q = Repo.find('quizzes', acc.quiz_id); if (!q) return;
        var at = Quizzes.attemptOf_(q.id, u.id), st = Quizzes.attemptStatus_(at);
        if (st === 'in_progress' && at.expires_at <= now) st = 'submitted';
        out.push({ id: q.id, title: q.title, phase: comps[q.grade_component_key] ? comps[q.grade_component_key].label : '', duration_minutes: q.duration_minutes,
          status: st, attempt_id: at ? at.id : null, total_points: Quizzes.totalPoints_(q.id), score: at && at.reviewed_at ? at.final_score : null });
      });
      return { mode: 'trainee', quizzes: out };
    }
    forbidden_();
  },
  eligible_: function () { return GradeCalc.components().filter(function (c) { return QUIZ_KEYS.indexOf(c.key) !== -1; }); },
  questionPayload_: function (q, withKey) {
    var o = { id: q.id, type: q.type, prompt: q.prompt, points: q.points, options: q.options, position: q.position };
    if (withKey) o.correct_option = q.correct_option;
    return o;
  },
  form: function (ctx, p) {
    Quizzes.ensureManager_(ctx.user);
    var quiz = p && p.id ? Quizzes.mustFind_(p.id) : null, have = {};
    Repo.all('quizzes').forEach(function (q) { if (!quiz || q.id !== quiz.id) have[q.grade_component_key] = true; });
    var out = { components: Quizzes.eligible_().filter(function (c) { return !have[c.key]; }).map(function (c) { return { key: c.key, label: c.label }; }), quiz: null, has_attempts: false };
    if (quiz) {
      out.quiz = { id: quiz.id, grade_component_key: quiz.grade_component_key, title: quiz.title, instructions: quiz.instructions, duration_minutes: quiz.duration_minutes,
        questions: Quizzes.questionsOf_(quiz.id).map(function (q) { return Quizzes.questionPayload_(q, true); }) };
      out.has_attempts = Repo.count('quiz_attempts', function (a) { return a.quiz_id === quiz.id; }) > 0;
    }
    return out;
  },
  show: function (ctx, p) {
    var quiz = Quizzes.mustFind_(p && p.id), u = ctx.user;
    if (!Quizzes.canView_(u)) {
      Quizzes.ensureAccess_(u, quiz);
      return Quizzes.take(ctx, p);
    }
    var users = Repo.index('users', 'id'), comp = Quizzes.componentOf_(quiz.grade_component_key);
    var accesses = Repo.where('quiz_accesses', function (a) { return a.quiz_id === quiz.id; }).map(function (a) {
      var t = users[a.trainee_id] || {};
      return { trainee_id: a.trainee_id, name: t.name, username: t.username, granted_at: a.granted_at, revoked_at: a.revoked_at };
    }).sort(function (a, b) { return U.cmp(U.lower(a.name), U.lower(b.name)); });
    var attempts = Repo.where('quiz_attempts', function (a) { return a.quiz_id === quiz.id; }).map(function (a) {
      var t = users[a.trainee_id] || {}, rv = a.reviewed_by ? users[a.reviewed_by] : null;
      return { id: a.id, trainee_id: a.trainee_id, name: t.name, username: t.username, status: Quizzes.attemptStatus_(a), started_at: a.started_at, expires_at: a.expires_at,
        submitted_at: a.submitted_at, auto_score: a.auto_score, manual_score: a.manual_score, final_score: a.final_score, reviewed_by: rv ? rv.name : null };
    }).sort(function (a, b) { return U.cmp(U.lower(a.name), U.lower(b.name)); });
    var granted = {}; accesses.forEach(function (a) { if (!a.revoked_at) granted[a.trainee_id] = true; });
    var available = Users.live_().filter(function (t) { return t.role === ROLE.TRAINEE && t.status === USER_STATUS.ACTIVE && !granted[t.id]; })
      .sort(U.byName).slice(0, 500).map(function (t) { return { id: t.id, name: t.name, username: t.username }; });
    return { quiz: { id: quiz.id, title: quiz.title, instructions: quiz.instructions, duration_minutes: quiz.duration_minutes, phase_key: quiz.grade_component_key,
      phase: comp ? comp.label : quiz.grade_component_key, total_points: Quizzes.totalPoints_(quiz.id) },
      questions: Quizzes.questionsOf_(quiz.id).map(function (q) { return Quizzes.questionPayload_(q, true); }),
      accesses: accesses, attempts: attempts, available_trainees: available,
      can: { manage: Quizzes.canManage_(u), reset: Authz.allows(u, PERM.QUIZZES_RESET_ATTEMPTS) } };
  },

  /* ---------- create / update ---------- */
  validateData_: function (p) {
    var v = validate_(p, { grade_component_key: { required: true, type: 'enum', 'in': QUIZ_KEYS }, title: { required: true, max: 150 },
      instructions: { required: true, max: 10000 }, duration_minutes: { required: true, type: 'int', min: 1, max: 65535 } });
    var qs = p && p.questions;
    if (!Array.isArray(qs) || qs.length < 1) invalid_('questions', 'Add at least one question.');
    if (qs.length > 100) invalid_('questions', 'A quiz can have at most 100 questions.');
    v.questions = qs.map(function (raw, i) {
      raw = raw || {};
      var q = validate_(raw, { type: { required: true, type: 'enum', 'in': ['multiple_choice', 'paragraph'] }, prompt: { required: true, max: 10000 },
        points: { required: true, type: 'num', gt: 0, decimals: 2, max: 99999.99 } });
      var err = function (m) { var f = {}; f['questions.' + i] = m; throw new AppError('VALIDATION_ERROR', 'Question ' + (i + 1) + ': ' + m, f, 422); };
      if (raw.id !== undefined && raw.id !== null && raw.id !== '') q.id = String(raw.id);
      if (q.type === 'multiple_choice') {
        var opts = raw.options;
        if (!Array.isArray(opts) || opts.length < 2 || opts.length > 8) err('Provide between 2 and 8 answer options.');
        opts = opts.map(function (o) {
          if (typeof o !== 'string' || !o.trim()) err('Answer options cannot be empty.');
          if (o.length > 1000) err('An answer option is too long.');
          return o;
        });
        var norm = opts.map(function (o) { return o.trim().toLowerCase(); });
        if (norm.filter(function (o, j) { return norm.indexOf(o) !== j; }).length) err('Answer options must be different.');
        var co = raw.correct_option;
        if (typeof co === 'string' && /^\d+$/.test(co)) co = parseInt(co, 10);
        if (typeof co !== 'number' || co % 1 !== 0 || co < 0 || co >= opts.length) err('Choose one of the available answer options as the correct answer.');
        q.options = opts; q.correct_option = co;
      } else {
        if ((raw.options !== undefined && raw.options !== null) || (raw.correct_option !== undefined && raw.correct_option !== null && raw.correct_option !== ''))
          err('Paragraph questions cannot have answer options or an answer key.');
        q.options = null; q.correct_option = null;
      }
      return q;
    });
    return v;
  },
  eligibleComponent_: function (key) {
    var c = Quizzes.componentOf_(key);
    if (QUIZ_KEYS.indexOf(key) === -1) invalid_('grade_component_key', 'Quizzes are only available for Phase 1 and the Final Examination.');
    if (!c || !c.active) notFound_('Grading component not found.');
    return c;
  },
  saveQuestions_: function (quizId, questions) {
    Repo.insertMany('quiz_questions', questions.map(function (q, i) {
      return { quiz_id: quizId, type: q.type, prompt: q.prompt, points: U.round2(q.points), options: q.options, correct_option: q.correct_option, position: i + 1 };
    }));
  },
  create: function (ctx, p) {
    Quizzes.ensureManager_(ctx.user);
    var v = Quizzes.validateData_(p), comp = Quizzes.eligibleComponent_(v.grade_component_key);
    if (Repo.first('quizzes', function (q) { return q.grade_component_key === comp.key; })) invalid_('grade_component_key', 'A quiz already exists for this phase.');
    var quiz = Repo.insert('quizzes', { grade_component_key: comp.key, title: v.title, instructions: v.instructions, duration_minutes: v.duration_minutes });
    Quizzes.saveQuestions_(quiz.id, v.questions);
    Audit.record('quiz.created', ctx.user, 'quiz', quiz.id, { grade_component: comp.key });
    return { id: quiz.id };
  },
  update: function (ctx, p) {
    Quizzes.ensureManager_(ctx.user);
    var quiz = Quizzes.mustFind_(p && p.id), v = Quizzes.validateData_(p), comp = Quizzes.eligibleComponent_(v.grade_component_key);
    var hasAttempts = Repo.count('quiz_attempts', function (a) { return a.quiz_id === quiz.id; }) > 0;
    if (hasAttempts && comp.key !== quiz.grade_component_key) invalid_('grade_component_key', 'A quiz phase cannot be changed after an attempt starts.');
    if (Repo.first('quizzes', function (q) { return q.grade_component_key === comp.key && q.id !== quiz.id; })) invalid_('grade_component_key', 'A quiz already exists for this phase.');
    // Sheets has no rollback: run every check that can fail BEFORE the first write.
    if (hasAttempts) Quizzes.assertQuestionsMatch_(quiz, v.questions);
    Repo.update('quizzes', quiz.id, { grade_component_key: comp.key, title: v.title, instructions: v.instructions, duration_minutes: v.duration_minutes });
    if (hasAttempts) { Quizzes.updateQuestionsWithAttempts_(quiz, v.questions); Quizzes.regradeAttempts_(ctx.user, Repo.find('quizzes', quiz.id)); }
    else { Repo.removeWhere('quiz_questions', function (q) { return q.quiz_id === quiz.id; }); Quizzes.saveQuestions_(quiz.id, v.questions); }
    Audit.record('quiz.updated', ctx.user, 'quiz', quiz.id, { grade_component: comp.key });
    return { id: quiz.id };
  },
  assertQuestionsMatch_: function (quiz, questions) {
    var existingIds = Quizzes.questionsOf_(quiz.id).map(function (q) { return q.id; });
    var submitted = questions.filter(function (q) { return q.id; }).map(function (q) { return q.id; });
    if (JSON.stringify(submitted) !== JSON.stringify(existingIds)) invalid_('questions', 'Existing questions cannot be removed or reordered after an attempt starts.');
  },
  updateQuestionsWithAttempts_: function (quiz, questions) {
    var existing = Quizzes.questionsOf_(quiz.id);
    var pos = existing.reduce(function (m, q) { return Math.max(m, q.position); }, 0), fresh = [];
    questions.forEach(function (q) {
      var attrs = { type: q.type, prompt: q.prompt, points: U.round2(q.points), options: q.options, correct_option: q.correct_option };
      if (q.id) Repo.update('quiz_questions', q.id, attrs);
      else fresh.push(Object.assign({ quiz_id: quiz.id, position: ++pos }, attrs));
    });
    Repo.insertMany('quiz_questions', fresh);
  },
  regradeAttempts_: function (actor, quiz) {
    var comp = Quizzes.componentOf_(quiz.grade_component_key), questions = Quizzes.questionsOf_(quiz.id), total = Quizzes.totalPoints_(quiz.id);
    Repo.where('quiz_attempts', function (a) { return a.quiz_id === quiz.id; }).forEach(function (att) {
      var answers = {}; Repo.where('quiz_answers', function (a) { return a.quiz_attempt_id === att.id; }).forEach(function (a) { answers[a.quiz_question_id] = a; });
      var auto = 0, manual = 0, patches = [];
      questions.forEach(function (q) {
        var a = answers[q.id]; if (!a) return;
        if (q.type === 'multiple_choice') {
          var s = a.selected_option !== null && a.selected_option === q.correct_option ? q.points : 0;
          patches.push({ pk: a.id, patch: { answer_text: null, auto_score: s, manual_score: null } }); auto += s;
        } else {
          var m = Math.min(a.manual_score || 0, q.points);
          patches.push({ pk: a.id, patch: { selected_option: null, auto_score: null, manual_score: m } });
          if (att.submitted_at) manual += m;
        }
      });
      Repo.updateMany('quiz_answers', patches);
      if (!att.submitted_at) return;
      var changes = { auto_score: U.round2(auto) }, finalScore = null;
      if (att.reviewed_at) {
        finalScore = U.round2(auto + manual);
        changes.manual_score = U.round2(manual); changes.final_score = finalScore;
        GradeWriter.save(actor, Repo.find('users', att.trainee_id), comp, finalScore, 'Quiz updated: ' + quiz.title);
      }
      Repo.update('quiz_attempts', att.id, changes);
      Audit.record('quiz.attempt_regraded', actor, 'quiz_attempt', att.id, { auto_score: U.round2(auto), manual_score: att.reviewed_at ? U.round2(manual) : null, final_score: finalScore, total_points: total });
    });
  },

  /* ---------- access ---------- */
  grant: function (ctx, p) {
    Quizzes.ensureViewer_(ctx.user);
    var quiz = Quizzes.mustFind_(p && p.id), t = Repo.find('users', p && p.trainee_id);
    if (!t || t.deleted_at || t.role !== ROLE.TRAINEE || !U.isActive(t)) invalid_('trainee_id', 'Access can only be granted to an active trainee.');
    var acc = Repo.first('quiz_accesses', function (a) { return a.quiz_id === quiz.id && a.trainee_id === t.id; });
    if (acc && !acc.revoked_at) return {};
    var f = { granted_by: ctx.user.id, granted_at: U.nowIso(), revoked_at: null };
    if (acc) Repo.update('quiz_accesses', acc.id, f); else Repo.insert('quiz_accesses', Object.assign({ quiz_id: quiz.id, trainee_id: t.id }, f));
    Audit.record('quiz.access_granted', ctx.user, 'quiz', quiz.id, { trainee_id: t.id });
    return {};
  },
  revoke: function (ctx, p) {
    Quizzes.ensureViewer_(ctx.user);
    var quiz = Quizzes.mustFind_(p && p.id), acc = Quizzes.activeAccess_(quiz.id, p && p.trainee_id);
    if (!acc) notFound_('That trainee does not have access.');
    Repo.update('quiz_accesses', acc.id, { revoked_at: U.nowIso() });
    Audit.record('quiz.access_revoked', ctx.user, 'quiz', quiz.id, { trainee_id: acc.trainee_id });
    return {};
  },

  /* ---------- trainee attempt lifecycle ---------- */
  take: function (ctx, p) {
    var quiz = Quizzes.mustFind_(p && p.id), u = ctx.user;
    Quizzes.ensureAccess_(u, quiz);
    var at = Quizzes.attemptOf_(quiz.id, u.id);
    if (at && !at.submitted_at) {
      if (U.nowIso() >= at.expires_at) Quizzes.submitLocked_(at); else return { redirect: { page: 'quizzes/attempt', id: at.id } };
      at = Repo.find('quiz_attempts', at.id);
    }
    var comp = Quizzes.componentOf_(quiz.grade_component_key);
    return { quiz: { id: quiz.id, title: quiz.title, phase: comp ? comp.label : '', duration_minutes: quiz.duration_minutes, instructions: quiz.instructions },
      status: at ? (at.reviewed_at ? 'graded' : 'submitted') : 'available' };
  },
  start: function (ctx, p) {
    var u = ctx.user, quiz = Quizzes.mustFind_(p && p.id);
    if (u.role !== ROLE.TRAINEE || !U.isActive(u)) forbidden_();
    Quizzes.ensureAccess_(u, quiz);
    if (Quizzes.attemptOf_(quiz.id, u.id)) invalid_('attempt', 'You have already used your attempt for this quiz.');
    var now = U.nowIso();
    var at = Repo.insert('quiz_attempts', { quiz_id: quiz.id, trainee_id: u.id, started_at: now, expires_at: U.addMinutes(now, quiz.duration_minutes) });
    Audit.record('quiz.attempt_started', u, 'quiz_attempt', at.id);
    return { id: at.id };
  },
  attempt: function (ctx, p) {
    var at = Quizzes.mustFindAttempt_(p && p.id), quiz = Repo.find('quizzes', at.quiz_id);
    Quizzes.ensureAccess_(ctx.user, quiz);
    if (at.trainee_id !== ctx.user.id) forbidden_();
    if (!at.submitted_at && U.nowIso() >= at.expires_at) { Quizzes.submitLocked_(at); at = Repo.find('quiz_attempts', at.id); }
    var comp = Quizzes.componentOf_(quiz.grade_component_key);
    if (at.submitted_at) {
      return { submitted: true, status: at.reviewed_at ? 'graded' : 'submitted', quiz: { id: quiz.id, title: quiz.title, phase: comp ? comp.label : '' },
        submitted_at: at.submitted_at, score: at.reviewed_at ? at.final_score : null, total_points: Quizzes.totalPoints_(quiz.id), timed_out: at.submitted_at === at.expires_at };
    }
    var answers = Repo.where('quiz_answers', function (a) { return a.quiz_attempt_id === at.id; }).map(function (a) {
      return { question_id: a.quiz_question_id, selected_option: a.selected_option, answer_text: a.answer_text };
    });
    return { submitted: false, attempt: { id: at.id, started_at: at.started_at, expires_at: at.expires_at }, server_time: U.nowIso(),
      quiz: { id: quiz.id, title: quiz.title, phase: comp ? comp.label : '', duration_minutes: quiz.duration_minutes, instructions: quiz.instructions },
      questions: Quizzes.questionsOf_(quiz.id).map(function (q) { return Quizzes.questionPayload_(q, false); }), answers: answers };
  },
  storeAnswers_: function (at, answers) {
    if (!Array.isArray(answers)) invalid_('answers', 'Answers are invalid.');
    var qs = {}; Quizzes.questionsOf_(at.quiz_id).forEach(function (q) { qs[q.id] = q; });
    var existing = {}; Repo.where('quiz_answers', function (a) { return a.quiz_attempt_id === at.id; }).forEach(function (a) { existing[a.quiz_question_id] = a; });
    var updates = [], inserts = [], audits = [];
    answers.forEach(function (raw) {
      raw = raw || {};
      var q = qs[raw.question_id];
      if (!q) invalid_('answers', 'An answer does not belong to this quiz.');
      var sel = raw.selected_option === undefined ? null : raw.selected_option, text = raw.answer_text === undefined ? null : raw.answer_text;
      if (q.type === 'multiple_choice') {
        if (typeof sel === 'string' && /^\d+$/.test(sel)) sel = parseInt(sel, 10);
        if (typeof sel !== 'number' || sel % 1 !== 0 || sel < 0 || sel >= (q.options || []).length) invalid_('answers', 'Select one of the available answers.');
        text = null;
      } else {
        if (sel !== null) invalid_('answers', 'Paragraph answers cannot include an option.');
        if (text !== null && (typeof text !== 'string' || text.length > 20000)) invalid_('answers', 'Answer is too long.');
      }
      var ex = existing[q.id], mc = q.type === 'multiple_choice';
      var changed = mc ? (ex ? ex.selected_option : null) !== sel : String(ex && ex.answer_text || '') !== String(text || '');
      if (!changed && ex) return;
      if (ex) updates.push({ pk: ex.id, patch: { selected_option: sel, answer_text: text } });
      else inserts.push({ quiz_attempt_id: at.id, quiz_question_id: q.id, selected_option: sel, answer_text: text });
      audits.push({ question_id: q.id, position: q.position, type: q.type, details: mc ? { from_option: ex ? ex.selected_option : null, to_option: sel } : { length: String(text || '').length } });
    });
    Repo.updateMany('quiz_answers', updates); Repo.insertMany('quiz_answers', inserts);
    audits.forEach(function (a) {
      Audit.record('quiz.answer_changed', Repo.find('users', at.trainee_id), 'quiz_attempt', at.id, Object.assign({ question_id: a.question_id, position: a.position, type: a.type }, a.details));
    });
  },
  saveAnswers: function (ctx, p) {
    var at = Quizzes.mustFindAttempt_(p && p.id);
    if (at.trainee_id !== ctx.user.id) forbidden_();
    if (at.submitted_at) invalid_('attempt', 'This attempt has already been submitted.');
    if (U.nowIso() >= at.expires_at) { Quizzes.submitLocked_(at); return { saved: false, expired: true }; }
    Quizzes.ensureAccess_(ctx.user, Repo.find('quizzes', at.quiz_id));
    Quizzes.storeAnswers_(at, p.answers || []);
    return { saved: true };
  },
  submit: function (ctx, p) {
    var at = Quizzes.mustFindAttempt_(p && p.id);
    if (at.trainee_id !== ctx.user.id) forbidden_();
    if (at.submitted_at) return {};
    var now = U.nowIso();
    if (now < at.expires_at) { Quizzes.ensureAccess_(ctx.user, Repo.find('quizzes', at.quiz_id)); Quizzes.storeAnswers_(at, (p && p.answers) || []); }
    Quizzes.submitLocked_(Repo.find('quiz_attempts', at.id), now);
    return {};
  },
  event: function (ctx, p) {
    var at = Quizzes.mustFindAttempt_(p && p.id);
    if (at.trainee_id !== ctx.user.id) forbidden_();
    var v = validate_(p, { event: { required: true, type: 'enum', 'in': QUIZ_EVENTS }, client_time: { max: 64 } });
    Quizzes.ensureAccess_(ctx.user, Repo.find('quizzes', at.quiz_id));
    if (at.submitted_at || U.nowIso() >= at.expires_at) return {};
    Audit.record('quiz.' + v.event, ctx.user, 'quiz_attempt', at.id, { quiz_id: at.quiz_id, client_time: v.client_time });
    return {};
  },
  submitLocked_: function (at, now) {
    var quiz = Repo.find('quizzes', at.quiz_id), trainee = Repo.find('users', at.trainee_id);
    var existing = {}; Repo.where('quiz_answers', function (a) { return a.quiz_attempt_id === at.id; }).forEach(function (a) { existing[a.quiz_question_id] = a; });
    var auto = 0, updates = [], inserts = [];
    Quizzes.questionsOf_(quiz.id).forEach(function (q) {
      var a = existing[q.id], patch;
      if (q.type === 'multiple_choice') {
        var pts = a && a.selected_option !== null && a.selected_option === q.correct_option ? q.points : 0;
        patch = { auto_score: pts, manual_score: null }; auto += pts;
      } else patch = { auto_score: null, manual_score: null };
      if (a) updates.push({ pk: a.id, patch: patch }); else inserts.push(Object.assign({ quiz_attempt_id: at.id, quiz_question_id: q.id }, patch));
    });
    Repo.updateMany('quiz_answers', updates); Repo.insertMany('quiz_answers', inserts);
    now = now || U.nowIso();
    var submittedAt = now > at.expires_at ? at.expires_at : now;
    Repo.update('quiz_attempts', at.id, { submitted_at: submittedAt, auto_score: U.round2(auto) });
    Audit.record('quiz.attempt_submitted', trainee, 'quiz_attempt', at.id, { automatic_score: U.round2(auto), timed_out: submittedAt === at.expires_at });
  },
  /** Scheduled job: finalize attempts whose time ran out. */
  submitExpired: function () {
    return Repo.withLock(function () {
      var now = U.nowIso(), n = 0;
      Repo.where('quiz_attempts', function (a) { return !a.submitted_at && a.expires_at <= now; }).forEach(function (a) { Quizzes.submitLocked_(a); n++; });
      return n;
    });
  },

  /* ---------- review & reset ---------- */
  reviewGet: function (ctx, p) {
    Quizzes.ensureManager_(ctx.user);
    var quiz = Quizzes.mustFind_(p && p.quiz_id), at = Quizzes.mustFindAttempt_(p && p.attempt_id, quiz.id);
    if (at.trainee_id === ctx.user.id) forbidden_();
    var t = Repo.find('users', at.trainee_id) || {}, answers = {};
    Repo.where('quiz_answers', function (a) { return a.quiz_attempt_id === at.id; }).forEach(function (a) { answers[a.quiz_question_id] = a; });
    return { quiz: { id: quiz.id, title: quiz.title, total_points: Quizzes.totalPoints_(quiz.id) },
      attempt: { id: at.id, status: Quizzes.attemptStatus_(at), started_at: at.started_at, submitted_at: at.submitted_at, auto_score: at.auto_score, manual_score: at.manual_score,
        final_score: at.final_score, reviewed: !!at.reviewed_at },
      trainee: { id: t.id, name: t.name, username: t.username },
      questions: Quizzes.questionsOf_(quiz.id).map(function (q) {
        var a = answers[q.id] || {};
        return Object.assign(Quizzes.questionPayload_(q, true), { selected_option: a.selected_option === undefined ? null : a.selected_option, answer_text: a.answer_text === undefined ? null : a.answer_text,
          auto_score: a.auto_score === undefined ? null : a.auto_score, manual_score: a.manual_score === undefined ? null : a.manual_score });
      }) };
  },
  reviewSave: function (ctx, p) {
    Quizzes.ensureManager_(ctx.user);
    var quiz = Quizzes.mustFind_(p && p.quiz_id), at = Quizzes.mustFindAttempt_(p && p.attempt_id, quiz.id);
    if (at.trainee_id === ctx.user.id) forbidden_();
    if (!at.submitted_at) invalid_('attempt', 'Submit the attempt before grading it.');
    if (at.reviewed_at) invalid_('attempt', 'This attempt has already been reviewed.');
    var para = Quizzes.questionsOf_(quiz.id).filter(function (q) { return q.type === 'paragraph'; });
    var given = Array.isArray(p.answers) ? p.answers : [], byQ = {};
    given.forEach(function (a) {
      a = a || {};
      if (byQ[a.question_id] !== undefined) invalid_('answers', 'Grade every paragraph response exactly once.');
      var s = validate_({ s: a.manual_score }, { s: { required: true, type: 'num', min: 0, decimals: 2 } }).s;
      byQ[a.question_id] = s;
    });
    var ids = Object.keys(byQ).sort(), want = para.map(function (q) { return q.id; }).sort();
    if (JSON.stringify(ids) !== JSON.stringify(want)) invalid_('answers', 'Grade every paragraph response exactly once.');
    var manual = 0, existing = {};
    Repo.where('quiz_answers', function (a) { return a.quiz_attempt_id === at.id; }).forEach(function (a) { existing[a.quiz_question_id] = a; });
    var patches = [];
    para.forEach(function (q) {
      var s = byQ[q.id];
      if (s > q.points) invalid_('answers', 'The score for question ' + q.position + ' is outside its point range.');
      if (existing[q.id]) patches.push({ pk: existing[q.id].id, patch: { manual_score: s } });
      manual += s;
    });
    if (Quizzes.totalPoints_(quiz.id) <= 0) invalid_('quiz', 'This quiz has no scorable questions.');
    Repo.updateMany('quiz_answers', patches);
    var grade = U.round2((at.auto_score || 0) + manual), comp = Quizzes.componentOf_(quiz.grade_component_key);
    GradeWriter.save(ctx.user, Repo.find('users', at.trainee_id), comp, grade, 'Quiz review completed: ' + quiz.title);
    Repo.update('quiz_attempts', at.id, { manual_score: U.round2(manual), final_score: grade, reviewed_by: ctx.user.id, reviewed_at: U.nowIso() });
    Audit.record('quiz.attempt_reviewed', ctx.user, 'quiz_attempt', at.id, { auto_score: at.auto_score, manual_score: U.round2(manual), grade_score: grade });
    return {};
  },
  resetAttempt: function (ctx, p) {
    Authz.require(ctx.user, PERM.QUIZZES_RESET_ATTEMPTS);
    var quiz = Quizzes.mustFind_(p && p.quiz_id), at = Quizzes.mustFindAttempt_(p && p.attempt_id, quiz.id);
    var status = at.reviewed_at ? 'reviewed' : (at.submitted_at ? 'submitted' : 'in_progress'), cleared = false;
    if (at.reviewed_at) cleared = GradeWriter.clear(ctx.user, Repo.find('users', at.trainee_id), Quizzes.componentOf_(quiz.grade_component_key), 'Quiz attempt reset: ' + quiz.title);
    var details = { trainee_id: at.trainee_id, previous_status: status, auto_score: at.auto_score, manual_score: at.manual_score, final_score: at.final_score, grade_cleared: cleared };
    Repo.removeWhere('quiz_answers', function (a) { return a.quiz_attempt_id === at.id; });
    Repo.remove('quiz_attempts', at.id);
    Audit.record('quiz.attempt_reset', ctx.user, 'quiz_attempt', at.id, details);
    return {};
  }
};
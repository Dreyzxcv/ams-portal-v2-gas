/**
 * AuditLogService.gs - read-only viewer for the append-only audit trail (Administration > Audit log).
 * Permission: PERM.LOGS_VIEW (same gate as the dashboard "Recent activity" panel).
 * Filters: free text, category (the part of the action before the first dot), date range in the portal time zone.
 */
var AuditLogs = {
  category_: function (action) {
    action = String(action || '');
    var i = action.indexOf('.');
    return i > 0 ? action.slice(0, i) : (action || 'other');
  },
  /** Start / end of a yyyy-MM-dd day in the display time zone, as ISO instants (string-comparable with occurred_at). */
  dayStartIso_: function (day) { return Utilities.parseDate(day + ' 00:00:00', Config.tz(), 'yyyy-MM-dd HH:mm:ss').toISOString(); },
  dayEndIso_: function (day) { return new Date(Utilities.parseDate(day + ' 23:59:59', Config.tz(), 'yyyy-MM-dd HH:mm:ss').getTime() + 999).toISOString(); },

  userLabel_: function (u) { return u ? u.name + ' (@' + u.username + ')' : null; },
  detailValue_: function (key, val, users) {
    if (val === null || val === undefined || val === '') return '-';
    if (typeof val === 'boolean') return val ? 'yes' : 'no';
    if (Array.isArray(val)) return val.map(function (x) { return AuditLogs.detailValue_(key, x, users); }).join(', ');
    if (typeof val === 'object') return JSON.stringify(val);
    if (/(^|_)id$/.test(key) && typeof val === 'string' && users[val]) return AuditLogs.userLabel_(users[val]);
    return String(val);
  },
  present_: function (l, users) {
    var actor = l.actor_id ? users[l.actor_id] : null, subject = null;
    if (l.subject_type) {
      var su = l.subject_type === 'user' ? users[l.subject_id] : null;
      subject = { type: l.subject_type, id: l.subject_id, label: su ? AuditLogs.userLabel_(su) : null };
    }
    var d = l.details && typeof l.details === 'object' ? l.details : null;
    return { id: l.id, occurred_at: l.occurred_at, action: l.action, category: AuditLogs.category_(l.action),
      actor: { username: l.actor_username || null, name: actor ? actor.name : null, role: l.actor_role || null, role_label: ROLE_LABELS[l.actor_role] || l.actor_role || null },
      subject: subject,
      details: d ? Object.keys(d).map(function (k) { return { key: k, value: AuditLogs.detailValue_(k, d[k], users) }; }) : [] };
  },

  list: function (ctx, p) {
    Authz.require(ctx.user, PERM.LOGS_VIEW);
    var v = validate_(p || {}, { search: { max: 100 }, category: { max: 40 }, date_from: { type: 'date' }, date_to: { type: 'date' } });
    if (v.date_from && v.date_to && v.date_to < v.date_from) invalid_('date_to', 'The end date must be on or after the start date.');
    var users = Repo.index('users', 'id'), all = Repo.all('audit_logs'), cats = {};
    all.forEach(function (l) { cats[AuditLogs.category_(l.action)] = true; });
    var from = v.date_from ? AuditLogs.dayStartIso_(v.date_from) : null, to = v.date_to ? AuditLogs.dayEndIso_(v.date_to) : null;
    var term = v.search ? U.lower(v.search) : null;
    var rows = all.filter(function (l) {
      if (v.category && AuditLogs.category_(l.action) !== v.category) return false;
      if (from && l.occurred_at < from) return false;
      if (to && l.occurred_at > to) return false;
      if (term) {
        var su = l.subject_type === 'user' ? users[l.subject_id] : null;
        var hay = [l.actor_username, l.actor_role, l.action, l.subject_type, l.subject_id, su ? su.name : '', su ? su.username : '', l.details ? JSON.stringify(l.details) : ''];
        // Details that point at a user (trainee_id, ...) also match on that user's name and username.
        if (l.details && typeof l.details === 'object') Object.keys(l.details).forEach(function (k) {
          var ref = typeof l.details[k] === 'string' ? users[l.details[k]] : null;
          if (ref) hay.push(ref.name, ref.username);
        });
        if (!U.matches(term, hay)) return false;
      }
      return true;
    }).sort(function (a, b) { return U.cmp(b.occurred_at, a.occurred_at) || U.cmp(b.id, a.id); });
    var pg = paginate_(rows, p && p.page);
    return { logs: pg.data.map(function (l) { return AuditLogs.present_(l, users); }), meta: pg.meta,
      filters: { search: v.search, category: v.category, date_from: v.date_from, date_to: v.date_to },
      categories: Object.keys(cats).sort() };
  }
};
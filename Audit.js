/** Audit.gs - append-only audit trail (ported from AuditLogger). Never throws. */
var Audit = {
  record: function (action, actor, subjectType, subjectId, details) {
    try {
      Repo.insert('audit_logs', {
        occurred_at: U.nowIso(),
        actor_id: actor ? actor.id : null,
        actor_username: actor ? actor.username : null,
        actor_role: actor ? actor.role : null,
        action: action,
        subject_type: subjectType || null,
        subject_id: subjectId === undefined || subjectId === null ? null : String(subjectId),
        details: details && Object.keys(details).length ? details : null
      });
    } catch (e) {
      console.warn('audit failed: ' + e);
    }
  }
};

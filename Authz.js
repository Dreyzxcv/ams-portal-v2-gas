/** Authz.gs - server-side authorization (Permissions + Policies). */
var Authz = {
  allows: function (user, perm) {
    if (!user || !user.role || !U.isActive(user)) return false;
    return (PERMISSION_MATRIX[user.role] || []).indexOf(perm) !== -1;
  },
  permissionsFor: function (user) {
    if (!user || !user.role || !U.isActive(user)) return [];
    return (PERMISSION_MATRIX[user.role] || []).slice();
  },
  require: function (user, perm) { if (!Authz.allows(user, perm)) forbidden_(); },
  isTrainee: function (u) { return !!u && u.role === ROLE.TRAINEE; },
  isGraduate: function (u) { return !!u && u.role === ROLE.GRADUATE; },
  /** Trainee or graduate: sees the personal (non-staff) dashboard. */
  isLearner: function (u) { return !!u && (u.role === ROLE.TRAINEE || u.role === ROLE.GRADUATE); },
  isStaff: function (u) { return !!u && !Authz.isLearner(u); },
  isSelf: function (a, b) { return !!a && !!b && a.id === b.id; }
};
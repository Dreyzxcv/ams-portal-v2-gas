/** UserService.gs - user management (UserController/UserService/UserPolicy). */
var Users = {
  present_: function (u) {
    return { id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, role_label: ROLE_LABELS[u.role] || u.role,
      status: u.status, force_password_change: !!u.force_password_change, last_login_at: u.last_login_at };
  },
  live_: function () { return Repo.where('users', function (u) { return !u.deleted_at; }); },
  mustFind_: function (id) {
    var u = typeof id === 'string' ? Repo.find('users', id) : null;
    if (!u || u.deleted_at) notFound_('User not found.');
    return u;
  },
  roleOptions_: function () { return Object.keys(ROLE_LABELS).map(function (k) { return { value: k, label: ROLE_LABELS[k] }; }); },
  ensureTraineeProfile_: function (u) {
    if (u.role === ROLE.TRAINEE && !Repo.find('trainee_profiles', u.id)) {
      Repo.insert('trainee_profiles', { user_id: u.id, lifecycle: 'active' });
    }
  },
  revokeAccess_: function (userId) { Sessions.revokeAllForUser(userId); Devices.revokeAll(userId); },

  list: function (ctx, p) {
    Authz.require(ctx.user, PERM.USERS_MANAGE);
    p = p || {};
    var search = U.trim(p.search), role = ROLE_LABELS[p.role] ? p.role : null;
    var status = [USER_STATUS.ACTIVE, USER_STATUS.INACTIVE, USER_STATUS.SUSPENDED].indexOf(p.status) !== -1 ? p.status : null;
    var rows = Users.live_().filter(function (u) {
      return (!search || U.matches(search, [u.name, u.username, u.email])) && (!role || u.role === role) && (!status || u.status === status);
    }).sort(U.byName);
    var pg = paginate_(rows, p.page);
    return { users: pg.data.map(Users.present_), meta: pg.meta, filters: { search: search, role: role, status: status },
      roles: Users.roleOptions_(), statuses: [USER_STATUS.ACTIVE, USER_STATUS.INACTIVE, USER_STATUS.SUSPENDED] };
  },
  get: function (ctx, p) {
    Authz.require(ctx.user, PERM.USERS_MANAGE);
    var t = Users.mustFind_(p && p.id), canOther = !Authz.isSelf(ctx.user, t);
    return { user: Users.present_(t), roles: Users.roleOptions_(), statuses: [USER_STATUS.ACTIVE, USER_STATUS.INACTIVE, USER_STATUS.SUSPENDED],
      can: { changeRole: canOther, changeStatus: canOther, resetPassword: canOther } };
  },
  create: function (ctx, p) {
    Authz.require(ctx.user, PERM.USERS_MANAGE);
    var v = validate_(p, {
      name: { required: true, max: 255 },
      username: { required: true, lower: true, regex: /^[a-z0-9._-]{3,50}$/, regexMsg: 'Use 3 to 50 characters: letters, digits, dot, underscore or hyphen.', label: 'username' },
      email: { type: 'email', lower: true, max: 255 },
      role: { required: true, type: 'enum', 'in': Object.keys(ROLE_LABELS) }
    });
    if (Repo.first('users', function (u) { return u.username && u.username.toLowerCase() === v.username; })) invalid_('username', 'The username has already been taken.');
    if (v.email && Repo.first('users', function (u) { return u.email && u.email.toLowerCase() === v.email; })) invalid_('email', 'The email has already been taken.');
    var temp = U.randomPassword(16);
    var user = Repo.insert('users', { name: v.name, username: v.username, email: v.email, role: v.role, status: USER_STATUS.ACTIVE,
      force_password_change: true, password_hash: '', password_salt: '' });
    Auth.setPassword(user.id, temp, true);
    Users.ensureTraineeProfile_(user);
    Audit.record('user.created', ctx.user, 'user', user.id, { username: user.username, role: user.role });
    return { user: Users.present_(Repo.find('users', user.id)), credentials: { username: user.username, password: temp } };
  },
  update: function (ctx, p) {
    Authz.require(ctx.user, PERM.USERS_MANAGE);
    var t = Users.mustFind_(p && p.id);
    var v = validate_(p, { name: { optional: true, required: true, max: 255 }, email: { optional: true, required: true, type: 'email', lower: true, max: 255 },
      role: { optional: true, required: true, type: 'enum', 'in': Object.keys(ROLE_LABELS) } });
    if (v.email && Repo.first('users', function (u) { return u.email && u.email.toLowerCase() === v.email && u.id !== t.id; })) invalid_('email', 'The email has already been taken.');
    if (v.role && v.role !== t.role && Authz.isSelf(ctx.user, t)) forbidden_('You cannot change your own role.');
    var patch = {}, changed = [];
    ['name', 'email', 'role'].forEach(function (k) { if (v[k] !== undefined && v[k] !== t[k]) { patch[k] = v[k]; changed.push(k); } });
    if (!changed.length) return { user: Users.present_(t) };
    var roleBefore = t.role;
    Repo.update('users', t.id, patch);
    var after = Repo.find('users', t.id);
    Users.ensureTraineeProfile_(after);
    var d = { fields: changed };
    if (roleBefore !== after.role) { d.role_from = roleBefore; d.role_to = after.role; }
    Audit.record('user.updated', ctx.user, 'user', t.id, d);
    return { user: Users.present_(after) };
  },
  changeStatus: function (ctx, p) {
    Authz.require(ctx.user, PERM.USERS_MANAGE);
    var t = Users.mustFind_(p && p.id);
    if (Authz.isSelf(ctx.user, t)) forbidden_('You cannot change your own status.');
    var v = validate_(p, { status: { required: true, type: 'enum', 'in': [USER_STATUS.ACTIVE, USER_STATUS.INACTIVE, USER_STATUS.SUSPENDED] } });
    if (t.status === v.status) return { user: Users.present_(t) };
    var from = t.status;
    Repo.update('users', t.id, { status: v.status });
    if (v.status !== USER_STATUS.ACTIVE) Users.revokeAccess_(t.id);
    Audit.record('user.status_changed', ctx.user, 'user', t.id, { from: from, to: v.status });
    return { user: Users.present_(Repo.find('users', t.id)) };
  },
  resetPassword: function (ctx, p) {
    Authz.require(ctx.user, PERM.USERS_MANAGE);
    var t = Users.mustFind_(p && p.id);
    if (Authz.isSelf(ctx.user, t)) forbidden_('You cannot reset your own password here.');
    var temp = U.randomPassword(16);
    Auth.setPassword(t.id, temp, true);
    Users.revokeAccess_(t.id);
    Audit.record('user.password_reset', ctx.user, 'user', t.id);
    return { credentials: { username: t.username, password: temp } };
  }
};

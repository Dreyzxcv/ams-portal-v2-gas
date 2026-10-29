/** IntakeService.gs - public recruitment banner (IntakeController/IntakeService/IntakeSettingPolicy). */
var Intake = {
  banner: function () {
    var s = Repo.find('intake_settings', '1');
    return s ? { status: s.status, message: INTAKE_MESSAGES[s.status] || '' } : null;
  },
  get: function (ctx) {
    Authz.require(ctx.user, PERM.SETTINGS_MANAGE);
    var s = Repo.find('intake_settings', '1');
    return { status: s ? s.status : 'closed', exists: !!s, messages: INTAKE_MESSAGES };
  },
  update: function (ctx, p) {
    Authz.require(ctx.user, PERM.SETTINGS_MANAGE);
    var v = validate_(p, { status: { required: true, type: 'enum', 'in': ['open', 'closed'] } });
    var s = Repo.find('intake_settings', '1'), from = s ? s.status : null;
    if (s && s.status === v.status) return {};
    if (s) Repo.update('intake_settings', '1', { status: v.status, updated_by: ctx.user.id });
    else Repo.insert('intake_settings', { id: '1', status: v.status, updated_by: ctx.user.id });
    Audit.record('intake.updated', ctx.user, 'intake_setting', 1, { from: from, to: v.status });
    return {};
  }
};

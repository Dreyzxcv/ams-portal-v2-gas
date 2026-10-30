/** AnnouncementService.gs - announcements + Discord webhook (AnnouncementController/AnnouncementPublisher/policy). */
var Announcements = {
  mustFind_: function (id) {
    var a = typeof id === 'string' ? Repo.find('announcements', id) : null;
    if (!a) notFound_('Announcement not found.');
    return a;
  },
  rules_: function () {
    var line = { required: true, max: 150, notNewline: true };
    return { recipient: Object.assign({ label: 'To' }, line), sender: Object.assign({ label: 'From' }, line), subject: Object.assign({ label: 'RE' }, line),
      body: { required: true, max: 1300, label: 'context' }, signature: { required: true, max: 500, label: 'name/signature' }, publish: { type: 'bool' } };
  },
  present_: function (a, users) {
    var au = a.created_by ? users[a.created_by] : null;
    return { id: a.id, recipient: a.recipient, sender: a.sender, subject: a.subject, body: a.body, signature: a.signature,
      is_published: !!a.published_at, is_pinned: !!a.pinned_at, published_label: U.label(a.published_at), author: au ? au.name : null,
      discord_status: a.discord_status || DISCORD.NOT_SENT, discord_error: a.discord_error, discord_sent_label: U.label(a.discord_sent_at) };
  },
  publicArray_: function (a) {
    return { id: a.id, recipient: a.recipient, sender: a.sender, subject: a.subject, body: a.body, signature: a.signature,
      published_label: U.label(a.published_at), is_pinned: !!a.pinned_at };
  },
  forPublic_: function () {
    return Repo.where('announcements', function (a) { return !!a.published_at; }).sort(function (a, b) {
      return ((a.pinned_at ? 0 : 1) - (b.pinned_at ? 0 : 1)) || U.cmp(b.published_at, a.published_at) || U.cmp(b.id, a.id);
    });
  },
  publicTop: function (n) { return Announcements.forPublic_().slice(0, n).map(Announcements.publicArray_); },
  publicArchive: function (p) {
    var pg = U.paginate(Announcements.forPublic_(), p && p.page, 10);
    return { announcements: pg.data.map(Announcements.publicArray_), meta: pg.meta };
  },

  list: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var users = Repo.index('users', 'id');
    var rows = Repo.all('announcements').slice().sort(function (a, b) { return U.cmp(b.created_at, a.created_at) || U.cmp(b.id, a.id); });
    var pg = paginate_(rows, p && p.page);
    return { announcements: pg.data.map(function (a) { return Announcements.present_(a, users); }), meta: pg.meta };
  },
  get: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    return { announcement: Announcements.present_(Announcements.mustFind_(p && p.id), Repo.index('users', 'id')) };
  },
  create: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var v = validate_(p, Announcements.rules_());
    var a = Repo.insert('announcements', { recipient: v.recipient, sender: v.sender, subject: v.subject, body: v.body, signature: v.signature,
      created_by: ctx.user.id, discord_status: DISCORD.NOT_SENT });
    return { id: a.id, publish: v.publish };
  },
  update: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var a = Announcements.mustFind_(p && p.id), v = validate_(p, Announcements.rules_());
    Repo.update('announcements', a.id, { recipient: v.recipient, sender: v.sender, subject: v.subject, body: v.body, signature: v.signature });
    return { id: a.id, publish: v.publish };
  },
  remove: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var a = Announcements.mustFind_(p && p.id);
    Repo.remove('announcements', a.id);
    return {};
  },
  pin: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var a = Announcements.mustFind_(p && p.id);
    if (!a.published_at) fail_('UNPROCESSABLE', 'Only published announcements can be pinned.');
    if (!a.pinned_at) Repo.update('announcements', a.id, { pinned_at: U.nowIso() });
    return {};
  },
  unpin: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var a = Announcements.mustFind_(p && p.id);
    Repo.update('announcements', a.id, { pinned_at: null });
    return {};
  },
  unpublish: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var a = Announcements.mustFind_(p && p.id);
    Repo.update('announcements', a.id, { published_at: null });
    return { message: 'Announcement unpublished.' };
  },

  isWebhookUrl_: function (url) { return /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url); },

  toDiscord_: function (text) {
    var map = {};
    try { map = JSON.parse(Config.get('DISCORD_MENTIONS') || '{}'); } catch (e) { /* ignore bad JSON */ }
    Object.keys(map).sort(function (a, b) { return b.length - a.length; }).forEach(function (name) {
      var id = String(map[name]), tag = id.charAt(0) === '&' ? '<@&' + id.slice(1) + '>' : '<@' + id + '>';
      text = text.split('@' + name).join(tag);
    });
    var em = {}; try { em = JSON.parse(Config.get('DISCORD_EMOJIS') || '{}'); } catch (e) {}
    Object.keys(em).forEach(function (k) { text = text.split(':' + k + ':').join(em[k]); });
    return text;
  },
  payload_: function (a) {
    var d = '[**TO**]: ' + a.recipient + '\n[**FROM**]: ' + a.sender + '\n[**RE**]: ' + a.subject + '\n\n' + a.body + '\n\n' + a.signature;
    d = Announcements.toDiscord_(d);
    if (d.length > 2000) d = d.slice(0, 1997) + '...';
    return { allowed_mentions: { parse: ['users', 'roles'] }, content: d };
  },
  /** Lock-claim -> HTTP (outside the lock) -> record result. Never leaves the row stuck in "sending". */
  sendToDiscord_: function (id) {
    var claimed = Repo.withLock(function () {
      var a = Repo.find('announcements', id);
      if (!a || !a.published_at) return null;
      var stale = a.discord_status === DISCORD.SENDING && a.discord_attempted_at && a.discord_attempted_at < U.addMinutes(U.nowIso(), -1);
      if (!(a.discord_status === DISCORD.NOT_SENT || a.discord_status === DISCORD.FAILED || !a.discord_status || stale)) return null;
      return Repo.update('announcements', id, { discord_status: DISCORD.SENDING, discord_attempted_at: U.nowIso(), discord_error: null });
    });
    if (!claimed) return;
    var status = DISCORD.FAILED, error = null, url = Config.get('DISCORD_WEBHOOK_URL') || '';
    try {
      if (!Announcements.isWebhookUrl_(url)) error = 'The Discord webhook is not configured.';
      else {
        var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(Announcements.payload_(claimed)), muteHttpExceptions: true, followRedirects: false });
        var code = res.getResponseCode();
        if (code >= 200 && code < 300) status = DISCORD.SENT; else error = 'Discord rejected the post (HTTP ' + code + ').';
      }
    } catch (e) { console.warn('Discord error: ' + String(e).replace(/\/api\/webhooks\/\S+/g, '/api/webhooks/[redacted]')); error = 'Could not reach Discord (network error or timeout).'; }
    Repo.withLock(function () {
      Repo.update('announcements', id, status === DISCORD.SENT
        ? { discord_status: DISCORD.SENT, discord_sent_at: U.nowIso(), discord_error: null } : { discord_status: DISCORD.FAILED, discord_error: error });
    });
  },
  status_: function (id, dflt) {
    var a = Repo.find('announcements', id);
    if (!a || !a.published_at) return dflt;
    return a.discord_status === DISCORD.FAILED
      ? 'Published in the portal, but Discord delivery failed: ' + a.discord_error + ' Use \u201cRetry Discord\u201d to try again.' : 'Announcement published.';
  },
  /** Manual-lock action: publish (sets published_at, then Discord). */
  publish: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var id = p && p.id;
    Repo.withLock(function () {
      var a = Announcements.mustFind_(id);
      if (!a.published_at) Repo.update('announcements', a.id, { published_at: U.nowIso() });
    });
    Announcements.sendToDiscord_(id);
    return { message: Announcements.status_(id, 'Announcement saved.') };
  },
  retry: function (ctx, p) {
    Authz.require(ctx.user, PERM.ANNOUNCEMENTS_MANAGE);
    var a = Announcements.mustFind_(p && p.id);
    if (!a.published_at) fail_('UNPROCESSABLE', 'Only published announcements can be sent to Discord.');
    Announcements.sendToDiscord_(a.id);
    return { message: Announcements.status_(a.id, 'Announcement saved.') };
  }
};

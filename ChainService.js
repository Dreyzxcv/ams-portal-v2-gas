/** ChainService.gs - chain of command (ChainOfCommandController/Service/Request/Policy). */
var Chain = {
  present_: function (e) { return { id: e.id, name: e.name, rank: e.rank, position: e.position, note: e.note, image_url: e.image_url, sort_order: e.sort_order }; },
  sorted_: function () { return Repo.all('chain_of_command_entries').slice().sort(function (a, b) { return (a.sort_order - b.sort_order) || U.cmp(a.id, b.id); }); },
  publicList: function () { return { entries: Chain.sorted_().map(Chain.present_) }; },
  manage: function (ctx) {
    Authz.require(ctx.user, PERM.CHAIN_MANAGE);
    return { entries: Chain.sorted_().map(Chain.present_), image_hosts: Config.get('CHAIN_IMAGE_HOSTS').split(',') };
  },
  imageUrlCheck_: function (url) {
    var m = /^https:\/\/([^\/?#:@]*)(?::(\d+))?(\/[^?#]*)?/.exec(url) ;
    if (!/^https:\/\//i.test(url) || !m) invalid_('image_url', 'The image url must be a valid https URL.');
    if (/^https:\/\/[^\/?#]*@/.test(url) || m[2]) invalid_('image_url', 'Use a plain image link without credentials or a port.');
    var hosts = Config.get('CHAIN_IMAGE_HOSTS').split(',').map(function (h) { return h.trim().toLowerCase(); });
    if (hosts.indexOf(m[1].toLowerCase()) === -1) invalid_('image_url', 'The image must be hosted on: ' + hosts.join(', ') + '.');
    if (!/\.(jpe?g|png|webp)$/i.test(m[3] || '')) invalid_('image_url', 'Use the direct image link ending in .jpg, .png or .webp (for Imgur, right-click the image and copy the image address).');
  },
  validate_: function (p) {
    var v = validate_(p, { name: { required: true, max: 150, notNewline: true }, rank: { required: true, max: 100, notNewline: true },
      position: { required: true, max: 150, notNewline: true }, note: { max: 1000 }, sort_order: { type: 'int', min: 0, max: 65535 }, image_url: { max: 500 } });
    if (v.sort_order === null) v.sort_order = 0;
    if (v.image_url) Chain.imageUrlCheck_(v.image_url);
    return v;
  },
  create: function (ctx, p) {
    Authz.require(ctx.user, PERM.CHAIN_MANAGE);
    RateLimit.hit('chain:' + ctx.user.id, 30, 60);
    var v = Chain.validate_(p), e = Repo.insert('chain_of_command_entries', v);
    Audit.record('chain.created', ctx.user, 'chain_entry', e.id, { name: e.name, position: e.position });
    return { id: e.id };
  },
  update: function (ctx, p) {
    Authz.require(ctx.user, PERM.CHAIN_MANAGE);
    RateLimit.hit('chain:' + ctx.user.id, 30, 60);
    var e = Repo.find('chain_of_command_entries', p && p.id);
    if (!e) notFound_();
    var v = Chain.validate_(p), changed = Object.keys(v).filter(function (k) { return (e[k] === undefined ? null : e[k]) !== v[k]; });
    if (!changed.length) return {};
    Repo.update('chain_of_command_entries', e.id, v);
    Audit.record('chain.updated', ctx.user, 'chain_entry', e.id, { fields: changed });
    return {};
  },
  remove: function (ctx, p) {
    Authz.require(ctx.user, PERM.CHAIN_MANAGE);
    var e = Repo.find('chain_of_command_entries', p && p.id);
    if (!e) notFound_();
    Repo.remove('chain_of_command_entries', e.id);
    Audit.record('chain.deleted', ctx.user, 'chain_entry', e.id, { name: e.name, position: e.position });
    return {};
  }
};

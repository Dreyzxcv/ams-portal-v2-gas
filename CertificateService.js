/**
 * CertificateService.gs - certificates + Drive storage (CertificateController/CertificateService/GoogleDriveCertificateStorage).
 * Files live in a private Drive folder owned by the deploying account and are only streamed to
 * authorized users through the server; they are never shared publicly.
 */
var DriveStore = {
  ALLOWED: { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  /** Detect the real type from magic bytes; the browser-supplied type is not trusted. */
  sniff: function (bytes) {
    function at(i) { return (bytes[i] + 256) % 256; }
    if (bytes.length > 4 && at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2D) return 'application/pdf';
    if (bytes.length > 3 && at(0) === 0xFF && at(1) === 0xD8 && at(2) === 0xFF) return 'image/jpeg';
    if (bytes.length > 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4E && at(3) === 0x47 && at(4) === 0x0D && at(5) === 0x0A && at(6) === 0x1A && at(7) === 0x0A) return 'image/png';
    if (bytes.length > 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp';
    return null;
  },
  folder_: function () {
    var id = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
    if (!id) throw new Error('DRIVE_FOLDER_ID is not configured. Run setup().');
    return DriveApp.getFolderById(id);
  },
  /** upload = {name, base64}. Returns the stored_files row. */
  store: function (upload, uploadedBy) {
    if (!upload || typeof upload.base64 !== 'string' || !upload.base64.length) invalid_('file', 'The file field is required.');
    var bytes;
    try { bytes = Utilities.base64Decode(upload.base64); } catch (e) { invalid_('file', 'The file could not be read.'); }
    if (bytes.length > MAX_CERT_BYTES) invalid_('file', 'The certificate must be 5 MB or smaller.');
    var mime = DriveStore.sniff(bytes);
    if (!mime) invalid_('file', 'The certificate must be a PDF, JPG, PNG or WebP file.');
    var driveName = Utilities.getUuid() + '.' + DriveStore.ALLOWED[mime];
    var file;
    try { file = DriveStore.folder_().createFile(Utilities.newBlob(bytes, mime, driveName)); }
    catch (e) { console.error('Drive store failed: ' + e); invalid_('file', 'The file could not be stored. Please try again.'); }
    var original = String(upload.name || 'certificate').split(/[\\/]/).pop().replace(/[^\w.\- ()]/g, '_').slice(0, 255);
    return Repo.insert('stored_files', { drive_file_id: file.getId(), original_name: original, mime_type: mime, size_bytes: bytes.length,
      sha256: U.sha256Bytes(bytes), uploaded_by: uploadedBy });
  },
  read: function (stored) {
    try {
      var f = DriveApp.getFileById(stored.drive_file_id), blob = f.getBlob();
      return { name: stored.original_name, mime: stored.mime_type, base64: Utilities.base64Encode(blob.getBytes()) };
    } catch (e) {
      console.error('Drive read failed: ' + e);
      throw new AppError('FILE_UNAVAILABLE', 'The certificate file is temporarily unavailable.', null, 502);
    }
  },
  discard: function (stored) {
    try { DriveApp.getFileById(stored.drive_file_id).setTrashed(true); } catch (e) { console.warn('discard failed: ' + e); }
    try { Repo.remove('stored_files', stored.id); } catch (e) { /* ignore */ }
  }
};

var Certificates = {
  nextNumber_: function () {
    var prefix = 'AMS-' + U.today().slice(0, 4) + '-', max = 0;
    Repo.all('certificates').forEach(function (c) {
      if (c.certificate_number && c.certificate_number.indexOf(prefix) === 0) max = Math.max(max, parseInt(c.certificate_number.slice(prefix.length), 10) || 0);
    });
    return prefix + ('0000' + (max + 1)).slice(-4);
  },
  canView_: function (user, cert) {
    if (Authz.allows(user, PERM.CERTIFICATES_MANAGE)) return true;
    return U.isActive(user) && cert.trainee_id === user.id && cert.status === CERT_STATUS.ISSUED;
  },
  list: function (ctx, p) {
    Authz.require(ctx.user, PERM.CERTIFICATES_MANAGE);
    p = p || {};
    var search = U.trim(p.search), certs = {}, files = Repo.index('stored_files', 'id');
    Repo.all('certificates').forEach(function (c) { certs[c.trainee_id] = c; });
    // Medical Trainees and Graduates can both hold a certificate.
    var rows = Users.live_().filter(function (u) { return (u.role === ROLE.TRAINEE || u.role === ROLE.GRADUATE) && (!search || U.matches(search, [u.name, u.username])); }).sort(U.byName);
    var pg = paginate_(rows, p.page);
    return { trainees: pg.data.map(function (t) {
      var c = certs[t.id], f = c && c.file_id ? files[c.file_id] : null;
      return { id: t.id, name: t.name, username: t.username, status: t.status,
        certificate: c ? { id: c.id, status: c.status, number: c.certificate_number, issued_at: c.issued_at, has_file: !!c.file_id, mime: f ? f.mime_type : null } : null };
    }), meta: pg.meta, filters: { search: search } };
  },
  issue: function (ctx, p) {
    Authz.require(ctx.user, PERM.CERTIFICATES_MANAGE);
    RateLimit.hit('cert-issue:' + ctx.user.id, 20, 60);
    var t = Grades.trainee_(p && p.trainee_id);
    if (!U.isActive(t)) invalid_('file', 'Certificates can only be issued to active trainees.');
    var existing = Repo.first('certificates', function (c) { return c.trainee_id === t.id; });
    if (existing && existing.status === CERT_STATUS.ISSUED) invalid_('file', 'This trainee already has an issued certificate.');
    var stored = DriveStore.store(p.file, ctx.user.id);
    try {
      var number = Certificates.nextNumber_(), now = U.nowIso(), cert;
      var fields = { status: CERT_STATUS.ISSUED, certificate_number: number, issued_at: now, issued_by: ctx.user.id, file_id: stored.id, revoked_at: null, revoked_by: null };
      if (existing) cert = Repo.update('certificates', existing.id, fields);
      else cert = Repo.insert('certificates', Object.assign({ trainee_id: t.id }, fields));
      Audit.record('certificate.issued', ctx.user, 'certificate', cert.id, { trainee_id: t.id, certificate_number: number, file_sha256: stored.sha256 });
      return { id: cert.id, number: number };
    } catch (e) { DriveStore.discard(stored); throw e; }
  },
  revoke: function (ctx, p) {
    Authz.require(ctx.user, PERM.CERTIFICATES_MANAGE);
    var c = Repo.find('certificates', p && p.id);
    if (!c) notFound_('Certificate not found.');
    var v = validate_(p, { reason: { max: 500 } });
    if (c.status !== CERT_STATUS.ISSUED) invalid_('reason', 'Only issued certificates can be revoked.');
    Repo.update('certificates', c.id, { status: CERT_STATUS.REVOKED, revoked_at: U.nowIso(), revoked_by: ctx.user.id });
    var d = { trainee_id: c.trainee_id, certificate_number: c.certificate_number };
    if (v.reason) d.reason = v.reason;
    Audit.record('certificate.revoked', ctx.user, 'certificate', c.id, d);
    return {};
  },
  /** Returns the file as base64 for the browser to preview/save. mode: 'download' | 'preview'. */
  file: function (ctx, p, mode) {
    RateLimit.hit('cert-file:' + ctx.user.id, 60, 60);
    var c = Repo.find('certificates', p && p.id);
    if (!c) notFound_('Certificate not found.');
    if (!Certificates.canView_(ctx.user, c)) forbidden_();
    var stored = c.file_id ? Repo.find('stored_files', c.file_id) : null;
    if (!stored) notFound_('No file is attached to this certificate.');
    Audit.record(mode === 'preview' ? 'certificate.previewed' : 'certificate.downloaded', ctx.user, 'certificate', c.id);
    return DriveStore.read(stored);
  }
};
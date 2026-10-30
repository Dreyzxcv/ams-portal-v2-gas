/**
 * Config.gs - constants, enums, permission matrix and runtime configuration.
 * Ported from: app/Enums/*, app/Support/Permissions.php, config/ams.php
 */
var APP_NAME = 'Army Medical School';

/**
 * Role keys are what is stored in the Users sheet, so existing keys are kept and only their labels change:
 *   logistic_officer -> shown as "Administrator Clerk"
 *   instructor       -> shown as "Medical Instructor"
 *   trainee          -> shown as "Medical Trainee"
 * New keys: dean, deputy_dean, head_admin_clerk, graduate.
 */
var ROLE = {
  ADMIN: 'admin', DEAN: 'dean', DEPUTY_DEAN: 'deputy_dean',
  HEAD_ADMIN_CLERK: 'head_admin_clerk', HEAD_INSTRUCTOR: 'head_instructor',
  LOGISTIC_OFFICER: 'logistic_officer',
  INSTRUCTOR: 'instructor',
  GRADUATE: 'graduate',
  TRAINEE: 'trainee'
};
/** Key order here is the order of the role dropdowns (top to bottom). */
var ROLE_LABELS = {
  admin: 'Admin',
  dean: 'Dean of Medicine',
  deputy_dean: 'Deputy Dean of Medicine',
  head_admin_clerk: 'Head Administrator Clerk',
  head_instructor: 'Head Instructor',
  logistic_officer: 'Administrator Clerk',
  instructor: 'Medical Instructor',
  graduate: 'Graduate',
  trainee: 'Medical Trainee'
};
var USER_STATUS = { ACTIVE: 'active', INACTIVE: 'inactive', SUSPENDED: 'suspended' };
var CERT_STATUS = { PENDING: 'pending', ISSUED: 'issued', REVOKED: 'revoked' };
var OTP_PURPOSE = { LOGIN: 'login', PASSWORD_RESET: 'password_reset', EMAIL_VERIFICATION: 'email_verification', PASSWORD_CHANGE: 'password_change' };
var DISCORD = { NOT_SENT: 'not_sent', SENDING: 'sending', SENT: 'sent', FAILED: 'failed' };
var INTAKE_MESSAGES = {
  open: 'Recruitment is now open.',
  closed: 'Recruitment is now closed. A batch is currently ongoing.'
};

var PERM = {
  USERS_MANAGE: 'users.manage', GRADES_VIEW_ALL: 'grades.view_all', GRADES_MANAGE: 'grades.manage',
  QUIZZES_MANAGE: 'quizzes.manage', QUIZZES_RESET_ATTEMPTS: 'quizzes.reset_attempts',
  VIOLATIONS_MANAGE: 'violations.manage', PROGRESS_MANAGE: 'progress.manage',
  BATCHES_VIEW: 'batches.view', BATCHES_MANAGE: 'batches.manage',
  CERTIFICATES_MANAGE: 'certificates.manage', CHAIN_MANAGE: 'chain.manage',
  LOGS_VIEW: 'logs.view', SETTINGS_MANAGE: 'settings.manage', ANNOUNCEMENTS_MANAGE: 'announcements.manage'
};

function permissionMatrix_() {
  var all = Object.keys(PERM).map(function (k) { return PERM[k]; });
  var headInstructor = [PERM.GRADES_VIEW_ALL, PERM.GRADES_MANAGE, PERM.QUIZZES_MANAGE, PERM.VIOLATIONS_MANAGE,
    PERM.PROGRESS_MANAGE, PERM.BATCHES_VIEW, PERM.ANNOUNCEMENTS_MANAGE];
  var m = {};
  m[ROLE.ADMIN] = all;
  m[ROLE.DEAN] = all.slice();                       // same as admin
  m[ROLE.DEPUTY_DEAN] = all.slice();                // same as admin
  m[ROLE.HEAD_ADMIN_CLERK] = headInstructor.slice(); // same as head instructor
  m[ROLE.HEAD_INSTRUCTOR] = headInstructor;
  m[ROLE.LOGISTIC_OFFICER] = [PERM.GRADES_VIEW_ALL, PERM.VIOLATIONS_MANAGE, PERM.PROGRESS_MANAGE]; // Administrator Clerk
  m[ROLE.INSTRUCTOR] = [PERM.GRADES_VIEW_ALL, PERM.GRADES_MANAGE, PERM.BATCHES_VIEW];              // Medical Instructor
  m[ROLE.GRADUATE] = [];                            // dashboard only (own grades + certificate)
  m[ROLE.TRAINEE] = [];                             // Medical Trainee
  return m;
}
var PERMISSION_MATRIX = permissionMatrix_();

/** Grade components seeded by setup (database/seeders/GradeComponentSeeder.php). */
var GRADE_COMPONENT_SEED = [
  { key: 'phase_1', label: 'Phase 1: Introduction to Army Medical School', sequence: 1, max_score: 25, pass_score: 16, is_final: false },
  { key: 'phase_2', label: 'Phase 2: Practice Inspection', sequence: 2, max_score: 50, pass_score: 25, is_final: false },
  { key: 'phase_3_1', label: 'Phase 3.1: Driving Course', sequence: 3, max_score: 25, pass_score: 16, is_final: false },
  { key: 'phase_3_2', label: 'Phase 3.2: Sickness and Treatment Course', sequence: 4, max_score: 25, pass_score: 16, is_final: false },
  { key: 'phase_4', label: 'Phase 4: Medical Deployment & Situational Report Course', sequence: 5, max_score: 30, pass_score: 15, is_final: false },
  { key: 'final_exam', label: 'Final Examination', sequence: 6, max_score: 100, pass_score: 60, is_final: true }
];
var QUIZ_KEYS = ['phase_1', 'final_exam'];
var QUIZ_EVENTS = ['page_hidden', 'page_visible', 'window_blur', 'window_focus', 'fullscreen_entered', 'fullscreen_exited', 'fullscreen_unsupported'];

var PAGE_SIZE = 20;
var MAX_CERT_BYTES = 5 * 1024 * 1024;

/**
 * Runtime configuration. Non-secret values live in Script Properties and are
 * edited in Project Settings. Secrets (HMAC_SECRET, DISCORD_WEBHOOK_URL) are
 * also Script Properties but are never sent to the browser.
 */
var Config = (function () {
  var DEFAULTS = {
    OTP_REQUIRED: 'true',
    OTP_TTL_MINUTES: '5',
    OTP_MAX_ATTEMPTS: '5',
    OTP_RESEND_SECONDS: '60',
    OTP_MAX_RESEND_SECONDS: '900',
    OTP_ESCALATION_WINDOW_MINUTES: '60',
    PENDING_MINUTES: '15',
    TRUSTED_DEVICE_DAYS: '30',
    MAX_TRUSTED_DEVICES: '10',
    MAX_PHASE: '4',
    PROGRAM_DAYS: '',
    PASSWORD_MIN_LENGTH: '12',
    PASSWORD_ITERATIONS: '1500',
    SESSION_MINUTES: '120',
    REMEMBER_DAYS: '30',
    DISPLAY_TZ: 'Asia/Manila',
    CHAIN_IMAGE_HOSTS: 'i.imgur.com,i.ibb.co,www.image2url.com',
    DISCORD_WEBHOOK_URL: ''
  };
  var memo = null;
  function props() {
    if (!memo) memo = PropertiesService.getScriptProperties().getProperties();
    return memo;
  }
  return {
    get: function (k) {
      var p = props();
      if (p[k] !== undefined && p[k] !== null && p[k] !== '') return p[k];
      return DEFAULTS[k] !== undefined ? DEFAULTS[k] : null;
    },
    getInt: function (k) { var v = this.get(k); return v === null || v === '' ? null : parseInt(v, 10); },
    getBool: function (k) { return String(this.get(k)).toLowerCase() === 'true'; },
    set: function (k, v) { PropertiesService.getScriptProperties().setProperty(k, String(v)); memo = null; },
    reset: function () { memo = null; },
    tz: function () { return this.get('DISPLAY_TZ'); }
  };
})();
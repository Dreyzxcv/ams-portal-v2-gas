/**
 * Schema.gs - logical schema (PostgreSQL tables -> Sheets worksheets).
 * Column spec: 'name' (text) or 'name|i' int, 'name|n' number, 'name|b' bool, 'name|j' JSON.
 * Timestamps are ISO-8601 UTC strings; dates are yyyy-MM-dd strings. All cells are stored as plain text.
 */
var SCHEMA_VERSION = 1;

function tbl_(pk, cols, opts) {
  opts = opts || {};
  var names = [], types = {};
  cols.forEach(function (c) { var p = c.split('|'); names.push(p[0]); types[p[0]] = p[1] || 's'; });
  return { pk: pk, cols: names, types: types, appendOnly: !!opts.appendOnly };
}

var SCHEMA = {
  users: tbl_('id', ['id', 'name', 'username', 'email', 'email_verified_at', 'password_hash', 'password_salt', 'role', 'status',
    'force_password_change|b', 'last_login_at', 'legacy_id', 'created_at', 'updated_at', 'deleted_at']),
  trainee_profiles: tbl_('user_id', ['user_id', 'lifecycle', 'graduated_on', 'discharged_on', 'notes', 'created_at', 'updated_at']),
  batches: tbl_('id', ['id', 'legacy_id', 'name', 'starts_on', 'ends_on', 'created_at', 'updated_at', 'deleted_at']),
  batch_assignments: tbl_('id', ['id', 'batch_id', 'user_id', 'assigned_at', 'unassigned_at', 'assigned_by', 'created_at', 'updated_at']),
  grade_components: tbl_('id', ['id', 'key', 'label', 'sequence|i', 'max_score|n', 'pass_score|n', 'is_final|b', 'active|b', 'created_at', 'updated_at']),
  grade_records: tbl_('id', ['id', 'trainee_id', 'component_id', 'score|n', 'graded_by', 'graded_at', 'created_at', 'updated_at']),
  grade_revisions: tbl_('id', ['id', 'grade_record_id', 'old_score|n', 'new_score|n', 'changed_by', 'changed_at', 'reason'], { appendOnly: true }),
  audit_logs: tbl_('id', ['id', 'occurred_at', 'actor_id', 'actor_username', 'actor_role', 'action', 'subject_type', 'subject_id', 'details|j'], { appendOnly: true }),
  violations: tbl_('id', ['id', 'legacy_id', 'trainee_id', 'issued_by', 'issued_by_name', 'occurred_on', 'description', 'created_at', 'updated_at', 'deleted_at', 'deleted_by']),
  stored_files: tbl_('id', ['id', 'drive_file_id', 'original_name', 'mime_type', 'size_bytes|i', 'sha256', 'uploaded_by', 'created_at']),
  certificates: tbl_('id', ['id', 'legacy_id', 'trainee_id', 'certificate_number', 'status', 'issued_at', 'issued_by', 'file_id', 'revoked_at', 'revoked_by', 'created_at', 'updated_at']),
  trainee_progress: tbl_('trainee_id', ['trainee_id', 'current_phase|i', 'started_on', 'updated_by', 'created_at', 'updated_at']),
  otp_challenges: tbl_('id', ['id', 'user_id', 'purpose', 'code_hash', 'expires_at', 'consumed_at', 'attempts|i', 'created_at']),
  trusted_devices: tbl_('id', ['id', 'user_id', 'token_hash', 'label', 'last_used_at', 'expires_at', 'revoked_at', 'created_at']),
  sessions: tbl_('id', ['id', 'user_id', 'created_at', 'last_seen_at', 'expires_at', 'remember|b']),
  chain_of_command_entries: tbl_('id', ['id', 'legacy_id', 'name', 'rank', 'position', 'note', 'image_url', 'sort_order|i', 'created_at', 'updated_at']),
  intake_settings: tbl_('id', ['id', 'current_batch_id', 'status', 'updated_by', 'created_at', 'updated_at']),
  announcements: tbl_('id', ['id', 'recipient', 'sender', 'subject', 'body', 'signature', 'created_by', 'published_at', 'pinned_at',
    'discord_status', 'discord_attempted_at', 'discord_sent_at', 'discord_error', 'created_at', 'updated_at']),
  quizzes: tbl_('id', ['id', 'grade_component_key', 'title', 'instructions', 'duration_minutes|i', 'created_at', 'updated_at']),
  quiz_questions: tbl_('id', ['id', 'quiz_id', 'type', 'prompt', 'points|n', 'options|j', 'correct_option|i', 'position|i', 'created_at', 'updated_at']),
  quiz_accesses: tbl_('id', ['id', 'quiz_id', 'trainee_id', 'granted_by', 'granted_at', 'revoked_at', 'created_at', 'updated_at']),
  quiz_attempts: tbl_('id', ['id', 'quiz_id', 'trainee_id', 'started_at', 'expires_at', 'submitted_at', 'auto_score|n', 'manual_score|n', 'final_score|n',
    'reviewed_by', 'reviewed_at', 'created_at', 'updated_at']),
  quiz_answers: tbl_('id', ['id', 'quiz_attempt_id', 'quiz_question_id', 'answer_text', 'selected_option|i', 'auto_score|n', 'manual_score|n', 'created_at', 'updated_at']),
  meta: tbl_('key', ['key', 'value'])
};

/** Foreign keys for integrity checks: table.column -> referenced table. */
var FOREIGN_KEYS = [
  ['trainee_profiles', 'user_id', 'users'], ['batch_assignments', 'batch_id', 'batches'], ['batch_assignments', 'user_id', 'users'],
  ['grade_records', 'trainee_id', 'users'], ['grade_records', 'component_id', 'grade_components'],
  ['grade_revisions', 'grade_record_id', 'grade_records'], ['violations', 'trainee_id', 'users'],
  ['certificates', 'trainee_id', 'users'], ['certificates', 'file_id', 'stored_files'], ['trainee_progress', 'trainee_id', 'users'],
  ['quiz_questions', 'quiz_id', 'quizzes'], ['quiz_accesses', 'quiz_id', 'quizzes'], ['quiz_accesses', 'trainee_id', 'users'],
  ['quiz_attempts', 'quiz_id', 'quizzes'], ['quiz_attempts', 'trainee_id', 'users'],
  ['quiz_answers', 'quiz_attempt_id', 'quiz_attempts'], ['quiz_answers', 'quiz_question_id', 'quiz_questions']
];

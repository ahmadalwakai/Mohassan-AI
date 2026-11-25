export type AccountDataDeletion =
  | { action: 'delete'; final?: true }
  | { action: 'anonymize'; set: string }
  | { action: 'keep'; reason: string };

export interface AccountDataTable {
  table: string;
  /** Static SQL. `data` is the row alias and $1 is the bound Mohassan account ID. */
  accountPredicate: string;
  /** Explicit column allowlist. Binary attachments have separate archive entries. */
  export: readonly string[] | false;
  deletion: AccountDataDeletion;
}

function accountData(
  table: string,
  accountPredicate: string,
  columns: string | false,
  deletion: AccountDataDeletion = { action: 'delete' },
): AccountDataTable {
  return { table, accountPredicate, export: columns === false ? false : columns.trim().split(/\s+/u), deletion };
}

function owned(table: string, columns: string | false): AccountDataTable {
  return accountData(table, 'data.owner_id = $1', columns);
}

function through(key: string, table: string, parentKey = 'id'): string {
  return `data.${key} IN (SELECT ${parentKey} FROM ${table} WHERE owner_id = $1)`;
}

const ownEmail = '(SELECT lower(email) FROM "user" WHERE id = $1)';
const lastPurgeTransaction = { action: 'delete', final: true } as const;

/**
 * Account data in the checked-in PostgreSQL schema. Rows that depend on another
 * registered table are processed first to keep scopes and foreign keys intact.
 * Review each new column before adding it to an export projection.
 *
 * Repository schema reviewed 2026-11-25 at c2a0ff7, including migrations
 * run by app.ts in its workspace packages and the data-rights migration.
 * https://github.com/ahmadalwakai/Mohassan-AI/tree/c2a0ff7/apps/server/src
 * https://github.com/ahmadalwakai/Mohassan-AI/tree/c2a0ff7/packages
 */
export const memberDataRegistry: readonly AccountDataTable[] = [
  // Skills. Lock and provenance rows come before their receipts and versions.
  owned('skill_resource_locks', false),
  owned('skill_rollbacks', 'id owner_id run_id preimage_id source_receipt_id task_id input_hash before_hash after_hash status effect_started result_hash error_code created_at finished_at'),
  owned('skill_preimages', 'id receipt_id owner_id root path before_text before_hash after_hash created_at'),
  owned('skill_evidence', 'id owner_id run_id node_id task_id version_id content_hash inputs_hash status output_hash error_code created_at finished_at attempt'),
  owned('skill_run_nodes', `run_id node_id owner_id version_id content_hash composition_node_id step_id kind tool contract step dependencies
    input_bindings inputs inputs_hash output_schema outputs output_hash child_task_id status attempt error_code created_at started_at finished_at
    execution_attempt retry_not_before recovery_reason`),
  owned('skill_runs', 'id owner_id parent_task_id input_hash plan input_values pinned_versions status result error_code created_at updated_at finished_at'),
  accountData('skill_circuit_outcomes', through('state_id', 'skill_circuit_state'), 'ticket_id state_id generation outcome created_at'),
  owned('skill_circuit_state', 'id owner_id version_id content_hash target status failures generation opened_until probe_until updated_at'),
  owned('skill_quality_snapshots', 'id owner_id evaluation_id identity_hash payload payload_hash created_at'),
  owned('skill_benchmark_runs', `id owner_id baseline_id candidate_id baseline_pin candidate_pin benchmark_id suite_hash suite_snapshot pins_hash
    status results results_hash request_hash started_at finished_at error_code`),
  owned('skill_forge_generations', `id owner_id baseline_id baseline_pin mode target_slug target_version target_family_id candidate_id
    candidate_content_hash status request_hash prompt_hash pins_hash lineage_hash response_hash model usage http_status retry_after_ms
    error_code failure_analysis started_at finished_at`),
  owned('skill_catalogue_evidence', 'id owner_id version_id content_hash kind suite suite_hash passed total detail created_at'),
  owned('skill_catalogue', 'version_id owner_id facts facts_version language workflow package compatibility licence created_at'),
  owned('skill_catalogue_relations', 'owner_id from_slug to_slug relation signal score created_at'),
  owned('skill_catalogue_imports', 'id owner_id package root revision status progress report error_code started_at finished_at'),
  owned('skill_inspections', 'id version_id owner_id content_hash inspector_version verdict findings created_at'),
  owned('skill_grants', 'id version_id owner_id content_hash tools scopes roots expires_at revoked_at revoke_reason created_at'),
  owned('skill_activations', 'id family_id version_id owner_id action reason created_at'),
  accountData('skill_files', through('version_id', 'skill_versions'), 'version_id path kind content content_hash size_bytes'),
  accountData('skill_sources', through('version_id', 'skill_versions'), 'version_id kind locator observed_at file_count total_bytes'),
  owned('skill_versions', 'id family_id owner_id version sequence revision name description category level origin status status_reason contract content_hash created_at updated_at'),
  owned('skill_version_tombstones', 'family_id owner_id version content_hash sequence status policy pruned_at'),
  owned('skill_families', 'id owner_id slug active_version_id revision created_at'),
  owned('skill_audit', 'id owner_id target_id event detail created_at'),
  owned('skill_gaps', 'id owner_id chat_run_id outcome category reason signal created_at'),
  owned('skill_edges', 'owner_id edge_key record_kind payload'),
  owned('skill_remote_syncs', 'id owner_id repo ref path commit_sha cause status trees report error_code started_at finished_at'),

  // Tasks, coding and studio.
  owned('approvals', 'id task_id owner_id capability_id capability_version input_hash scope created_at expires_at consumed_at revoked_at'),
  accountData('task_events', through('task_id', 'tasks'), 'id task_id sequence type message data created_at'),
  accountData('task_plan_dependencies', through('task_id', 'tasks'), 'task_id step_id depends_on_step_id'),
  accountData('task_plan_steps', through('task_id', 'tasks'), 'task_id step_id position title description capability_id required_scopes requires_approval acceptance_criteria availability status created_at'),
  accountData('model_runs', through('task_id', 'tasks'), 'id task_id attempt provider model status input_tokens output_tokens usage_known result_committed output_hash error_code started_at finished_at'),
  accountData('coding_project_locks', through('project_id', 'coding_projects'), false),
  accountData('coding_runs', through('task_id', 'tasks'), 'id task_id project_id attempt status result result_committed error_code started_at finished_at'),
  owned('studio_ai_proposals', 'id owner_id task_id session_id base_revision status payload payload_hash applied_revision applied_at created_at updated_at'),
  owned('studio_images', 'id owner_id content_hash mime_type width height created_at expires_at'),
  owned('studio_review_images', 'id owner_id session_id task_id source_hash document_hash content_hash width height created_at expires_at'),
  accountData('studio_live_requests', through('live_id', 'studio_live_sessions'), false),
  owned('studio_live_sessions', 'id owner_id session_id revision name status elements expires_at error created_at updated_at'),
  accountData('studio_builds', through('session_id', 'studio_sessions'), 'session_id source_hash artifact created_at'),
  accountData('studio_build_locks', "data.resource_key = encode(sha256(convert_to('studio:' || $1, 'UTF8')), 'hex')", false),
  owned('studio_sessions', 'id owner_id name source_path revision base_snapshot current_snapshot undo_history created_at updated_at'),
  owned('browser_task_receipts', 'task_id owner_id session_id status input_hash content_hash screenshot_hash result_hash created_at updated_at'),
  owned('tasks', `id owner_id title goal capability_id capability_version autonomy status input_hash created_at updated_at available_at
    attempt max_attempts cancellation_requested event_sequence result error approval_required project_id studio_input browser_input
    skill_input skill_binding skill_node_input verification_only recovery_result skill_rollback_input skill_rollback_review experience_parent_run_id`),
  owned('coding_projects', 'id owner_id name repo_path base_commit allowed_paths test_profile scope_hash created_at'),

  // Browser, conversations, files, and sites.
  owned('browser_file_grants', 'id owner_id conversation_id direction status filename media_type content_hash byte_count inspection response_status error_code expires_at created_at updated_at'),
  owned('chat_images', 'id owner_id conversation_id content_hash mime_type width height bytes created_at expires_at'),
  accountData('chat_campaign_events', through('conversation_id', 'chat_conversations'), 'id conversation_id run_id task_id seq type step_id status data created_at'),
  accountData('chat_effect_receipts', through('run_id', 'chat_runs'), 'id run_id method target_hash body_hash status response_status created_at finished_at owner_reviewed_at'),
  accountData('chat_model_receipts', through('run_id', 'chat_runs'), 'id run_id step model status input_tokens output_tokens usage_known action_valid output_hash error_code started_at finished_at purpose http_status retry_after_ms retry_reason'),
  accountData('chat_events', through('conversation_id', 'chat_conversations'), 'id conversation_id run_id kind message data created_at'),
  accountData('chat_observations', through('conversation_id', 'chat_conversations'), 'id conversation_id session_id content_hash screenshot_hash created_at'),
  accountData('chat_messages', through('conversation_id', 'chat_conversations'), 'id conversation_id role text created_at images'),
  owned('chat_request_keys', false),
  owned('chat_runs', 'id conversation_id owner_id status goal steps created_at updated_at attempt intent'),
  owned('chat_conversations', 'id owner_id title status active_run_id session_id question progress error created_at updated_at'),
  owned('browser_approvals', 'id session_id owner_id observation_id digest status expires_at created_at'),
  accountData('browser_observations', through('session_id', 'browser_sessions'), 'id session_id sequence created_at'),
  accountData('browser_events', through('session_id', 'browser_sessions'), 'id session_id kind message created_at'),
  accountData('browser_locks', through('resource_key', 'browser_sessions'), false),
  owned('browser_sessions', 'id owner_id title allowed_origins status sequence expires_at created_at updated_at'),
  owned('research_runs', 'id owner_id question status report error created_at updated_at'),
  owned('pdf_documents', 'id owner_id conversation_id name byte_count content_hash pages source theme created_at'),
  owned('site_images', 'id site_id owner_id mime_type width height alt role created_at'),
  owned('sites', 'id owner_id conversation_id slug brief files files_hash checks history revision generator_version status published_url published_at created_at updated_at'),
  owned('search_index_terms', 'document_id owner_id term frequency'),
  owned('search_index_documents', 'id owner_id url url_hash source_hash content_hash title content term_count fetched_at expires_at'),
  owned('search_cache', 'owner_id cache_key policy index_revision result fetched_at expires_at'),
  owned('search_owners', 'owner_id index_revision'),

  // Memory and learning.
  accountData('memory_provenance', through('memory_id', 'memory_items'), 'memory_id evidence_id relation'),
  owned('memory_skill_evaluations', 'id skill_id owner_id kind manifest_hash result created_at'),
  owned('memory_skill_versions', 'id family_id owner_id version revision name description manifest manifest_hash status evidence_ids created_at updated_at'),
  owned('memory_skill_families', 'id owner_id name active_skill_id revision'),
  owned('memory_exact_operations', false),
  owned('memory_feedback', 'id owner_id task_id kind comment rating persisted_preference created_at'),
  owned('memory_items', 'id root_id owner_id version layer title content status confidence confidence_kind task_id expires_at created_at updated_at'),
  owned('memory_evidence', 'id owner_id kind description task_id event_id content_hash trust status observed_at expires_at'),
  owned('memory_audit', 'id owner_id target_id operation reason created_at'),
  owned('experience_feedback', 'id owner_id source_kind source_id attempt rating confirmed memory_feedback_id created_at'),
  owned('experiences', 'owner_id source_kind source_id parent_run_id attempt goal category terminal_status plan trail models artifact_hashes outcome evidence_kind evidence created_at updated_at'),
  owned('learning_lessons', 'id owner_id root_id version status text scope content_hash sources evaluation_id expires_at created_at updated_at'),
  owned('learning_documents', 'id owner_id source_path title version status source_hash content_hash text chunks evaluation_id created_at updated_at extraction_policy'),
  owned('learning_content_evaluations', 'id owner_id subject_kind subject_id subject_hash status report created_at completed_at'),
  owned('learning_content_owners', false),

  // Connected services and devices. Google Ads connection identity is name only.
  owned('google_ads_oauth_states', false),
  owned('google_ads_automatic_requests', 'owner_id draft_id status created_at updated_at'),
  owned('google_ads_approvals', 'id owner_id draft_id action draft_hash expires_at consumed_at created_at'),
  owned('google_ads_audit', 'id owner_id draft_id type created_at'),
  owned('google_ads_experiences', 'id owner_id kind statement created_at'),
  owned('google_ads_drafts', 'id owner_id state revision brief bidding draft_hash geo_targets summary strategy error created_at updated_at'),
  owned('google_ads_recovery_lessons', 'owner_id category code strategy verified_by successes failures updated_at'),
  owned('google_ads_connections', 'account_name'),
  owned('chrome_extension_jobs', 'id owner_id status campaign message steps created_at updated_at source_run_id'),
  owned('chrome_extension_bindings', 'owner_id connected preferred_transport last_seen_at'),
  owned('windows_commands', 'id grant_id device_id owner_id sequence frame_id status expires_at created_at finished_at result_code input_hash'),
  accountData('windows_poll_nonces', through('device_id', 'windows_devices'), false),
  owned('windows_grants', 'id owner_id device_id scope target_key expires_at revoked_at next_sequence created_at'),
  owned('windows_devices', 'id owner_id name revoked_at last_seen_at created_at'),
  owned('windows_pairings', false),
  owned('windows_audit', 'id owner_id device_id type created_at'),

  // Auth secrets, invitations and account administration.
  accountData('verification', `data.value = $1 OR lower(data.identifier) = ${ownEmail}`, false),
  accountData('account', 'data."userId" = $1', 'id providerId userId createdAt updatedAt'),
  accountData('session', 'data."userId" = $1', 'id userId userAgent createdAt updatedAt expiresAt'),
  accountData('workspace_invites', `data.created_by = $1 OR data.consumed_by = $1 OR lower(data.email) = ${ownEmail}`,
    'id created_at expires_at claimed_at revoked_at'),
  accountData('ai_provider_settings', 'data.updated_by = $1', 'id enabled models automatic_fallback free_only updated_at',
    { action: 'anonymize', set: 'updated_by = NULL' }),
  accountData('workspace_owner', 'data.owner_id = $1', 'owner_id claimed_at',
    { action: 'keep', reason: 'The workspace must retain its protected primary owner assignment.' }),
  accountData('workspace_member_audit', 'data.actor_id = $1 OR data.target_id = $1', false,
    { action: 'keep', reason: 'The owner retains an append-only record of member administration with opaque identifiers, action and time.' }),
  accountData('member_data_exports', 'data.user_id = $1', false),
  accountData('member_deletion_requests', 'data.user_id = $1', 'user_id requested_at purge_after started_at', lastPurgeTransaction),
  accountData('workspace_members', 'data.user_id = $1', 'user_id role invite_id created_at disabled_at', lastPurgeTransaction),
  accountData('user', 'data.id = $1', 'id name email emailVerified image createdAt updatedAt', lastPurgeTransaction),
];

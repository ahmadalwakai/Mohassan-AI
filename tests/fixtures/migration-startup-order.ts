// Observed by tracing the real startup at 29448ae, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/app.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/docs/MIGRATION-LEDGER-2026-11-25.md
export const startupOrder = [
  'auth:001_auth', 'auth:002_members',
  '001_runtime', '002_approval_attempt', '003_cognitive_planning', '004_coding_engine',
  '005_visual_studio', '006_react_studio', '007_studio_ai_input', '011_browser_task_input',
  '023_runtime_skills', '025_runtime_recovery', '026_experiences', '035_chat_conversation_review',
  '037_notifications', '010_studio_live', '009_studio_visual_reviews', '008_studio_ai_proposals',
  '012_browser_task_receipts', '007_memory_learning_v1', 'memory_exact_writes_v1', '036_structured_memory',
  '015_skill_registry', '016_skill_security', '017_skill_execution', '024_skill_recovery',
  '018_skill_gaps', '019_skill_graph', '020_skill_eval', '021_skill_forge', '032_skill_remote',
  '033_skill_retention', '034_skill_catalogue', '030_sites', '013_command_chat', '014_assistant',
  '022_chat_execution_safety', '027_chat_browser_recovery', '028_chat_recovery_review', '029_chat_images',
  '033_chat_request_keys', '029_chat_campaign_events', '038_reminders', '039_conversation_shares',
  'auth:003_member_run_quota', '040_member_data_rights', '041_long_run_checkpoints', '042_background_results',
  '043_smart_monitors', '044_smart_monitors_v2', '045_smart_monitor_conversation_controls',
  '046_smart_monitor_visual_budget', '047_monitor_alert_feedback', '048_smart_monitor_decisions',
  'chat_message_experiment_v5', 'chat_message_council_v1',
];

import type { ColumnType } from "kysely";

export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type JsonRecord = ColumnType<Record<string, unknown> | null, string | null, string | null>;

export interface TaskRecord {
  id: string;
  owner_id: string;
  title: string;
  goal: string;
  capability_id: string;
  capability_version: string;
  autonomy: "assisted" | "scoped" | "shadow";
  status: "queued" | "running" | "waiting_approval" | "verifying" | "completed" | "failed" | "cancelled" | "paused";
  input_hash: string;
  idempotency_key: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  available_at: Timestamp;
  attempt: number;
  max_attempts: number;
  lease_token: string | null;
  lease_expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  cancellation_requested: boolean;
  approval_required: boolean;
  event_sequence: number;
  result: JsonRecord;
  error: string | null;
  project_id: ColumnType<string|null,string|null|undefined,string|null>;
  studio_input:ColumnType<Record<string,unknown>|null,string|null|undefined,string|null>;
  browser_input:ColumnType<Record<string,unknown>|null,string|null|undefined,string|null>;
  skill_input:ColumnType<Record<string,unknown>|null,string|null|undefined,string|null>;
  skill_binding:ColumnType<Record<string,unknown>|null,string|null|undefined,string|null>;
  skill_node_input:ColumnType<Record<string,unknown>|null,string|null|undefined,string|null>;
  workflow_token:ColumnType<string|null,string|null|undefined,string|null>;
  verification_only:ColumnType<boolean,boolean|undefined,boolean>;
  verification_source_lease:ColumnType<string|null,string|null|undefined,string|null>;
  recovery_result:ColumnType<Record<string,unknown>|null,string|null|undefined,string|null>;
  skill_rollback_input:ColumnType<Record<string,unknown>|null,string|null|undefined,string|null>;
  skill_rollback_review:ColumnType<Record<string,unknown>|null,string|null|undefined,string|null>;
}

export interface TaskEventRecord {
  id: string;
  task_id: string;
  sequence: number;
  type: string;
  message: string;
  data: ColumnType<Record<string, unknown>, string, string>;
  created_at: Timestamp;
}

export interface ApprovalRecord {
  id: string;
  task_id: string;
  owner_id: string;
  capability_id: string;
  capability_version: string;
  input_hash: string;
  scope: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  consumed_at: ColumnType<Date | null, Date | null, Date | null>;
  consumed_lease_token: string | null;
  revoked_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface RuntimeDatabase {
  tasks: TaskRecord;
  task_events: TaskEventRecord;
  approvals: ApprovalRecord;
  task_plan_steps: TaskPlanStepRecord;
  task_plan_dependencies: TaskPlanDependencyRecord;
  model_runs: ModelRunRecord;
  coding_projects:CodingProjectRecord;
  coding_runs:CodingRunRecord;
  studio_sessions:{id:string;owner_id:string;revision:string;current_snapshot:JsonRecord};
  studio_images:{id:string;owner_id:string;content_hash:string;expires_at:Timestamp};
}

export interface CodingProjectRecord {
  id:string;owner_id:string;name:string;repo_path:string;base_commit:string;
  allowed_paths:ColumnType<string[],string,string>;test_profile:'node-test';scope_hash:string;created_at:Timestamp;
}
export interface CodingRunRecord {
  id:string;task_id:string;project_id:string;attempt:number;lease_token:string;
  status:'started'|'succeeded'|'failed'|'unknown';result:JsonRecord;result_committed:boolean;error_code:string|null;
  started_at:Timestamp;finished_at:ColumnType<Date|null,Date|null,Date|null>;
}

export interface TaskPlanStepRecord {
  task_id: string;
  step_id: string;
  position: number;
  title: string;
  description: string;
  capability_id: string | null;
  required_scopes: ColumnType<string[], string, string>;
  requires_approval: boolean;
  acceptance_criteria: ColumnType<string[], string, string>;
  availability: string | null;
  status: "planned";
  created_at: Timestamp;
}

export interface TaskPlanDependencyRecord {
  task_id: string;
  step_id: string;
  depends_on_step_id: string;
}

export interface ModelRunRecord {
  id: string;
  task_id: string;
  attempt: number;
  lease_token: string;
  provider: string;
  model: string | null;
  status: "started" | "succeeded" | "failed" | "unknown";
  input_tokens: number | null;
  output_tokens: number | null;
  usage_known: boolean;
  result_committed: boolean;
  output_hash: string | null;
  error_code: string | null;
  started_at: Timestamp;
  finished_at: ColumnType<Date | null, Date | null, Date | null>;
}

import type { RequestRoutingDecision } from '../routing-decision.js';

export type PlanTool = 'compute' | 'search' | 'read' | 'remember' | 'recall' | 'pdf' | 'letter' | 'site' | 'compare' | 'unsupported';
export type PlanOutputType = 'number' | 'text' | 'list' | 'file' | 'entity';

export type PlanValue =
  | { type: 'number'; value: number; label?: string; unit?: string }
  | { type: 'text'; value: string }
  | { type: 'list'; value: string[] }
  | { type: 'file'; value: string; label?: string }
  | { type: 'entity'; value: string; url?: string; label?: string };

export interface PlanReference {
  stepId: string;
  kind: 'number' | 'text' | 'entity' | 'value';
  /** Offsets in the original clause. Implicit references and order constraints have no span. */
  start?: number;
  end?: number;
}

export interface PlanStep {
  id: string;
  text: string;
  route: RequestRoutingDecision['route'];
  tool: PlanTool;
  inputs: { text: string; references: PlanReference[] };
  output: PlanOutputType;
  success: PlanOutputType;
  dependsOn: string[];
  /** True only when extrinsic inputs are eligible for a public request. */
  publicInput: boolean;
  /** Available for an independent search approved by the existing route decision. */
  publicQuery?: string;
}

export interface CompiledPlan {
  lang: 'ar' | 'en';
  steps: PlanStep[];
}

export interface ResolvedStepInputs {
  text: string;
  references: Array<{ reference: PlanReference; value: PlanValue }>;
}

import type { CodingEdits } from "@mohassan/contracts";
import type { SnapshotFile } from "./security.ts";

export interface CodingContextFile extends SnapshotFile {
  hash: string;
  editable: boolean;
}

export interface CodingModelReceipt {
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface CodingContext {
  taskId: string;
  goal: string;
  baseCommit: string;
  files: CodingContextFile[];
  signal: AbortSignal;
  onModelReceipt?: (receipt: CodingModelReceipt) => Promise<void>;
  /** Local tools bound to the immutable run snapshot. */
  tools?: {
    repairTypeScript(): Map<string, string>;
    fixESLint?(paths: string[], proposed: ReadonlyMap<string, string>, formatting: boolean): Promise<SnapshotFile[]>;
  };
}

export interface EditRefusal {
  kind: "refused";
  code: "NO_PROVEN_FIX";
  reason: string;
}

export interface EditGenerator {
  (context: CodingContext): Promise<CodingEdits | EditRefusal>;
  readonly mode?: "deterministic";
}

import { z } from 'zod';
import { SkillLevelSchema, SkillToolIdSchema } from './skills';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SkillGraphNodeKeySchema = z.string().max(140).regex(/^(?:skill|outcome):[a-f0-9-]{36}$|^(?:tool|capability):[a-z][a-z0-9_.:-]{0,99}$/);
const NodeBase = { key: SkillGraphNodeKeySchema, label: z.string().min(1).max(120) };
export const SkillGraphNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...NodeBase, kind: z.literal('skill'), skillVersionId: z.uuid(), slug: z.string().max(64), version: z.string().max(30), contentHash: Hash, level: SkillLevelSchema, active: z.boolean(), routingEligible: z.boolean(), verification: z.literal('current_metadata') }).strict(),
  z.object({ ...NodeBase, kind: z.literal('tool'), toolId: SkillToolIdSchema }).strict(),
  z.object({ ...NodeBase, kind: z.literal('capability'), capabilityId: z.string().min(1).max(100) }).strict(),
  z.object({ ...NodeBase, kind: z.literal('outcome'), scope: z.literal('step'), receiptId: z.uuid(), taskId: z.uuid(), runId: z.uuid(), nodeId: z.string().max(97), inputsHash: Hash, outputHash: Hash, attempt: z.number().int().min(1).max(3), verifiedAt: z.iso.datetime() }).strict(),
]);
export const SkillGraphEdgeSchema = z.object({
  id: Hash, from: SkillGraphNodeKeySchema, to: SkillGraphNodeKeySchema,
  relation: z.enum(['depends_on', 'conflicts_with', 'requires_tool', 'implemented_by', 'verified_outcome']),
  provenance: z.enum(['declared_contract', 'trusted_tool_mapping', 'verified_receipt']),
  sourceContentHash: Hash.nullable(), targetContentHash: Hash.nullable(),
}).strict();
export const SkillGraphSnapshotSchema = z.object({
  nodes: z.array(SkillGraphNodeSchema).max(400), edges: z.array(SkillGraphEdgeSchema).max(1200), truncated: z.boolean(), rebuilt: z.boolean(),
  snapshotHash: Hash, permissionsGranted: z.literal(false),
  limits: z.object({ versions: z.literal(200), outcomes: z.literal(80), nodes: z.literal(400), edges: z.literal(1200), depth: z.literal(2) }).strict(),
}).strict();
export const SkillGraphQuerySchema = z.object({}).strict();
export const SkillGraphRelatedQuerySchema = z.object({ depth: z.coerce.number().int().min(0).max(2).default(2), limit: z.coerce.number().int().min(1).max(24).default(12) }).strict();
export const SkillGraphRelatedSchema = z.object({ skillIds: z.array(z.uuid()).max(24), truncated: z.boolean(), permissionsGranted: z.literal(false) }).strict();
export type SkillGraphNode = z.infer<typeof SkillGraphNodeSchema>;
export type SkillGraphEdge = z.infer<typeof SkillGraphEdgeSchema>;
export type SkillGraphSnapshot = z.infer<typeof SkillGraphSnapshotSchema>;
export type SkillGraphRelated = z.infer<typeof SkillGraphRelatedSchema>;

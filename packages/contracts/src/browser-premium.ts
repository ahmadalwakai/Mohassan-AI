import { z } from 'zod';

export const browserPremiumStepKinds = ['opening', 'reading', 'typing', 'loading', 'handover', 'resumed', 'done'] as const;
export type BrowserPremiumStepKind = typeof browserPremiumStepKinds[number];

const fraction = z.number().min(0).max(1);
export const BrowserPremiumTargetSchema = z.object({
  x: fraction,
  y: fraction,
  width: fraction,
  height: fraction,
}).strict();
export type BrowserPremiumTarget = z.infer<typeof BrowserPremiumTargetSchema>;

export const BrowserPremiumMetadataSchema = z.object({
  site: z.object({
    domain: z.string().min(1).max(253),
    favicon: z.string().max(22_000).regex(/^data:image\/(?:png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon);base64,[\da-z+/]+=*$/i).optional(),
  }).strict().optional(),
  target: BrowserPremiumTargetSchema.optional(),
  steps: z.array(z.object({ id: z.string(), kind: z.enum(browserPremiumStepKinds) }).strict()).max(12),
}).strict();
export type BrowserPremiumMetadata = z.infer<typeof BrowserPremiumMetadataSchema>;

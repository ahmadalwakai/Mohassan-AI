import { ModelCouncilSchema } from '@mohassan/contracts';

// Shape verified against the repository contract (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/contracts/src/command-chat.ts#L98-L130
export function memberCouncilFixture(privateText: string) {
  const chosen = 'reading-v3-last';
  return ModelCouncilSchema.parse({
    version: 1, chosen, changed: true, reason: 'Fixture decision', elapsedMs: 0,
    members: [{ model: chosen, label: 'Fixture model', round: 'answer', outcome: 'ok', output: privateText, elapsedMs: 0, chosen: true }],
  });
}

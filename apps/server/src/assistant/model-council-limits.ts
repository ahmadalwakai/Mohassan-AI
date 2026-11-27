// Rollout budget for the two-OCPU deployment: one active council and one waiting turn on the single API process.
// Deployment sizing: https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/scripts/cloud-linux/README.md#L7 (retrieved 2026-11-27).
export const MODEL_COUNCIL_LIMITS = Object.freeze({ concurrent: 1, queued: 1 });

// Use the baseline council budget for the combined waiting and deliberation window.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/model-council.ts#L305-L307 (retrieved 2026-11-27).
export const MODEL_COUNCIL_WINDOW_MS = 45_000;

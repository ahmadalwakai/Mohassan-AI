/** Review and evidence selection are opt-in on the server. */
export function feedbackLoopEnabled(): boolean {
  return process.env.FEEDBACK_LOOP_ENABLED === '1';
}

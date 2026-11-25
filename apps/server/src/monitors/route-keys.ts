const base = '/api/chat/monitors';
export const monitorPaths = {
  base, pause: `${base}/:id/pause`, resume: `${base}/:id/resume`, stop: `${base}/:id/stop`,
  decisionRecording: `${base}/decision-recording`, alertFeedback: `${base}/alert-feedback`,
} as const;
export const MONITOR_MEMBER_ROUTES = [
  `GET ${base}`, `POST ${base}`, `POST ${monitorPaths.pause}`, `POST ${monitorPaths.resume}`, `POST ${monitorPaths.stop}`,
  `GET ${monitorPaths.decisionRecording}`, `POST ${monitorPaths.decisionRecording}`, `POST ${monitorPaths.alertFeedback}`,
] as const;

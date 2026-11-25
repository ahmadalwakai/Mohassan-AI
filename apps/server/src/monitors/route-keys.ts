const base = '/api/chat/monitors';
export const monitorPaths = { base, pause: `${base}/:id/pause`, resume: `${base}/:id/resume`, stop: `${base}/:id/stop` } as const;
export const MONITOR_MEMBER_ROUTES = [
  `GET ${base}`, `POST ${base}`, `POST ${monitorPaths.pause}`, `POST ${monitorPaths.resume}`, `POST ${monitorPaths.stop}`,
] as const;

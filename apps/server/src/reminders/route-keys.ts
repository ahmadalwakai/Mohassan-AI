const base = '/api/reminders';
export const reminderPaths = { base, due: `${base}/due`, item: `${base}/:id` } as const;

export const REMINDER_MEMBER_ROUTES = [
  `GET ${reminderPaths.base}`,
  `GET ${reminderPaths.due}`,
  `POST ${reminderPaths.base}`,
  `PATCH ${reminderPaths.item}`,
  `DELETE ${reminderPaths.item}`,
] as const;

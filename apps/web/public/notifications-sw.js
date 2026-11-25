const notificationTitles = new Map([
  ['task_completed', 'اكتملت المهمة'],
  ['needs_you', 'تحتاجك خطوة'],
  ['task_failed', 'تعذّر الإكمال'],
  ['reminder_due', 'حان موعد التذكير'],
]);
const conversationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

self.addEventListener('push', (event) => {
  event.waitUntil(showPush(event.data));
});

async function showPush(data) {
  let payload;
  try { payload = data?.json(); } catch { return; }
  const title = notificationTitles.get(payload?.kind);
  if (!title || typeof payload.taskId !== 'string' || !conversationIdPattern.test(payload.taskId)) return;
  if (payload.conversationId !== null && (typeof payload.conversationId !== 'string' || !conversationIdPattern.test(payload.conversationId))) return;

  const url = `/api/notifications/events/${encodeURIComponent(payload.taskId)}`;
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  if (response?.status !== 204) return;

  await self.registration.showNotification(title, {
    body: payload.conversationId && typeof payload.conversationTitle === 'string' ? payload.conversationTitle.slice(0, 160) : undefined,
    data: { conversationId: payload.conversationId },
    tag: `mohassan-task-${payload.taskId}`,
    dir: 'rtl',
    lang: 'ar',
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openConversation(event.notification.data?.conversationId));
});

async function openConversation(conversationId) {
  const url = new URL('/', self.location.origin);
  if (typeof conversationId === 'string' && conversationIdPattern.test(conversationId)) {
    url.searchParams.set('conversation', conversationId);
  }

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((client) => client.url === url.href);
  if (existing) return existing.focus();
  const chat = windows.find((client) => new URL(client.url).origin === url.origin && new URL(client.url).pathname === '/');
  if (chat) {
    const navigated = await chat.navigate(url.href).catch(() => null);
    if (navigated) return navigated.focus();
  }
  return self.clients.openWindow(url.href);
}

const notificationTitles = new Map([
  ['task_completed', 'اكتملت المهمة'],
  ['needs_you', 'تحتاجك خطوة'],
  ['task_failed', 'تعذّر الإكمال'],
  ['task_progress', 'تقدّم العمل'],
  ['reminder_due', 'حان موعد التذكير'],
]);
const conversationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const backgroundKinds = new Set(['run-completed', 'run-blocked', 'run-failed']);
const backgroundPushReceipts = 'mohassan-background-push-v1';
const activeBackgroundPushes = new Set();

self.addEventListener('push', (event) => {
  event.waitUntil(showPush(event.data));
});

async function showPush(data) {
  let payload;
  try { payload = data?.json(); } catch { return; }
  const title = notificationTitles.get(payload?.kind);
  if (!title || typeof payload.taskId !== 'string' || !conversationIdPattern.test(payload.taskId)) return;
  if (payload.conversationId !== null && (typeof payload.conversationId !== 'string' || !conversationIdPattern.test(payload.conversationId))) return;
  if (payload.runKind !== undefined && (!backgroundKinds.has(payload.runKind)
      || typeof payload.runId !== 'string' || !conversationIdPattern.test(payload.runId) || !payload.conversationId)) return;

  const url = `/api/notifications/events/${encodeURIComponent(payload.taskId)}`;
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  if (response?.status !== 204) return;

  if (payload.runKind) return showBackgroundPush(payload, title, url);
  await self.registration.showNotification(title, {
    body: payload.conversationId && typeof payload.conversationTitle === 'string' ? payload.conversationTitle.slice(0, 160) : undefined,
    data: { conversationId: payload.conversationId },
    tag: `mohassan-task-${payload.taskId}`,
    dir: 'rtl',
    lang: 'ar',
  });
}

async function showBackgroundPush(payload, fallbackTitle, eventPath) {
  const { taskId, conversationId } = payload;
  if (activeBackgroundPushes.has(taskId)) return;
  activeBackgroundPushes.add(taskId);
  try {
    const tag = `mohassan-task-${taskId}`;
    const key = new URL(eventPath, self.location.origin).href;
    const receipts = await self.caches?.open(backgroundPushReceipts).catch(() => null);
    if (await receipts?.match(key).catch(() => null)) return;
    const existing = await self.registration.getNotifications?.({ tag }).catch(() => []);
    const english = payload.language === 'en';
    if (!existing?.length) await self.registration.showNotification(
      typeof payload.title === 'string' ? payload.title.slice(0, 100) : fallbackTitle,
      {
        body: typeof payload.body === 'string' ? payload.body.slice(0, 160) : undefined,
        data: { conversationId },
        tag,
        dir: english ? 'ltr' : 'rtl',
        lang: english ? 'en' : 'ar',
        renotify: false,
      },
    );
    if (receipts) {
      // Keep a bounded receipt cache so retries are quiet after a worker or server restart.
      await receipts.put(key, new Response(null, { status: 204 })).then(async () => {
        const entries = await receipts.keys();
        await Promise.all(entries.slice(0, Math.max(0, entries.length - 512)).map(entry => receipts.delete(entry)));
      }).catch(() => {});
    }
  } finally {
    activeBackgroundPushes.delete(taskId);
  }
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

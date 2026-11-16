(() => {
  if (globalThis.__mohassanRelay) return;
  globalThis.__mohassanRelay = true;
  const paths = /^\/api\/chrome-extension\/(?:status|heartbeat|disconnect|jobs\/claim|jobs\/[a-f0-9-]{36}\/(?:result|resume))$/;
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message?.kind !== 'relay-fetch') return;
    if (message.origin !== location.origin || !paths.test(message.path) || !['GET', 'POST'].includes(message.method)) {
      reply({ ok: false, error: 'تغيّر تبويب موحسن. أعد ربطه من الإضافة.' }); return;
    }
    fetch(message.path, {
      method: message.method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...(message.method === 'POST' ? { body: JSON.stringify(message.body ?? {}) } : {}),
      signal: AbortSignal.timeout(12000),
    }).then(async response => {
      const result = await response.json();
      reply(response.ok ? { ok: true, data: result } : { ok: false, error: result?.error?.message ?? 'تعذر الاتصال بموحسن.', code: result?.error?.code, status: response.status });
    }).catch(() => reply({ ok: false, error: 'تعذر الاتصال بموحسن. افتح تبويبه وسجّل الدخول.' }));
    return true;
  });
  // A visible owner-selected tab keeps the bridge responsive. Alarms restore it after reloads.
  setInterval(() => chrome.runtime.sendMessage({ kind: 'relay-tick' }).catch(() => {}), 5000);
})();

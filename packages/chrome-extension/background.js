const KEY = 'mohassan-bridge-v1';
const ADS_TYPED_API_REQUIRED = 'تعبئة Google Ads عبر Chrome متوقفة. استخدم تكامل Google Ads الرسمي للتحقق من الحساب والنطاق وحفظ الحملة وقراءتها بعد التنفيذ.';
let ticking = false, stopped = false, configuring = false, generation = 0;
const read = async () => (await chrome.storage.local.get(KEY))[KEY] ?? { app: null, binding: null, message: 'اربط موحسن ثم تبويب Google Ads.', journal: null };
const write = value => chrome.storage.local.set({ [KEY]: value });
const validApp = value => { try { const url = new URL(value); return url.origin === value && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) && !url.hostname.endsWith('google.com'); } catch { return false; } };
const adsUrl = value => { try { const u = new URL(value); return u.origin === 'https://ads.google.com' && /^\/aw\/campaigns\/new(?:\/|$)/.test(u.pathname); } catch { return false; } };
async function ensureRelay(state) {
  if (!state.app) throw new Error('اربط تبويب موحسن أولاً.');
  const tab = await chrome.tabs.get(state.app.tabId);
  if (new URL(tab.url).origin !== state.app.origin) throw new Error('تغيّر تبويب موحسن. أعد ربطه.');
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['relay.js'] });
}
async function api(state, path, body) {
  await ensureRelay(state);
  const response = await chrome.tabs.sendMessage(state.app.tabId, { kind: 'relay-fetch', origin: state.app.origin, path: `/api/chrome-extension/${path}`, method: body === undefined ? 'GET' : 'POST', body }, { frameId: 0 });
  if (!response?.ok) { const error = new Error(response?.error ?? 'تعذر الاتصال بموحسن.'); error.code = response?.code; throw error; }
  return response.data;
}
async function adapter(tabId, method, payload) {
  // Do not dispatch cached jobs or generic adapter methods, even against an older server.
  // Inspect is the only page capability needed to maintain a read-only connection.
  if (method !== 'inspect') throw new Error(ADS_TYPED_API_REQUIRED);
  const tab = await chrome.tabs.get(tabId);
  if (!adsUrl(tab.url)) throw new Error('افتح معالج حملة جديدة في تبويب Google Ads المختار.');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['ads-adapter.js'] });
  const result = await chrome.scripting.executeScript({ target: { tabId }, func: (name, data) => globalThis.__mohassanAdsAdapter[name](data), args: [method, payload] });
  if (!result[0]?.result) throw new Error('تعذر قراءة معالج Google Ads.');
  return result[0].result;
}
async function tick() {
  if (ticking || configuring) return;
  ticking = true;
  const tickGeneration = generation;
  try {
    let state = await read();
    if (!state.binding || !state.app || stopped) return;
    const server = await api(state, 'heartbeat', state.binding);
    const afterHeartbeat = await read();
    if (stopped || tickGeneration !== generation || afterHeartbeat.binding?.clientId !== state.binding.clientId || afterHeartbeat.app?.tabId !== state.app.tabId || afterHeartbeat.app?.origin !== state.app.origin) return;
    state = afterHeartbeat;
    // Older servers may still return an active job. Cancel it; never claim, resume,
    // acknowledge completion, or replay a locally stored journal/checkpoint.
    const legacyJob = server.latestJob;
    if (legacyJob && ['queued', 'running'].includes(legacyJob.status)) await api(state, `jobs/${legacyJob.id}/cancel`, {});
    const current = await read();
    if (stopped || tickGeneration !== generation || current.binding?.clientId !== state.binding.clientId) return;
    await write({ ...current, journal: null, checkpoint: null, message: ADS_TYPED_API_REQUIRED });
  } catch (error) {
    if (tickGeneration !== generation) return;
    const state = await read();
    const message = error instanceof Error ? error.message : 'توقف اتصال الإضافة.';
    if (error?.code === 'CHROME_CONNECTION_REVOKED') {
      stopped = true;
      await write({ ...state, binding: null, journal: null, message: 'فُصلت الإضافة من موحسن. أعد الربط من تبويب Google Ads للمتابعة.' });
      await chrome.alarms.clear('mohassan-bridge'); return;
    }
    // A failed cancellation is disclosed; no local execution data may become runnable.
    await write({ ...state, journal: null, checkpoint: null, message: `${ADS_TYPED_API_REQUIRED} ${message}` });
  } finally { ticking = false; }
}
async function popup(message) {
  let state = await read();
  const configurationGeneration = generation;
  if (message.kind === 'popup-status') return state;
  if (message.kind === 'pair-app') {
    if (state.journal) throw new Error('أوقف المهمة الحالية قبل تغيير الربط.');
    if (!Number.isInteger(message.tabId) || !validApp(message.origin)) throw new Error('عنوان موحسن غير صالح.');
    const next = { ...state, app: { tabId: message.tabId, origin: message.origin }, binding: null };
    const status = await api(next, 'status');
    if (typeof status?.connected !== 'boolean') throw new Error('هذا التبويب لا يعرض خدمة موحسن المتوافقة.');
    if (state.binding) await api(state, 'disconnect', { clientId: state.binding.clientId });
    if (configurationGeneration !== generation) throw new Error('أُوقف الربط قبل اكتماله.');
    await write({ ...next, message: 'رُبط موحسن. اختر الآن تبويب حملة Google Ads الجديدة.' });
    return true;
  }
  if (message.kind === 'pair-ads') {
    if (state.journal) throw new Error('أوقف المهمة الحالية قبل تغيير الحساب.');
    if (!state.app || !/^\d{10}$/.test(message.customerId) || !/^[A-Z]{3}$/.test(message.currency) || !Number.isInteger(message.tabId)) throw new Error('اربط موحسن وأدخل رقم الحساب وعملته.');
    const inspected = await adapter(message.tabId, 'inspect', { customerId: message.customerId, currency: message.currency });
    if (!inspected.ok) throw new Error(inspected.message);
    if (state.binding) await api(state, 'disconnect', { clientId: state.binding.clientId });
    const binding = { clientId: crypto.randomUUID(), tabId: message.tabId, customerId: message.customerId, currency: message.currency, extensionVersion: chrome.runtime.getManifest().version };
    await api(state, 'heartbeat', binding);
    if (configurationGeneration !== generation) { await api(state, 'disconnect', { clientId: binding.clientId }).catch(() => {}); throw new Error('أُوقف الربط قبل اكتماله.'); }
    stopped = false;
    await write({ ...state, binding, journal: null, checkpoint: null, message: 'الإضافة متصلة. اترك تبويب موحسن مفتوحاً وأجب عن بطاقة الحملة فيه.' });
    await chrome.alarms.create('mohassan-bridge', { periodInMinutes: 0.5 });
    void tick(); return true;
  }
  if (message.kind === 'resume') {
    throw new Error(ADS_TYPED_API_REQUIRED);
  }
  if (message.kind === 'stop') {
    generation++;
    stopped = true;
    // Local revocation is durable even if the app tab is closed or the server is offline.
    await write({ ...state, binding: null, journal: null, checkpoint: null, message: 'أُوقف التنفيذ وفُصلت الإضافة. راجع ما مُلئ في تبويب Google Ads.' });
    await chrome.alarms.clear('mohassan-bridge');
    if (state.binding) {
      await chrome.scripting.executeScript({ target: { tabId: state.binding.tabId }, func: () => { if (globalThis.__mohassanAdsAdapter) globalThis.__mohassanAdsAdapter.stop(); } }).catch(() => {});
      await api(state, 'disconnect', { clientId: state.binding.clientId }).catch(async () => {
        await write({ ...await read(), binding: null, journal: null, checkpoint: null, message: 'أُوقفت الإضافة محلياً. تعذر تأكيد الفصل مع موحسن؛ افتح تبويبه لإلغاء المهمة هناك.' });
      });
    }
    return true;
  }
  throw new Error('طلب غير معروف.');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.kind === 'adapter-check') {
    reply({ allowed: false, message: ADS_TYPED_API_REQUIRED });
    return;
  }
  if (message?.kind === 'relay-tick') {
    read().then(state => { if (sender.frameId === 0 && sender.tab?.id === state.app?.tabId && sender.origin === state.app.origin) void tick(); }).catch(() => {});
    return;
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) return;
  const configuration = ['pair-app', 'pair-ads', 'resume'].includes(message.kind);
  if (configuration && (ticking || configuring)) { reply({ ok: false, error: 'انتظر انتهاء الخطوة الحالية أو اضغط إيقاف.' }); return; }
  if (configuration) configuring = true;
  popup(message).then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error.message })).finally(() => { if (configuration) { configuring = false; void tick(); } }); return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'mohassan-bridge') void tick(); });
chrome.tabs.onRemoved.addListener(tabId => { read().then(async state => { if (state.binding?.tabId === tabId || state.app?.tabId === tabId) { stopped = true; generation++; await write({ ...state, binding: null, journal: null, checkpoint: null, message: 'أُغلق أحد التبويبين. أعد الربط قبل المتابعة.' }); await chrome.alarms.clear('mohassan-bridge'); if (state.binding && state.app?.tabId !== tabId) await api(state, 'disconnect', { clientId: state.binding.clientId }).catch(() => {}); } }); });

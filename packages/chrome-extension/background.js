const KEY = 'mohassan-bridge-v1';
let ticking = false, stopped = false, configuring = false, generation = 0;
const read = async () => (await chrome.storage.local.get(KEY))[KEY] ?? { app: null, binding: null, message: 'اربط موحسن ثم تبويب Google Ads.', journal: null };
const write = value => chrome.storage.local.set({ [KEY]: value });
const checkpoint = journal => ({ jobId: journal.job.id, leaseId: journal.job.leaseId, progress: journal.progress ?? { done: [], snapshots: {} }, steps: journal.steps ?? [] });
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
  const tab = await chrome.tabs.get(tabId);
  if (!adsUrl(tab.url)) throw new Error('افتح معالج حملة جديدة في تبويب Google Ads المختار.');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['ads-adapter.js'] });
  const result = await chrome.scripting.executeScript({ target: { tabId }, func: (name, data) => globalThis.__mohassanAdsAdapter[name](data), args: [method, payload] });
  if (!result[0]?.result) throw new Error('تعذر قراءة معالج Google Ads.');
  return result[0].result;
}
function validJob(job, binding) {
  const c = job?.campaign;
  return job && /^[a-f0-9-]{36}$/.test(job.id) && typeof job.leaseId === 'string' && job.leaseId.length >= 16 && job.status === 'running' && job.clientId === binding.clientId && job.tabId === binding.tabId && job.customerId === binding.customerId && job.currency === binding.currency
    && c && c.type === 'search' && c.customerId === binding.customerId && c.currency === binding.currency && typeof c.campaignName === 'string' && c.campaignName.length <= 160
    && ['calls', 'bookings', 'leads'].includes(c.goal) && /^\d{1,6}(?:\.\d{1,2})?$/.test(c.dailyBudget) && Number(c.dailyBudget) > 0
    && /^[A-Z]{2}$/.test(c.countryCode) && /^[a-z]{2}$/.test(c.adLanguage) && /^https?:\/\//.test(c.finalUrl)
    && ['locations', 'keywords', 'negativeKeywords', 'headlines', 'descriptions', 'paths'].every(key => Array.isArray(c[key]) && c[key].length <= 50 && c[key].every(value => typeof value === 'string' && value.length <= 300));
}
async function report(state, journal, result) {
  await api(state, `jobs/${journal.job.id}/result`, { clientId: state.binding.clientId, leaseId: journal.job.leaseId, status: result.status, message: result.message.slice(0, 1000), steps: result.steps.slice(-40) });
  const latest = await read();
  if (latest.journal?.job.id === journal.job.id) await write({ ...latest, journal: null, checkpoint: result.status === 'needs_attention' && latest.binding ? checkpoint(journal) : null, message: result.message });
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
    // An acknowledged result may be retried, but a running job is NEVER executed again after a worker restart.
    if (state.journal) {
      const result = state.journal.result ?? { status: 'needs_attention', message: 'انقطع التنفيذ. راجع الحقول في Google Ads قبل بدء مهمة جديدة؛ لم تُعد الإضافة الخطوات تلقائياً.', steps: state.journal.steps ?? [] };
      if (server.latestJob?.id === state.journal.job.id && server.latestJob.status === 'running') await report(state, state.journal, result);
      else {
        const current = await read();
        if (stopped || tickGeneration !== generation || current.binding?.clientId !== state.binding.clientId) return;
        await write({ ...current, journal: null, checkpoint: current.binding ? checkpoint(state.journal) : null, message: result.message });
      }
      return;
    }
    const claimed = await api(state, 'jobs/claim', { clientId: state.binding.clientId });
    if (!claimed?.job) return;
    if (!validJob(claimed.job, state.binding)) throw new Error('رفضت الإضافة مهمة لا تطابق التبويب أو الحساب المرتبط.');
    const afterClaim = await read();
    if (stopped || tickGeneration !== generation || afterClaim.binding?.clientId !== state.binding.clientId || afterClaim.app?.tabId !== state.app.tabId || afterClaim.app?.origin !== state.app.origin) {
      await api(state, `jobs/${claimed.job.id}/result`, { clientId: state.binding.clientId, leaseId: claimed.job.leaseId, status: 'stopped', message: 'تغيّر الربط أو أُوقفت المهمة قبل أي تعديل في الصفحة.', steps: [] }).catch(() => {});
      return;
    }
    const prior = state.checkpoint?.jobId === claimed.job.id && state.checkpoint.leaseId !== claimed.job.leaseId ? state.checkpoint : null;
    const journal = { job: claimed.job, steps: prior?.steps ?? [], result: null, progress: prior?.progress ?? { done: [], snapshots: {} } };
    state = { ...state, journal, message: 'تُملأ حقول الحملة في تبويب Google Ads المختار…' };
    await write(state); // Write-ahead journal before ANY page mutation.
    let progress = journal.progress, result;
    for (let count = 0; count < 30; count++) {
      const current = await read();
      if (stopped || !current.binding || current.binding.clientId !== state.binding.clientId) { result = { status: 'stopped', message: 'أُوقف التنفيذ. راجع الحقول التي مُلئت قبل الإيقاف.', steps: journal.steps }; break; }
      const live = await api(state, 'heartbeat', state.binding);
      if (live.latestJob?.id !== claimed.job.id || live.latestJob.status !== 'running') { result = { status: 'stopped', message: 'أُوقفت المهمة من موحسن. لم تتابع الإضافة إلى الخطوة التالية.', steps: journal.steps }; break; }
      const step = await adapter(state.binding.tabId, 'step', { campaign: claimed.job.campaign, progress, jobId: claimed.job.id, leaseId: claimed.job.leaseId });
      journal.steps.push({ stage: step.stage ?? 'unknown', message: step.message, fields: step.fields ?? [] });
      progress = step.progress ?? progress;
      journal.progress = progress;
      if (step.status !== 'continue') { result = { status: step.status, message: step.message, steps: journal.steps }; break; }
      const afterStep = await read();
      if (!afterStep.binding || stopped) { result = { status: 'stopped', message: 'أُوقف التنفيذ وفُصلت الإضافة.', steps: journal.steps }; break; }
      await write({ ...afterStep, journal, message: step.message });
      await new Promise(resolve => setTimeout(resolve, 900));
    }
    result ??= { status: 'needs_attention', message: 'وصلت المهمة إلى حد الخطوات. راجع صفحة Google Ads قبل المتابعة.', steps: journal.steps };
    journal.result = result;
    const finishing = await read();
    if (!finishing.binding || stopped) { await write({ ...finishing, journal: null, checkpoint: null, message: result.message }); return; }
    await write({ ...finishing, journal, message: result.message });
    const live = await api(state, 'status');
    if (live.latestJob?.id === claimed.job.id && live.latestJob.status === 'running') await report(state, journal, result);
    else { const current = await read(); await write({ ...current, journal: null, checkpoint: current.binding ? checkpoint(journal) : null, message: result.message }); }
  } catch (error) {
    if (tickGeneration !== generation) return;
    const state = await read();
    const message = error instanceof Error ? error.message : 'توقف اتصال الإضافة.';
    if (error?.code === 'CHROME_CONNECTION_REVOKED') {
      stopped = true;
      await write({ ...state, binding: null, journal: null, message: 'فُصلت الإضافة من موحسن. أعد الربط من تبويب Google Ads للمتابعة.' });
      await chrome.alarms.clear('mohassan-bridge'); return;
    }
    // Keep an uncertain journal until it can be reconciled with the server; never requeue.
    await write({ ...state, message, ...(state.journal ? { journal: { ...state.journal, result: { status: 'needs_attention', message, steps: state.journal.steps ?? [] } } } : {}) });
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
    await adapter(message.tabId, 'resetStop', {});
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
    if (ticking || state.journal || !state.binding || !state.checkpoint) throw new Error('لا توجد خطوة متوقفة يمكن متابعتها الآن.');
    const status = await api(state, 'status');
    if (status.latestJob?.id !== state.checkpoint.jobId || status.latestJob.status !== 'needs_attention') throw new Error('المهمة لم تعد تنتظر المراجعة.');
    await api(state, `jobs/${state.checkpoint.jobId}/resume`, { clientId: state.binding.clientId });
    await adapter(state.binding.tabId, 'resetStop', {});
    if (configurationGeneration !== generation) throw new Error('أُوقفت المتابعة قبل اكتمالها.');
    stopped = false;
    await write({ ...state, message: 'استؤنفت المهمة من الصفحة الحالية بعد مراجعتك.' });
    void tick(); return true;
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
    read().then(async state => {
      if (stopped || sender.frameId !== 0 || sender.tab?.id !== state.binding?.tabId || sender.origin !== 'https://ads.google.com' || state.journal?.job.id !== message.jobId || state.journal?.job.leaseId !== message.leaseId) return { allowed: false };
      const status = await api(state, 'status');
      const allowed = status.connected && status.latestJob?.id === message.jobId && status.latestJob.status === 'running' && status.latestJob.leaseId === message.leaseId;
      const current = await read();
      if (!allowed || stopped || !current.binding || current.journal?.job.leaseId !== message.leaseId) return { allowed: false };
      if (message.progress && Array.isArray(message.progress.done) && message.progress.done.length <= 40 && JSON.stringify(message.progress).length < 20000) {
        await write({ ...current, journal: { ...current.journal, progress: message.progress } });
      }
      return { allowed: true };
    }).then(reply, () => reply({ allowed: false }));
    return true;
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

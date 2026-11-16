const el = id => document.getElementById(id);
const call = message => chrome.runtime.sendMessage(message).then(result => { if (!result?.ok) throw new Error(result?.error ?? 'تعذر الاتصال بالإضافة.'); return result.data; });
const show = text => { el('status').textContent = text; };
async function refresh() {
  const state = await call({ kind: 'popup-status' });
  el('origin').textContent = state.app?.origin ?? 'لم يُربط تبويب موحسن بعد.';
  if (state.binding) { el('customer').value = state.binding.customerId; el('currency').value = state.binding.currency; }
  el('resume').hidden = !state.binding || !state.checkpoint;
  el('resume-note').hidden = el('resume').hidden;
  show(state.message ?? (state.binding ? 'الإضافة متصلة وتنتظر الحملة.' : 'اربط موحسن ثم تبويب Google Ads.'));
}
async function action(button, fn) { button.disabled = true; try { await fn(); await refresh(); } catch (error) { show(error.message); } finally { button.disabled = false; } }
el('pair-app').addEventListener('click', () => action(el('pair-app'), async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab?.url ?? '');
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname === 'ads.google.com' || url.hostname.endsWith('.google.com')) throw new Error('افتح تبويب موحسن أولاً.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('يجب أن يعمل موحسن عبر HTTPS أو على جهازك المحلي.');
  // The permission prompt is scoped to this exact host; the worker additionally pins the origin/port.
  if (!await chrome.permissions.request({ origins: [`${url.origin}/*`] })) throw new Error('لم يُمنح إذن الاتصال بتبويب موحسن.');
  await call({ kind: 'pair-app', tabId: tab.id, origin: url.origin });
}));
el('pair-ads').addEventListener('click', () => action(el('pair-ads'), async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await call({ kind: 'pair-ads', tabId: tab?.id, customerId: el('customer').value.replace(/[-\s]/g, ''), currency: el('currency').value });
}));
el('stop').addEventListener('click', () => action(el('stop'), () => call({ kind: 'stop' })));
el('resume').addEventListener('click', () => action(el('resume'), () => call({ kind: 'resume' })));
refresh().catch(error => show(error.message));

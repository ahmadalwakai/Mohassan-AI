(() => {
  if (globalThis.__mohassanAdsAdapter) return;
  let cancelled = false, activeCustomerId = null, activeJobId = null, activeLeaseId = null, activeProgress = null, running = false;
  const tidy = value => String(value ?? '').normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
  const visible = node => node instanceof HTMLElement && !node.hidden && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const labelText = item => { const copy = item.cloneNode(true); copy.querySelectorAll('input,select,textarea,button').forEach(child => child.remove()); return copy.textContent; };
  const label = node => tidy(node.getAttribute('aria-label') || (node.getAttribute('aria-labelledby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ') || [...(node.labels ?? [])].map(labelText).join(' ') || node.getAttribute('placeholder') || node.textContent);
  const text = root => tidy(root.innerText ?? root.textContent);
  const fail = message => { throw new Error(message); };
  function route() {
    const u = new URL(location.href);
    if (u.origin !== 'https://ads.google.com' || !/^\/aw\/campaigns\/new(?:\/|$)/.test(u.pathname)) fail('هذه ليست صفحة إنشاء حملة جديدة. افتح حملة جديدة في الحساب المختار.');
    if (/billing|payment|signin|login|account-access/i.test(u.pathname)) fail('وصلت إلى صفحة دخول أو فوترة. أكملها بنفسك.');
  }
  function account(customerId) {
    const named = all('[data-customer-id], .customer-id, customer-info, [aria-label*="Customer ID"], [aria-label*="Customer ID" i], [aria-label*="رقم العميل"], [aria-label*="رقم الحساب"]');
    const roots = named.length ? named : all('header, [role="banner"]');
    const ids = new Set(roots.flatMap(node => [...`${node.getAttribute('data-customer-id') ?? ''} ${label(node)} ${text(node)}`.matchAll(/(?<!\d)(\d{3})[-\s]?(\d{3})[-\s]?(\d{4})(?!\d)/g)].map(match => match[1] + match[2] + match[3])));
    if (ids.size !== 1 || !ids.has(customerId)) fail('لم أتحقق من رقم الحساب الظاهر أو ظهرت عدة حسابات. اختر الحساب المطلوب وافتح معالج حملته الجديدة.');
  }
  const root = () => all('main, [role="main"]').find(node => all('input, textarea, button, [role="button"], [role="heading"]', node).length) ?? document.body;
  const headings = () => all('h1,h2,[role="heading"]', root()).map(label);
  const matches = (value, names) => names.some(name => typeof name === 'string' ? tidy(value).toLowerCase() === tidy(name).toLowerCase() : name.test(tidy(value)));
  const sensitive = /publish|launch|activate|enable campaign|pay(?:ment)?|billing|delete|remove campaign|نشر|إطلاق|تفعيل|دفع|فوترة|حذف/i;
  const fields = () => all('input:not([type="hidden"]):not([type="password"]):not([type="file"]),textarea,select', root()).filter(node => !node.disabled && !node.readOnly);
  function find(names) {
    const found = fields().filter(node => matches(label(node), names));
    if (found.length !== 1) fail(`لم أجد حقلاً واحداً مؤكداً: ${String(names[0])}. لم أخمّن موضعه.`);
    return found[0];
  }
  const wait = async () => { await new Promise(resolve => setTimeout(resolve, 120)); if (cancelled) fail('أُوقف التنفيذ من الإضافة.'); };
  async function guard() {
    if (cancelled) fail('أُوقف التنفيذ من الإضافة.');
    route(); account(activeCustomerId);
    if (activeJobId && globalThis.chrome?.runtime?.id) {
      const response = await chrome.runtime.sendMessage({ kind: 'adapter-check', jobId: activeJobId, leaseId: activeLeaseId, progress: activeProgress });
      if (!response?.allowed) fail('أوقف موحسن هذه المهمة أو انقطع الاتصال. لم تُنفذ الخطوة التالية.');
    }
  }
  async function set(names, value, progress, key) {
    await guard();
    const node = find(names), before = node.value;
    if (node.type === 'password' || /password|card|credit|security code|كلمة المرور|بطاقة/i.test(label(node))) fail('حقل حساس يتطلب إدخالك اليدوي.');
    const previous = progress.snapshots[key];
    if (previous !== undefined && before !== previous) fail('تغيّرت قيمة حقل بعد تعبئته. راجع تعديلك قبل المتابعة.');
    if (before && before !== value && previous === undefined) fail(`الحقل «${label(node)}» يحتوي قيمة مختلفة. لم أستبدل إدخالك.`);
    if (before !== value) {
      const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); node.blur();
      await wait();
    }
    if (!node.isConnected || node.value !== value) fail(`لم تُثبت الصفحة قيمة «${label(node)}». توقف التنفيذ.`);
    progress.snapshots[key] = value;
  }
  async function choose(names) {
    await guard();
    const found = all('button,[role="button"],[role="radio"],input[type="radio"],label', root()).filter(node => matches(label(node), names));
    const unique = found.filter(node => !found.some(other => other !== node && node.contains(other)));
    if (unique.length !== 1 || sensitive.test(label(unique[0]))) fail('خيار الصفحة غير واضح. اختره بنفسك ثم ابدأ مهمة جديدة.');
    const node = unique[0];
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') fail('الخيار المطلوب غير متاح الآن.');
    node.click(); await wait();
    const control = node instanceof HTMLLabelElement ? node.control : node;
    const aria = ['aria-checked', 'aria-selected', 'aria-pressed'].map(key => node.getAttribute(key)).filter(value => value !== null);
    const selected = control?.checked === true || aria.includes('true') || (!aria.length && [...node.classList].some(token => token === 'selected' || token === 'checked'));
    if (!selected) fail('لم أتمكن من تأكيد الخيار بعد النقر. راجع الاختيار في الصفحة.');
  }
  async function next() {
    await guard();
    const buttons = all('button,[role="button"]', root()).filter(node => matches(label(node), ['Next', 'Continue', 'Save and continue', 'التالي', 'متابعة', 'حفظ ومتابعة']));
    if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true' || sensitive.test(label(buttons[0]))) fail('لم أجد زر متابعة واحداً آمناً لهذه الخطوة.');
    buttons[0].click(); await wait();
  }
  const stages = [
    ['review', ['Review', 'Review your campaign', 'Campaign review', 'مراجعة', 'مراجعة الحملة']],
    ['goal', ['Choose your objective', "What's your campaign objective?", 'Select a campaign objective', 'اختر هدفك', 'ما هدف حملتك؟']],
    ['type', ['Select a campaign type', 'Choose a campaign type', 'اختيار نوع الحملة', 'اختر نوع الحملة']],
    ['name', ['Campaign name', 'اسم الحملة']],
    ['settings', ['Campaign settings', 'إعدادات الحملة']],
    ['locations', ['Locations', 'Location targeting', 'المواقع الجغرافية', 'المواقع']],
    ['language', ['Languages', 'اللغات']],
    ['budget', ['Budget', 'Set your budget', 'الميزانية', 'ضبط الميزانية']],
    ['keywords', ['Keywords', 'Enter keywords', 'الكلمات الرئيسية', 'الكلمات المفتاحية']],
    ['ads', ['Ads', 'Create ads', 'Create your ads', 'الإعلانات', 'إنشاء الإعلانات']],
  ];
  function stage() {
    const titles = headings();
    if (titles.some(title => /billing|payment|sign in|conversion goals|bidding|معلومات الدفع|الفوترة|تسجيل الدخول|أهداف الإحالات|عروض الأسعار/i.test(title))) fail('هذه الخطوة تحتاج اختيارك: تسجيل الدخول أو الفوترة أو التحويلات أو استراتيجية عروض الأسعار.');
    const found = stages.filter(([, names]) => titles.some(title => matches(title, names)));
    // A combined keywords-and-ads screen is handled together; ambiguous sidebar headings never guessed.
    if (found.length === 2 && found.some(([key]) => key === 'keywords') && found.some(([key]) => key === 'ads')) return 'keywords_ads';
    if (found.length !== 1) fail('توقفت لأن واجهة هذه الخطوة غير معروفة. راجع الصفحة؛ لم تُنقر أزرار أخرى.');
    return found[0][0];
  }
  async function locationFields(c, progress) {
    const chipsNow = () => all('[data-location-name], [role="listitem"], .location-chip, .targeted-location', root()).map(text);
    const isLocation = (value, location) => {
      const parts = value.replace(/^(?:Remove|إزالة)\s+/i, '').split(/[,،\n]/).map(tidy);
      return parts[0]?.toLowerCase() === tidy(location).toLowerCase() && parts.slice(1).some(part => part === c.countryCode || part === countryName(c.countryCode));
    };
    const ensureNoExtras = () => { if (chipsNow().some(value => !c.locations.some(location => isLocation(value, location)))) fail('توجد مواقع مستهدفة إضافية أو غير مؤكدة. راجع القائمة قبل المتابعة.'); };
    ensureNoExtras();
    const searches = fields().filter(node => node instanceof HTMLInputElement && matches(label(node), ['Enter a location to target or exclude', 'Enter a location', 'Search locations', 'أدخل موقعاً جغرافياً لاستهدافه أو استبعاده', 'أدخل موقعًا جغرافيًا', 'البحث عن مواقع جغرافية']));
    if (searches.length === 1) {
      for (const location of c.locations) {
        if (chipsNow().some(value => isLocation(value, location))) continue;
        await set([label(searches[0])], `${location}, ${countryName(c.countryCode)}`, progress, 'locationSearch');
        await new Promise(resolve => setTimeout(resolve, 600));
        const candidates = all('[role="option"], material-select-item, .geo-search-result', root()).filter(node => isLocation(text(node), location));
        if (candidates.length !== 1) fail('نتائج الموقع الجغرافي غير حاسمة. اختر الموقع والبلد الصحيحين بنفسك.');
        const option = candidates[0], targets = all('button,[role="button"]', option).filter(node => matches(label(node), ['Target', 'Include', 'استهداف', 'تضمين']));
        if (targets.length > 1 || (!targets.length && option.getAttribute('role') !== 'option')) fail('لم أجد إجراء استهداف واحداً مؤكداً لهذا الموقع.');
        await guard(); (targets[0] ?? option).click(); await wait();
        if (!chipsNow().some(value => isLocation(value, location))) fail('لم يظهر الموقع ضمن المواقع المستهدفة بعد اختياره. توقف التنفيذ للتحقق.');
        ensureNoExtras();
        // Some Google variants clear the search after a choice; preserve that observed value for the next location.
        progress.snapshots.locationSearch = searches[0].value;
      }
      progress.done.push('locations'); return;
    }
    // Only a true bulk textarea is filled with multiple locations; a search box is never treated as a list.
    const bulk = fields().filter(node => node instanceof HTMLTextAreaElement && matches(label(node), ['Enter or paste locations', 'Locations to target', 'أدخل المواقع الجغرافية أو الصقها', 'المواقع الجغرافية المستهدفة']));
    if (bulk.length === 1) {
      await set([label(bulk[0])], c.locations.map(value => `${value}, ${c.countryCode}`).join('\n'), progress, 'locations');
      // A bulk input is only a search request, not confirmed targeting. Google must resolve it before advancing.
      fail('أُدخلت المواقع في البحث الجماعي. راجع نتائجها وأضف المواقع الصحيحة مع البلد داخل Google Ads قبل المتابعة.');
    }
    const chips = chipsNow();
    const confirmed = c.locations.every(location => chips.some(value => isLocation(value, location)));
    if (!confirmed) fail('اختر المواقع المستهدفة في Google Ads أولاً. لا يمكن تأكيد بلد نتائج البحث الجغرافي تلقائياً في هذه الواجهة.');
    progress.done.push('locations');
  }
  function countryName(code) { return ({ GB: 'United Kingdom', US: 'United States', AE: 'United Arab Emirates', SA: 'Saudi Arabia', EG: 'Egypt', CA: 'Canada', AU: 'Australia' })[code] ?? code; }
  async function keywordFields(c, progress) {
    await set(['Enter keywords', 'Keywords', 'أدخل الكلمات الرئيسية', 'الكلمات الرئيسية', 'الكلمات المفتاحية'], c.keywords.join('\n'), progress, 'keywords');
    if (c.negativeKeywords.length) {
      await set(['Negative keywords', 'الكلمات الرئيسية السلبية', 'الكلمات المفتاحية السلبية'], c.negativeKeywords.join('\n'), progress, 'negativeKeywords');
    }
    progress.done.push('keywords');
  }
  async function adFields(c, progress) {
    for (const node of fields()) {
      const item = /^(Headline|Description|Path|العنوان|الوصف|المسار)\s+(\d+)(?:\s*\(required\))?$/i.exec(label(node));
      if (!item || !node.value) continue;
      const key = /Headline|العنوان/i.test(item[1]) ? 'headlines' : /Description|الوصف/i.test(item[1]) ? 'descriptions' : 'paths';
      if (Number(item[2]) > c[key].length) fail('توجد نصوص إعلان أو مسارات إضافية في الصفحة لم تتضمنها الحملة. راجعها أولاً.');
    }
    await set(['Final URL', 'عنوان URL النهائي', 'الرابط النهائي'], c.finalUrl, progress, 'finalUrl');
    for (let index = 0; index < c.headlines.length; index++) await set([`Headline ${index + 1}`, `Headline ${index + 1} (required)`, `العنوان ${index + 1}`], c.headlines[index], progress, `headline${index}`);
    for (let index = 0; index < c.descriptions.length; index++) await set([`Description ${index + 1}`, `Description ${index + 1} (required)`, `الوصف ${index + 1}`], c.descriptions[index], progress, `description${index}`);
    for (let index = 0; index < c.paths.length; index++) await set([`Path ${index + 1}`, `المسار ${index + 1}`], c.paths[index], progress, `path${index}`);
    progress.done.push('ads');
  }
  function inspect(binding) { try { route(); account(binding.customerId); return { ok: true, message: 'تم التحقق من صفحة الحملة ورقم الحساب.' }; } catch (error) { return { ok: false, message: error.message }; } }
  async function step({ campaign: c, progress: original, jobId, leaseId }) {
    if (running) return { status: 'needs_attention', stage: 'busy', message: 'ما زالت خطوة سابقة قيد الانتهاء. راجع الصفحة ثم أعد المتابعة.', fields: [], progress: original };
    running = true;
    activeCustomerId = c.customerId; activeJobId = jobId ?? null; activeLeaseId = leaseId ?? null;
    const progress = { done: [...(original?.done ?? [])], snapshots: { ...(original?.snapshots ?? {}) } };
    activeProgress = progress;
    let current = 'unknown';
    try {
      if (cancelled) fail('أُوقف التنفيذ من الإضافة.');
      route(); account(c.customerId); current = stage();
      if (current === 'review') {
        const missing = ['goal', 'type', 'name', 'locations', 'language', 'budget', 'keywords', 'ads'].filter(key => !progress.done.includes(key));
        return { status: missing.length ? 'needs_attention' : 'awaiting_review', stage: current, message: missing.length ? 'وصلت إلى المراجعة، لكن لم تتحقق الإضافة من كل الإعدادات. راجع الحملة كاملة؛ لم يُنشر شيء.' : 'وصلت الحملة إلى المراجعة. راجعها وانشرها بنفسك؛ لم تنقر الإضافة النشر.', fields: [], progress };
      }
      if (progress.done.includes(current)) fail('لم تنتقل الصفحة بعد المتابعة أو عاد المعالج إلى خطوة مكتملة. توقف التنفيذ دون إعادة النقر.');
      if (current === 'goal') await choose(['Leads', 'العملاء المحتملون']);
      else if (current === 'type') await choose(['Search', 'بحث', 'شبكة البحث']);
      else if (current === 'name') await set(['Campaign name', 'اسم الحملة'], c.campaignName, progress, 'campaignName');
      else if (current === 'locations') await locationFields(c, progress);
      else if (current === 'language') {
        const expected = ({ en: 'English', ar: 'Arabic' })[c.adLanguage];
        if (!expected) fail('لغة الإعلان هذه تحتاج اختياراً يدوياً.');
        const selected = all('select', root()).find(node => matches(label(node), ['Languages', 'Language', 'اللغات', 'اللغة']));
        if (!selected) fail('اختر لغة الإعلان في Google Ads؛ لم أتعرف على أداة الاختيار.');
        const option = [...selected.options].find(item => matches(item.textContent, [expected, c.adLanguage, c.adLanguage === 'ar' ? 'العربية' : 'الإنجليزية']));
        if (!option) fail('لم أجد لغة الإعلان المطلوبة.');
        if (selected.value && selected.value !== option.value) fail('لغة الحساب المحددة تختلف عن لغة الإعلان. راجعها بنفسك.');
        await set([label(selected)], option.value, progress, 'language');
      } else if (current === 'budget') {
        if (!new RegExp(`\\b${c.currency}\\b`).test(text(root()))) fail('لم أتحقق من عملة الميزانية الظاهرة. راجع عملة الحساب قبل المتابعة.');
        await set(['Average daily budget', 'Daily budget', 'Your average daily budget', 'متوسط الميزانية اليومية', 'الميزانية اليومية'], c.dailyBudget, progress, 'dailyBudget');
      } else if (current === 'keywords') await keywordFields(c, progress);
      else if (current === 'ads') await adFields(c, progress);
      else if (current === 'keywords_ads') { await keywordFields(c, progress); await adFields(c, progress); }
      else fail('إعدادات الحملة تجمع اختيارات لم يُتحقق منها. أكمل المواقع واللغات والشبكات بنفسك قبل المتابعة.');
      // Recheck account and route after the page's own input handlers, before navigating.
      route(); account(c.customerId);
      await next();
      progress.done = [...new Set([...progress.done, current])];
      return { status: 'continue', stage: current, message: `تم التحقق من حقول خطوة ${current} والانتقال للخطوة التالية.`, fields: Object.keys(progress.snapshots), progress };
    } catch (error) { return { status: cancelled ? 'stopped' : 'needs_attention', stage: current, message: error.message ?? 'توقف التنفيذ لمراجعة الصفحة.', fields: Object.keys(progress.snapshots), progress }; }
    finally { running = false; activeProgress = null; }
  }
  globalThis.__mohassanAdsAdapter = { inspect, step, stop: () => { cancelled = true; }, resetStop: () => { cancelled = false; return { ok: true }; } };
})();

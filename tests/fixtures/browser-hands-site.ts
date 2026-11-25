import { createServer } from 'node:http';

/**
 * Local browser mechanics fixtures. Cases are assembled from HTML controls and
 * fixed numeric inputs by the test code. No model, API, or training dataset is used.
 */
export const locales = ['en', 'ar'] as const;
export type FixtureLocale = typeof locales[number];
export type FixtureControl = 'input' | 'textarea' | 'rich' | 'select' | 'date' | 'checkbox' | 'radio';
export type FixtureWall = 'login' | 'code' | 'bot' | 'payment' | 'identity' | '401' | '403';
export type FixtureTarget = 'role' | 'label' | 'placeholder' | 'context' | 'position' | 'frame' | 'shadow';
export type FixtureConsent = 'reject' | 'necessary' | 'both' | 'accept-only' | 'absent';
export type FixtureJourney = 'wizard' | 'popup' | 'next' | 'more' | 'late';

export const words = {
  en: {
    region: 'Region', count: 'Count', first: 'North', second: 'South', draft: 'Draft value', list: ['First item', 'Second item'],
    label: 'Fixture entry', search: 'Search inventory', option: 'Second choice', heading: 'Reference material',
    context: 'Current project', decoy: 'Archived project', action: 'Show details', ready: 'Ready for review',
    next: 'Next step', review: 'Review details', finish: 'Finish preview', popup: 'Open tab', more: 'Load more',
    pageNext: 'Next page', reject: 'Reject all', necessary: 'Necessary only', accept: 'Accept all', consent: 'Cookie preferences',
    login: 'Sign in to continue', code: 'Enter the verification code', bot: 'Verify you are human', payment: 'Confirm payment',
  },
  ar: {
    region: 'المنطقة', count: 'العدد', first: 'الشمال', second: 'الجنوب', draft: 'مسودة', list: ['العنصر الأول', 'العنصر الثاني'],
    label: 'حقل التجربة', search: 'ابحث في المخزون', option: 'الخيار الثاني', heading: 'المادة المرجعية',
    context: 'المشروع الحالي', decoy: 'المشروع المؤرشف', action: 'عرض التفاصيل', ready: 'جاهز للمراجعة',
    next: 'الخطوة التالية', review: 'مراجعة التفاصيل', finish: 'إنهاء المعاينة', popup: 'فتح تبويب', more: 'تحميل المزيد',
    pageNext: 'الصفحة التالية', reject: 'رفض الكل', necessary: 'الضرورية فقط', accept: 'قبول الكل', consent: 'تفضيلات ملفات تعريف الارتباط',
    login: 'سجل الدخول للمتابعة', code: 'أدخل رمز التحقق', bot: 'تحقق من أنك إنسان', payment: 'تأكيد الدفع',
  },
} as const;

export const ownerButton = { x: 150 / 1280, y: 128 / 800 };

function document(locale: FixtureLocale, content: string, script = '') {
  return `<!doctype html><html dir="${locale === 'ar' ? 'rtl' : 'ltr'}" lang="${locale}">
<title>Browser fixture</title><meta charset="utf-8"><body>${content}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function reading(locale: FixtureLocale) {
  const t = words[locale];
  return document(locale, `<header>Site header</header><main><h1>${t.heading}</h1><p>fixture-main-27</p>
<table><caption>Fixture rows</caption><thead><tr><th>${t.region}</th><th>${t.count}</th></tr></thead>
<tbody><tr><td>${t.first}</td><td>17</td></tr><tr><td>${t.second}</td><td>29</td></tr></tbody></table>
<ol><li>${t.list[0]}</li><li>${t.list[1]}</li></ol>
<form aria-label="${t.heading}"><label>${t.label}<input name="note" value="${t.draft}"></label></form></main>
<footer>Site footer</footer>`);
}

function control(locale: FixtureLocale, kind: FixtureControl) {
  const { label, option } = words[locale];
  const input = {
    input: '<input id="field" type="text">',
    textarea: '<textarea id="field"></textarea>',
    rich: '<div id="field" role="textbox" contenteditable="true" aria-label="' + label + '"></div>',
    select: '<select id="field"><option value="one">First choice</option><option value="two">' + option + '</option></select>',
    date: '<input id="field" type="date">',
    checkbox: '<input id="field" type="checkbox" value="selected">',
    radio: '<input id="field" type="radio" name="selection" value="selected">',
  }[kind];
  return document(locale, `<main><h1>Fixture controls</h1><form><label for="field">${label}</label>${input}
<label for="untouched">Unrelated field</label><input id="untouched" value="unchanged" type="${kind === 'radio' ? 'radio' : 'text'}" ${kind === 'radio' ? 'name="selection"' : ''}>
</form></main>`);
}

function targetControl(locale: FixtureLocale, kind: FixtureTarget) {
  const t = words[locale];
  const button = (key: 'right' | 'wrong') => `<button onclick="document.title='${key}';this.textContent='${key}'">${t.action}</button>`;
  const controls = {
    role: `<a href="../../landing/${locale}/0">${t.action}</a>${button('right')}`,
    label: `<label for="target">${t.action}</label><input id="target"><input aria-label="Unrelated input">`,
    placeholder: `<input id="target" placeholder="${t.search}"><input placeholder="Unrelated input">`,
    context: `<section><h2>${t.decoy}</h2>${button('wrong')}</section><section><h2>${t.context}</h2>${button('right')}</section>`,
    position: `<section>${button('wrong')}${button('right')}</section>`,
    frame: '<iframe title="Fixture frame" src="frame-body"></iframe>',
    shadow: '<div id="shadow-root"></div>',
  };
  return document(locale, `<main><h1>Fixture targets</h1>${controls[kind]}</main>`,
    kind === 'shadow' ? `document.querySelector('#shadow-root').attachShadow({mode:'open'}).innerHTML = ${JSON.stringify(button('right'))}` : '');
}

function cookie(locale: FixtureLocale, variant: FixtureConsent) {
  const t = words[locale];
  const dialog = variant === 'absent' ? '' : `<dialog open aria-label="${t.consent}"><p>${t.consent}</p>
<button data-choice="accept">${t.accept}</button>
${variant === 'necessary' || variant === 'both' ? `<button data-choice="necessary">${t.necessary}</button>` : ''}
${variant === 'reject' || variant === 'both' ? `<button data-choice="reject">${t.reject}</button>` : ''}</dialog>`;
  return document(locale, `<main><h1>fixture-main-27</h1>${dialog}</main>`, `
document.querySelector('dialog')?.addEventListener('click', event => {
  const choice = event.target.dataset.choice;
  if (!choice) return;
  document.title = choice;
  document.querySelector('dialog').remove();
});`);
}

function wall(locale: FixtureLocale, kind: FixtureWall) {
  const t = words[locale];
  const header = kind === '401' || kind === '403' ? t.login : kind === 'identity' ? 'Fixture form' : t[kind];
  const input = {
    login: '<input aria-label="Password" id="guard" autocomplete="current-password" type="password">',
    code: '<input aria-label="One-time code" id="guard" autocomplete="one-time-code" inputmode="numeric">',
    bot: '<p role="alert">CAPTCHA</p>',
    payment: '<input aria-label="Card number" id="guard" autocomplete="cc-number" inputmode="numeric">',
    identity: '<input aria-label="National ID number" id="guard" inputmode="numeric">',
    401: '',
    403: '',
  }[kind];
  return document(locale, `<main id="wall"><h1>${header}</h1>${input}
<button id="resolve" style="position:fixed;left:80px;top:100px;width:140px;height:56px">Fixture owner control</button></main>`, `
document.body.dataset.inputEvents = '0';
document.querySelector('#guard')?.addEventListener('input', () => { document.body.dataset.inputEvents = '1'; });
document.querySelector('#resolve').addEventListener('click', () => {
  ${kind === '401' || kind === '403'
    ? `location.assign('../../landing/${locale}/0');`
    : `document.querySelector('#wall').innerHTML = '<h1>${t.ready}</h1><p>fixture-main-27</p>';`}
});`);
}

function journey(locale: FixtureLocale, kind: FixtureJourney, page: number) {
  const t = words[locale];
  const landing = '<h1>' + t.ready + '</h1><p>fixture-main-27</p>';
  if (kind === 'wizard') return document(locale, `<main><h1>Fixture wizard</h1><button id="advance">${t.next}</button></main>`, `
const advance = document.querySelector('#advance');
const labels = ${JSON.stringify([t.review, t.finish])};
advance.addEventListener('click', () => {
  if (labels.length) advance.textContent = labels.shift();
  else document.querySelector('main').innerHTML = ${JSON.stringify(landing)};
});`);
  if (kind === 'popup') return document(locale, `<main><a target="_blank" href="../../landing/${locale}/0">${t.popup}</a></main>`);
  if (kind === 'late') return document(locale, '<main><h1>Fixture delayed control</h1></main>', `setTimeout(() => {
    document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(`<button onclick="document.title='right'">${t.action}</button>`)});
  }, 650);`);
  if (kind === 'next') return document(locale, `<main><h1>Fixture pagination</h1><ol><li>fixture-row-${page}</li></ol>
${page < 3 ? `<a href="?page=${page + 1}" rel="next">${t.pageNext}</a>` : ''}</main>`);
  return document(locale, `<main><h1>Fixture pagination</h1><ol><li>fixture-row-1</li></ol><button id="more">${t.more}</button></main>`, `
let number = 1;
document.querySelector('#more').addEventListener('click', event => {
  document.querySelector('ol').insertAdjacentHTML('beforeend', '<li>fixture-row-' + (++number) + '</li>');
  if (number === 3) event.target.remove();
});`);
}

export async function startBrowserHandsFixture() {
  let approvedActions = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const [, group, lang, variant] = url.pathname.split('/');
    const locale = lang === 'ar' ? 'ar' : 'en';
    let html: string;
    let status = 200;
    switch (group) {
      case 'approval':
        if (request.method === 'POST') {
          approvedActions++;
          html = document(locale, '<main><h1>fixture-record-removed</h1></main>');
        } else {
          const label = locale === 'ar' ? 'حذف السجل' : 'Delete record';
          html = document(locale, `<main><form method="post"><button type="submit">${label}</button></form></main>`);
        }
        break;
      case 'read': html = reading(locale); break;
      case 'control': html = control(locale, variant as FixtureControl); break;
      case 'target': html = variant === 'frame-body'
        ? targetControl(locale, 'role') : targetControl(locale, variant as FixtureTarget); break;
      case 'cookie': html = cookie(locale, variant as FixtureConsent); break;
      case 'wall':
        html = wall(locale, variant as FixtureWall);
        if (variant === '401' || variant === '403') status = Number(variant);
        break;
      case 'journey':
        html = journey(locale, variant as FixtureJourney, Number(url.searchParams.get('page') ?? '1'));
        break;
      case 'landing': html = document(locale, `<main><h1>${words[locale].ready}</h1><p>fixture-main-27</p></main>`); break;
      default: html = document(locale, '<main><h1>fixture-main-27</h1></main>');
    }
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind to TCP');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    approvedActions: () => approvedActions,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

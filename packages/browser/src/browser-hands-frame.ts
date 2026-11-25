import { BROWSER_HANDS_SENSITIVE_FIELD_SCRIPT } from './browser-hands-human.js';

/** Fixed Playwright code. User text is passed to native actions separately. */
export const BROWSER_HANDS_FRAME_SCRIPT = String.raw`
  const sensitiveBrowserField = ${BROWSER_HANDS_SENSITIVE_FIELD_SCRIPT};
  const browserHandsClean = (value, max = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const browserHandsTag = (node) => node.tagName.toLowerCase();
  const browserHandsType = (node) => browserHandsTag(node) === 'input' ? String(node.type).toLowerCase() : '';
  const browserHandsRole = (node) => (node.getAttribute('role') ?? '').toLowerCase().split(/\s+/)[0];
  const browserHandsControl = (node) => {
    const tag = browserHandsTag(node), type = browserHandsType(node), role = browserHandsRole(node);
    if (tag === 'select') return 'select';
    if (node.isContentEditable || node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false') return 'editable';
    if (['checkbox','radio','file'].includes(type)) return type;
    if (['date','datetime-local','month','time','week'].includes(type)) return 'date';
    if (tag === 'textarea' || tag === 'input' && !['button','image','reset','submit','hidden','color','range'].includes(type)) return 'text';
    if (['a','button','summary'].includes(tag) || ['button','image','reset','submit'].includes(type) || ['button','link','menuitem','option','tab'].includes(role)) return 'action';
    return 'other';
  };
  const browserHandsSemanticRole = (node, control) => {
    const explicit = browserHandsRole(node);
    if (explicit) return explicit;
    if (control === 'select') return node.multiple || node.size > 1 ? 'listbox' : 'combobox';
    if (browserHandsType(node) === 'search') return 'searchbox';
    if (browserHandsType(node) === 'number') return 'spinbutton';
    if (['text','editable'].includes(control)) return 'textbox';
    if (control === 'action') return browserHandsTag(node) === 'a' ? 'link' : 'button';
    return control;
  };
  const browserHandsShown = (node) => {
    for (let current = node; current; current = current.getRootNode().host) {
      if (current.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    }
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) !== 0;
  };
  const browserHandsLabelText = (node) => {
    if (!node || node.matches('input,textarea,select,[contenteditable],script,style')) return '';
    const reader = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: child => child.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT
        : child.matches('input,textarea,select,[contenteditable],script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP,
    });
    const pieces = [];
    for (let child = reader.nextNode(); child && pieces.length < 36; child = reader.nextNode()) pieces.push((child.nodeValue ?? '').slice(0, 180));
    return browserHandsClean(pieces.join(' '));
  };
  const browserHandsReferenced = (node, attribute) => {
    const root = node.getRootNode();
    return (node.getAttribute(attribute) ?? '').split(/\s+/).slice(0, 6).map(id => browserHandsLabelText(root.getElementById?.(id))).join(' ');
  };
  const browserHandsLabel = (node) => browserHandsClean(Array.from(node.labels ?? []).slice(0, 6).map(browserHandsLabelText).join(' '));
  const browserHandsInputDetails = (node) => ({
    type: browserHandsType(node), name: node.getAttribute('name') ?? '', id: node.id,
    autocomplete: node.getAttribute('autocomplete') ?? '', placeholder: node.getAttribute('placeholder') ?? '',
    label: [node.getAttribute('aria-label'), browserHandsReferenced(node, 'aria-labelledby'), browserHandsLabel(node), node.getAttribute('title')].filter(Boolean).join(' '),
  });
  const browserHandsHumanOnly = (node) => {
    if (!['text','date','select','editable'].includes(browserHandsControl(node))) return null;
    const details = browserHandsInputDetails(node);
    const kind = sensitiveBrowserField(details);
    if (kind) return kind;
    const group = node.closest('fieldset,[role="group"]') ?? node.parentElement;
    if (node.maxLength === 1 && group && Array.from(group.querySelectorAll('input[maxlength="1"]')).slice(0, 16).filter(browserHandsShown).length >= 4) return 'code';
    return null;
  };
  const browserHandsContentText = (start, limit = 24000) => {
    const text = [], seen = new Set();
    let nodes = 0, size = 0;
    const push = value => {
      const bounded = value.slice(0, Math.max(0, limit - size));
      if (bounded) { text.push(bounded); size += bounded.length; }
    };
    const walk = node => {
      if (++nodes > 7000 || size >= limit || seen.has(node)) return;
      seen.add(node);
      if (node.nodeType === Node.TEXT_NODE) { push(node.nodeValue ?? ''); return; }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches('script,style,template,noscript,svg,canvas,[hidden],[inert],[aria-hidden="true"],input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
        const style = getComputedStyle(node);
        if (style.display === 'none' || ['hidden','collapse'].includes(style.visibility) || Number(style.opacity) === 0) return;
        if (node.matches('br,hr')) { push('\n'); return; }
        const block = node.matches('main,article,section,div,h1,h2,h3,h4,h5,h6,p,li,dt,dd,tr,pre,blockquote,header,footer,nav,aside,figure,figcaption');
        if (block) push('\n');
        if (node.matches('td,th')) push(' ');
        if (node.tagName === 'SLOT') {
          const assigned = node.assignedNodes({ flatten: true });
          for (const child of assigned.length ? assigned : node.childNodes) walk(child);
        } else for (const child of (node.shadowRoot ?? node).childNodes) walk(child);
        if (block) push('\n');
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    if (start) walk(start);
    return text.join('').replace(/[^\S\n]+/g, ' ').replace(/ *\n[\n ]*/g, '\n').trim().slice(0, limit);
  };
  const browserHandsName = (node, options = {}) => browserHandsClean(
    browserHandsReferenced(node, 'aria-labelledby') || node.getAttribute('aria-label') || browserHandsLabel(node) ||
    options.text || node.getAttribute('alt') || node.querySelector?.('img[alt]')?.getAttribute('alt') || node.getAttribute('title') ||
    node.getAttribute('placeholder') || node.getAttribute('name') || node.id
  );
  const browserHandsNearby = (node) => {
    const labels = [browserHandsReferenced(node, 'aria-describedby')];
    let scope = node.parentElement;
    for (let depth = 0; scope && depth < 3 && !scope.matches('body,html,main'); depth++, scope = scope.parentElement) {
      labels.push(scope.getAttribute('aria-label'), browserHandsReferenced(scope, 'aria-labelledby'));
      const heading = Array.from(scope.children).slice(0, 12).find(child => child.matches('legend,caption,h1,h2,h3,h4,h5,h6,summary,[role="heading"]'));
      if (heading) labels.push(browserHandsContentText(heading, 100));
      const previous = depth === 0 ? node.previousElementSibling : scope.previousElementSibling;
      if (previous?.matches('label,legend,p,span,strong,h1,h2,h3,h4,h5,h6,[role="heading"]')) labels.push(browserHandsContentText(previous, 100));
    }
    return browserHandsClean(labels.filter(Boolean).join(' '), 260);
  };
  const browserHandsCookie = (node) => {
    let scope = node.parentElement;
    for (let depth = 0; scope && depth < 5 && !scope.matches('body,html,main'); depth++, scope = scope.parentElement) {
      const attributes = [scope.id, scope.getAttribute('class'), scope.getAttribute('aria-label')].join(' ');
      const explicit = /cookie|consent|onetrust|didomi|cookiebot|ملفات[ -]تعريف[ -]الارتباط/i.test(attributes);
      const dialog = scope.matches('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
      if ((explicit || dialog) && /\bcookies?\b|ملفات\s+(?:تعريف\s+)?الارتباط/i.test(browserHandsContentText(scope, 1800))) return true;
    }
    return false;
  };
  const browserHandsPaginationKind = (node, name) => {
    if (/(?:^|\s)next(?:\s|$)/i.test(node.getAttribute('rel') ?? '')) return 'next';
    if (/^(?:load|show|view) more(?: (?:results|items))?$|^(?:تحميل|عرض) المزيد(?: من النتائج)?$|^المزيد$/i.test(name)) return 'more';
    const nav = node.closest('nav,[role="navigation"],[class*="pagination" i],[aria-label*="pagination" i]');
    if (!nav) return undefined;
    const paging = /paginat|pages|الصفحات|ترقيم/i.test([nav.id, nav.getAttribute('class'), nav.getAttribute('aria-label')].join(' '));
    if (/^(?:next page|الصفحة التالية)$/i.test(name) || paging && /^(?:next|[›»]|التالي|التالية)$/i.test(name)) return 'next';
    return undefined;
  };
  const browserHandsMetadata = (node, position) => {
    const control = browserHandsControl(node), label = browserHandsLabel(node), placeholder = browserHandsClean(node.getAttribute('placeholder'));
    const text = control === 'action' ? browserHandsClean(browserHandsType(node) ? node.value : browserHandsContentText(node, 180)) : '';
    const name = browserHandsName(node, { text }), humanOnly = browserHandsHumanOnly(node);
    const isText = ['text', 'editable', 'date'].includes(control);
    const identifier = isText && (['email','tel'].includes(browserHandsType(node)) || /username|\bemail\b|e-mail|identifier|\blogin\b|user.?id|phone|البريد|اسم.?المستخدم|الهاتف/i.test([node.name, node.id, node.autocomplete, name, placeholder].join(' ')));
    const field = humanOnly === 'login' ? 'password' : humanOnly === 'code' ? 'otp' : humanOnly === 'payment' ? 'card' : humanOnly === 'identity' || identifier ? 'identifier' : isText ? 'text' : undefined;
    const isAction = control === 'action';
    return { name, label, text, placeholder, nearby: browserHandsNearby(node), role: browserHandsSemanticRole(node, control), position, control, humanOnly, field, exposed: browserHandsShown(node),
      actionText: isAction ? text || name : undefined,
      consent: isAction && browserHandsCookie(node), pagination: isAction ? browserHandsPaginationKind(node, name) : undefined,
    };
  };
  const browserHandsChoiceValue = (node) => browserHandsTag(node) === 'select' && node.multiple
    ? Array.from(node.selectedOptions).map(option => option.value) : ['checkbox','radio'].includes(browserHandsType(node)) ? node.checked : node.value;
  const browserHandsReadValue = (node) => browserHandsControl(node) === 'editable' ? node.innerText.replace(/\r\n?/g, '\n') : browserHandsChoiceValue(node);
  const browserHandsValue = (node) => {
    const value = browserHandsReadValue(node);
    return Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
  };
  const browserHandsRadioGroup = (node) => {
    if (!node.name) return [node];
    const all = node.form ? Array.from(node.form.elements) : Array.from(node.getRootNode().querySelectorAll('input[type="radio"]'));
    return all.filter(peer => peer.type === 'radio' && peer.name === node.name && peer.form === node.form);
  };
  const browserHandsCanWriteChoice = (node, desired, written) => {
    const type = browserHandsType(node);
    if (type === 'radio' || type === 'checkbox') {
      if (String(node.checked) === desired) return true;
      const affected = type === 'radio' ? browserHandsRadioGroup(node) : [node];
      return affected.every(peer => peer.checked === peer.defaultChecked || written.get(peer) === String(peer.checked));
    }
    if (browserHandsTag(node) === 'select' && node.multiple) {
      // The native action includes all currently selected values. Never remove a prior selection.
      try { const selected = JSON.parse(desired); return Array.isArray(selected) && browserHandsChoiceValue(node).every(value => selected.includes(value)); }
      catch { return false; }
    }
    return undefined;
  };
  const browserHandsRecordWrite = (node, written) => {
    const affected = browserHandsType(node) === 'radio' ? browserHandsRadioGroup(node) : [node];
    for (const peer of affected) written.set(peer, browserHandsValue(peer));
  };
  const browserHandsReadField = (node) => {
    const meta = browserHandsMetadata(node);
    const value = meta.humanOnly || meta.control === 'file' ? null : browserHandsReadValue(node);
    return { label: meta.name, role: meta.role, value: typeof value === 'string' ? value.slice(0, 2000) : Array.isArray(value) ? value.slice(0, 40).map(item => item.slice(0, 200)) : value ?? null };
  };
  const browserHandsContent = (nodes) => {
    let available = 48000;
    const extract = (node, max) => {
      const text = browserHandsContentText(node, Math.min(max, available));
      available -= text.length;
      return browserHandsClean(text, max);
    };
    const main = nodes.find(node => node.matches('main,[role="main"]') && browserHandsShown(node)) ?? nodes.find(node => node.matches('article') && browserHandsShown(node)) ?? document.body;
    const tables = nodes.filter(node => node.matches('table,[role="table"],[role="grid"]') && browserHandsShown(node)).slice(0, 10).map(table => {
      const rows = Array.from(table.querySelectorAll('tr,[role="row"]')).filter(row => row.closest('table,[role="table"],[role="grid"]') === table && browserHandsShown(row)).slice(0, 80);
      return { caption: extract(table.querySelector('caption'), 180) || browserHandsName(table), rows: rows.map(row => Array.from(row.children).filter(cell => cell.matches('th,td,[role="cell"],[role="gridcell"],[role="rowheader"],[role="columnheader"]') && browserHandsShown(cell)).slice(0, 24).map(cell => extract(cell, 300))) };
    });
    const lists = nodes.filter(node => node.matches('ul,ol,[role="list"]') && !node.closest('nav,[role="navigation"]') && browserHandsShown(node)).slice(0, 16).map(list => ({
      ordered: list.tagName === 'OL', items: Array.from(list.children).filter(item => item.matches('li,[role="listitem"]') && browserHandsShown(item)).slice(0, 80).map(item => extract(item, 300)),
    }));
    const controls = nodes.filter(node => node.matches('input:not([type="hidden"]),textarea,select,[contenteditable]:not([contenteditable="false"])') && browserHandsShown(node) && !['action','other'].includes(browserHandsControl(node))).slice(0, 120);
    const forms = nodes.filter(node => node.matches('form,[role="form"]') && browserHandsShown(node)).slice(0, 16).map(form => ({
      label: browserHandsName(form, { text: browserHandsContentText(form.querySelector('legend,h1,h2,h3,h4,h5,h6'), 180) }),
      fields: controls.filter(node => (node.form ?? node.closest('form,[role="form"]')) === form).map(browserHandsReadField),
    }));
    const ungrouped = controls.filter(node => !(node.form ?? node.closest('form,[role="form"]')));
    if (ungrouped.length) forms.push({ label: '', fields: ungrouped.map(browserHandsReadField) });
    return { direction: main && getComputedStyle(main).direction === 'rtl' ? 'rtl' : 'ltr', main: browserHandsContentText(main), tables, lists, forms };
  };
`;

export const BROWSER_HANDS_READ_TARGET_SCRIPT = String.raw`(node) => {
  ${BROWSER_HANDS_FRAME_SCRIPT}
  const { control, humanOnly } = browserHandsMetadata(node);
  const connected = node.isConnected;
  if (humanOnly || !connected) return { control, connected, humanOnly, value: null, options: [] };
  const value = browserHandsReadValue(node);
  const options = control === 'select' ? Array.from(node.options).slice(0, 250).map(option => ({
    label: browserHandsClean(option.label), value: option.value, disabled: option.matches(':disabled'), selected: option.selected,
  })) : [];
  return { control, connected, humanOnly, value: value ?? null, options };
}`;

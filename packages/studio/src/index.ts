import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { assertNoLinks, boundedText, canonicalDirectory, credentialLike, safeRelative, sensitivePath } from '../../coding/src/security.ts';

export interface StudioSnapshot { entryPath: string; files: { path: string; content: string }[] }
export interface StudioElement {
  id: string; tag: string; file: string; line: number; text: string | null;
  styles: { color: string; backgroundColor: string; fontSize: string }; editableText: boolean; editableStyles?: boolean;
}
export interface StudioEdit { elementId: string; text?: string; styles?: { color?: string; backgroundColor?: string; fontSize?: number } }
export class StudioError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'StudioError'; }
}

const limits = { files: 40, fileBytes: 64_000, totalBytes: 128_000, elements: 1000 } as const;
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type MappedElement = { element: Element; dto: StudioElement };
const tags = new Set('main section article aside header footer nav div span p h1 h2 h3 h4 h5 h6 a button ul ol li dl dt dd blockquote pre code strong em b i u s small mark time br hr table thead tbody tfoot tr th td caption figure figcaption address details summary'.split(' '));
const voidTags = new Set(['br', 'hr']);
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;');
const isElement = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : [];
const attr = (node: Element, name: string) => node.attrs.find(item => item.name === name)?.value ?? '';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function checkSnapshot(snapshot: StudioSnapshot): void {
  if (!snapshot || typeof snapshot.entryPath !== 'string' || !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > limits.files) throw new StudioError('INVALID_STUDIO_SNAPSHOT', 'ملفات المعاينة غير صالحة أو تتجاوز الحد.');
  try { safeRelative(snapshot.entryPath); } catch { throw new StudioError('UNSAFE_STUDIO_PATH', 'مسار صفحة المعاينة غير صالح.'); }
  if (!/\.html$/i.test(snapshot.entryPath)) throw new StudioError('STATIC_HTML_REQUIRED', 'اختر ملف HTML لصفحة المعاينة.');
  const seen = new Set<string>(); let bytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new StudioError('INVALID_STUDIO_FILE', 'ملف المعاينة غير صالح.');
    try { safeRelative(file.path); } catch { throw new StudioError('UNSAFE_STUDIO_PATH', 'مسار ملف المعاينة غير صالح.'); }
    const key = file.path.toLowerCase();
    if (seen.has(key) || sensitivePath(file.path) || !/\.(?:html|css)$/i.test(file.path)) throw new StudioError('STATIC_FILES_REQUIRED', 'هذه المعاينة تقبل ملفات HTML وCSS فقط، دون أسرار أو مسارات مكررة.');
    seen.add(key);
    const size = Buffer.byteLength(file.content);
    if (size > limits.fileBytes || file.content.includes('\0') || credentialLike(file.content)) throw new StudioError('UNSUPPORTED_STUDIO_FILE', 'تجاوز الملف حدود النص الآمن للمعاينة.');
    bytes += size;
  }
  if (bytes > limits.totalBytes) throw new StudioError('STUDIO_PROJECT_TOO_LARGE', 'تجاوز المشروع حد محتوى المعاينة.');
  if (!snapshot.files.some(file => file.path === snapshot.entryPath)) throw new StudioError('STUDIO_ENTRY_NOT_FOUND', 'صفحة البداية غير موجودة داخل ملفات المشروع.');
}

/** Reads declarative files only; no project program, build command or dev server is run. */
export async function inspectStaticProject(path: string, entryPath: string, roots: readonly string[]): Promise<StudioSnapshot> {
  try {
    const directory = await canonicalDirectory(path, roots);
    const files: StudioSnapshot['files'] = []; let entries = 0;
    async function walk(folder: string, prefix: string) {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name === '.git' && !prefix) continue;
        const filePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        safeRelative(filePath);
        if (sensitivePath(filePath)) throw new StudioError('SENSITIVE_STUDIO_PATH', 'المجلد يحتوي مسارًا حساسًا؛ لم يُقرأ محتواه.');
        const fullPath = join(folder, entry.name);
        await assertNoLinks(fullPath);
        const info = await lstat(fullPath);
        if (++entries > 200 || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new StudioError('UNSUPPORTED_STUDIO_PATH', 'المجلد يتجاوز الحدود أو يحتوي روابط أو ملفات خاصة.');
        if (info.isDirectory()) await walk(fullPath, filePath);
        else {
          if (!/\.(?:html|css)$/i.test(filePath)) throw new StudioError('STATIC_FILES_REQUIRED', 'اختر مجلدًا مستقلًا لملفات HTML وCSS فقط.');
          if (files.length >= limits.files) throw new StudioError('STUDIO_PROJECT_TOO_LARGE', 'تجاوز المشروع عدد الملفات المدعوم.');
          files.push({ path: filePath, content: await boundedText(fullPath, limits.fileBytes) });
        }
      }
    }
    await walk(directory, '');
    const snapshot = { entryPath, files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
    checkSnapshot(snapshot); return snapshot;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') throw new StudioError(error.code, 'تعذر استيراد المشروع ضمن حدود القراءة المصرح بها.');
    throw new StudioError('STUDIO_IMPORT_FAILED', 'تعذر قراءة مجلد المشروع. تحقق من مساره وصلاحياته.');
  }
}

export function studioRevision(snapshot: StudioSnapshot): string {
  checkSnapshot(snapshot);
  return digest(JSON.stringify({ entryPath: snapshot.entryPath, files: [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path, 'en')) }));
}

/** Rejects escaped/network CSS wholesale; CSP independently denies every resource request. */
function safeCSS(value: string, warnings: Set<string>): string {
  if (/[\\<\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || /(?:(?:url|image-set|-webkit-image-set|image|src|paint)\s*\(|@import\b|@font-face\b|expression\s*\(|-moz-binding\b|behavior\s*:)/i.test(value)) {
    warnings.add('حُجب CSS يحتوي موارد خارجية أو صياغة غير مدعومة.'); return '';
  }
  return value;
}

/** Splits declarations without treating punctuation in strings/functions as structure. */
function declarations(value: string): string[] | null {
  const result: string[] = []; let start = 0, quote = '', comment = false; const stack: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index], next = value[index + 1];
    if (comment) { if (char === '*' && next === '/') { comment = false; index++; } continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '/' && next === '*') { comment = true; index++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (['(', '[', '{'].includes(char)) stack.push(char);
    if ([')', ']', '}'].includes(char)) {
      if (stack.pop() !== ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[char]) return null;
    }
    if (char === ';' && !stack.length) { result.push(value.slice(start, index)); start = index + 1; }
  }
  if (quote || comment || stack.length) return null;
  result.push(value.slice(start)); return result;
}
function declarationProperty(value: string): string { return value.slice(0, value.indexOf(':')).replace(/\/\*[\s\S]*?\*\//g, '').trim().toLowerCase(); }

function inlineStyles(node: Element): StudioElement['styles'] {
  const styles = { color: '', backgroundColor: '', fontSize: '' };
  for (const declaration of declarations(attr(node, 'style')) ?? []) {
    const property = declarationProperty(declaration), value = declaration.slice(declaration.indexOf(':') + 1).replace(/\s*!important\s*$/i, '').trim();
    if (property === 'color') styles.color = value;
    if (property === 'background-color') styles.backgroundColor = value;
    if (property === 'font-size') styles.fontSize = value;
  }
  return styles;
}

function analyze(snapshot: StudioSnapshot) {
  checkSnapshot(snapshot);
  const source = snapshot.files.find(file => file.path === snapshot.entryPath)!.content;
  const tree = parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  const mapped: MappedElement[] = []; const byNode = new Map<Element, StudioElement>(); const mappedOffsets = new Set<number>();
  let body: Element | undefined; let html: Element | undefined; let head: Element | undefined;
  const pending: { node: Node; depth: number }[] = [{ node: tree, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++nodes > 5000 || depth > 100) throw new StudioError('STUDIO_COMPLEX_HTML', 'تجاوزت الصفحة حدود العناصر أو عمق التداخل المدعوم.');
    if (isElement(node)) {
      if (node.tagName === 'html') html = node;
      if (node.tagName === 'head') head = node;
      if (node.tagName === 'body') body = node;
    }
    for (const child of children(node)) pending.push({ node: child, depth: depth + 1 });
  }
  function map(node: Node) {
    if (!isElement(node) || !tags.has(node.tagName)) return;
    const location = node.sourceCodeLocation;
    if (location?.startTag) {
      if (mappedOffsets.has(location.startTag.startOffset)) throw new StudioError('STUDIO_AMBIGUOUS_HTML', 'تحتوي الصفحة HTML ملتبسًا؛ أصلح بنية العناصر قبل تعديلها بصريًا.');
      mappedOffsets.add(location.startTag.startOffset);
      if (mapped.length >= limits.elements) throw new StudioError('STUDIO_TOO_MANY_ELEMENTS', 'تجاوزت الصفحة عدد العناصر المدعوم.');
      const editableText = Boolean(location.endTag) && node.childNodes.every(child => child.nodeName === '#text');
      const text = editableText ? node.childNodes.map(child => 'value' in child ? child.value : '').join('') : null;
      const dto: StudioElement = { id: `n${mapped.length + 1}`, tag: node.tagName, file: snapshot.entryPath, line: location.startTag.startLine, text, editableText, styles: inlineStyles(node) };
      mapped.push({ element: node, dto }); byNode.set(node, dto);
    }
    for (const child of children(node)) map(child);
  }
  if (body) for (const child of children(body)) map(child);
  return { source, tree, body, html, head, mapped, byNode };
}

export function renderStudio(snapshot: StudioSnapshot, nonce: string, revisionOverride?: string, sourceMapping?: {sourceElements: StudioElement[]; sourceAttribute: 'data-mohassan-source-id'}): { document: string; elements: StudioElement[]; warnings: string[] } {
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(nonce)) throw new StudioError('INVALID_PREVIEW_NONCE', 'رمز جلسة المعاينة غير صالح.');
  const revision = revisionOverride ?? studioRevision(snapshot);
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new StudioError('INVALID_PREVIEW_REVISION', 'إصدار المعاينة غير صالح.');
  const { tree, body, html, head, mapped, byNode } = analyze(snapshot);
  const warnings = new Set<string>(); const styles: string[] = []; const includedCSS = new Set<string>();
  let renderedMappings = mapped;
  if (sourceMapping) {
    if (sourceMapping.sourceAttribute !== 'data-mohassan-source-id' || sourceMapping.sourceElements.length > 1000) throw new StudioError('INVALID_SOURCE_MAPPING', 'خريطة مصدر المعاينة غير صالحة.');
    const known = new Map(sourceMapping.sourceElements.map(element => [element.id, element]));
    if (known.size !== sourceMapping.sourceElements.length || [...known.keys()].some(id => !/^n[1-9][0-9]{0,3}$/.test(id))) throw new StudioError('INVALID_SOURCE_MAPPING', 'خريطة مصدر المعاينة غير صالحة.');
    const counts = new Map<string, number>();
    const pending: Node[] = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (isElement(node)) {const id = attr(node, sourceMapping.sourceAttribute); if (id) counts.set(id, (counts.get(id) ?? 0) + 1);}
      pending.push(...children(node));
    }
    byNode.clear(); renderedMappings = [];
    for (const item of mapped) {
      const id = attr(item.element, sourceMapping.sourceAttribute), source = known.get(id);
      if (!source || counts.get(id) !== 1 || source.tag !== item.element.tagName) {
        if (id) warnings.add('تعذر ربط عنصر مكرر أو متغير بالمصدر بدقة؛ عُطّل تعديله البصري.');
        continue;
      }
      const normalize = (text: string | null) => (text ?? '').replace(/\s+/gu, ' ').trim();
      const dto = {...source, editableText: source.editableText && item.dto.editableText && normalize(source.text) === normalize(item.dto.text)};
      if (!dto.editableText) dto.text = null;
      byNode.set(item.element, dto); renderedMappings.push({element:item.element,dto});
    }
  }
  function attributes(node: Element): string {
    const allowed = new Set(['class', 'id', 'dir', 'lang', 'title', 'role', 'aria-label', 'aria-hidden', 'colspan', 'rowspan', 'open']);
    return node.attrs.map(item => {
      if (sourceMapping && item.name === sourceMapping.sourceAttribute) return '';
      if (item.name === 'style') { const value = safeCSS(item.value, warnings); return value ? ` style="${escapeAttribute(value)}"` : ''; }
      if (allowed.has(item.name)) return ` ${item.name}="${escapeAttribute(item.value)}"`;
      warnings.add('المعاينة تعرض HTML وCSS فقط؛ حُجبت الشيفرات والروابط والسمات التنفيذية.'); return '';
    }).join('');
  }
  function render(node: Node): string {
    if (node.nodeName === '#text' && 'value' in node) return escapeText(node.value);
    if (!isElement(node)) return '';
    if (node.tagName === 'style') { styles.push(safeCSS(node.childNodes.map(child => 'value' in child ? child.value : '').join(''), warnings)); return ''; }
    if (node.tagName === 'link') {
      if (attr(node, 'rel').toLowerCase() === 'stylesheet') {
        const href = attr(node, 'href');
        try {
          if (!href || href.startsWith('/') || /[:?#%\\]/.test(href)) throw new Error('Invalid local CSS');
          const path = safeRelative(posix.join(posix.dirname(snapshot.entryPath), href));
          const file = snapshot.files.find(item => item.path === path && /\.css$/i.test(item.path));
          if (!file) throw new Error('Missing local CSS');
          if (!includedCSS.has(path)) { includedCSS.add(path); styles.push(safeCSS(file.content, warnings)); }
          else warnings.add('أُدرج ملف CSS المحلي مرة واحدة فقط ضمن حدود المعاينة.');
        } catch { warnings.add('حُجب رابط CSS خارج ملفات النسخة، أو تعذر العثور عليه.'); }
      }
      return '';
    }
    if (!tags.has(node.tagName)) { warnings.add('المعاينة تعرض HTML وCSS فقط؛ حُجبت الشيفرات والروابط والسمات التنفيذية.'); return ''; }
    const mappedElement = byNode.get(node);
    const opening = `<${node.tagName}${attributes(node)}${mappedElement ? ` data-mohassan-studio-id="${mappedElement.id}"` : ''}>`;
    return opening + (voidTags.has(node.tagName) ? '' : node.childNodes.map(render).join('') + `</${node.tagName}>`);
  }
  if (head) for (const child of children(head)) {
    if (isElement(child) && ['style', 'link'].includes(child.tagName)) render(child);
    else if (isElement(child) && !['title', 'meta'].includes(child.tagName)) warnings.add('المعاينة تعرض HTML وCSS فقط؛ حُجبت الشيفرات والروابط والسمات التنفيذية.');
  }
  const bodyContent = body ? children(body).map(render).join('') : '';
  const htmlAttributes = html ? ['dir', 'lang'].map(name => attr(html!, name) ? ` ${name}="${escapeAttribute(attr(html!, name))}"` : '').join('') : '';
  const bodyAttributes = body ? attributes(body) : '';
  if (sourceMapping) {
    const hasPriority = (value: string) => /!\s*important\b/i.test(value.replace(/\/\*[\s\S]*?\*\//g, ''));
    const globalPriority = styles.some(hasPriority);
    for (const item of renderedMappings) {
      if (globalPriority || hasPriority(attr(item.element, 'style'))) {
        item.dto.editableStyles = false;
        warnings.add('تحتوي المعاينة قواعد أولوية CSS؛ يلزم تعديل الكود لهذا التنسيق بدل تغيير بصري غير مضمون.');
      }
    }
  }
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const textIds = renderedMappings.filter(item => item.dto.editableText).map(item => item.dto.id);
  const styleIds = renderedMappings.filter(item => item.dto.editableStyles !== false).map(item => item.dto.id);
  const bridge = `(()=>{const nonce=${JSON.stringify(nonce)},revision=${JSON.stringify(revision)},textIds=new Set(${JSON.stringify(textIds)}),styleIds=new Set(${JSON.stringify(styleIds)});let selecting=true,selected=null;addEventListener('message',event=>{const m=event.data;if(event.source!==parent||!m||typeof m!=='object'||m.nonce!==nonce||m.revision!==revision)return;if(m.type==='mohassan:studio:mode'&&typeof m.selecting==='boolean'){selecting=m.selecting;if(!selecting&&selected){selected.removeAttribute('data-mohassan-studio-selected');selected=null;}return;}if(m.type!=='mohassan:studio:draft'||typeof m.elementId!=='string'||!/^n[1-9][0-9]{0,3}$/.test(m.elementId))return;const target=document.querySelector('[data-mohassan-studio-id="'+m.elementId+'"]');if(!target)return;if(m.text!==undefined&&(typeof m.text!=='string'||m.text.length>4000||!textIds.has(m.elementId)))return;const s=m.styles;if(s&&Object.keys(s).length&&!styleIds.has(m.elementId))return;if(s!==undefined&&(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['color','backgroundColor','fontSize'].includes(k))))return;if(s){for(const k of ['color','backgroundColor'])if(s[k]!==undefined&&(typeof s[k]!=='string'||!/^#[a-f0-9]{6}$/i.test(s[k])))return;if(s.fontSize!==undefined&&(!Number.isInteger(s.fontSize)||s.fontSize<8||s.fontSize>96))return;}if(m.text!==undefined)target.textContent=m.text;if(s){if(s.color!==undefined)target.style.setProperty('color',s.color,'important');if(s.backgroundColor!==undefined)target.style.setProperty('background-color',s.backgroundColor,'important');if(s.fontSize!==undefined)target.style.setProperty('font-size',s.fontSize+'px','important');}});addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(!selecting||!(event.target instanceof Element))return;const target=event.target.closest('[data-mohassan-studio-id]');if(!target)return;if(selected)selected.removeAttribute('data-mohassan-studio-selected');selected=target;target.setAttribute('data-mohassan-studio-selected','');const computed=getComputedStyle(target);parent.postMessage({type:'mohassan:studio:select',nonce,revision,elementId:target.getAttribute('data-mohassan-studio-id'),styles:{color:computed.color.slice(0,64),backgroundColor:computed.backgroundColor.slice(0,64),fontSize:computed.fontSize.slice(0,32)}},'*');},true);})();`;
  const document = `<!doctype html><html${htmlAttributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><style>${styles.join('\n')}\nhtml body [data-mohassan-studio-selected]{outline:3px solid #18a999!important;outline-offset:3px!important;cursor:crosshair!important}</style></head><body${bodyAttributes}>${bodyContent}<script nonce="${nonce}">${bridge}</script></body></html>`;
  if (document.length > 500000) throw new StudioError('STUDIO_PREVIEW_TOO_LARGE', 'تجاوز المستند الناتج حجم المعاينة المدعوم.');
  return { document, elements: renderedMappings.map(item => item.dto), warnings: [...warnings] };
}

export function applyStudioEdit(snapshot: StudioSnapshot, edit: StudioEdit): StudioSnapshot {
  if (!edit || typeof edit.elementId !== 'string' || Object.keys(edit).some(key => !['elementId', 'text', 'styles'].includes(key)) || edit.text === undefined && edit.styles === undefined) throw new StudioError('INVALID_STUDIO_EDIT', 'حدد تعديلًا صريحًا للعنصر.');
  if (edit.text !== undefined && (typeof edit.text !== 'string' || edit.text.length > 4000 || edit.text.includes('\0') || credentialLike(edit.text))) throw new StudioError('INVALID_STUDIO_TEXT', 'النص غير صالح أو يتجاوز الحد.');
  if (edit.styles !== undefined && (!edit.styles || typeof edit.styles !== 'object' || Array.isArray(edit.styles) || !Object.keys(edit.styles).length || Object.keys(edit.styles).some(key => !['color', 'backgroundColor', 'fontSize'].includes(key)))) throw new StudioError('INVALID_STUDIO_STYLE', 'تعديل التنسيق غير صالح.');
  for (const key of ['color', 'backgroundColor'] as const) if (edit.styles?.[key] !== undefined && !/^#[a-f0-9]{6}$/i.test(edit.styles[key]!)) throw new StudioError('INVALID_STUDIO_STYLE', 'اختر لونًا بصيغة HEX من ست خانات.');
  if (edit.styles?.fontSize !== undefined && (!Number.isInteger(edit.styles.fontSize) || edit.styles.fontSize < 8 || edit.styles.fontSize > 96)) throw new StudioError('INVALID_STUDIO_STYLE', 'حجم الخط من 8 إلى 96 بكسل.');
  const { source, mapped } = analyze(snapshot);
  const selected = mapped.find(item => item.dto.id === edit.elementId);
  if (!selected) throw new StudioError('STUDIO_ELEMENT_NOT_FOUND', 'العنصر غير موجود في إصدار المصدر الحالي.', 409);
  const location = selected.element.sourceCodeLocation!;
  const patches: { start: number; end: number; value: string }[] = [];
  if (edit.text !== undefined) {
    if (!selected.dto.editableText || !location.startTag || !location.endTag) throw new StudioError('STUDIO_TEXT_MAPPING_UNAVAILABLE', 'هذا العنصر يحتوي عناصر أخرى؛ اختر عنصرًا نصيًا مباشرًا.');
    patches.push({ start: location.startTag.endOffset, end: location.endTag.startOffset, value: escapeText(edit.text) });
  }
  if (edit.styles) {
    let value = attr(selected.element, 'style');
    if (value && !safeCSS(value, new Set())) throw new StudioError('UNSUPPORTED_STUDIO_STYLE_SOURCE', 'تنسيق العنصر الحالي يحتوي صياغة محجوبة؛ أصلحه في المصدر قبل تعديل التنسيق بصريًا.');
    if (!declarations(value)) throw new StudioError('UNSUPPORTED_STUDIO_STYLE_SOURCE', 'تنسيق العنصر الحالي غير مكتمل؛ أصلحه في المصدر قبل تعديل التنسيق بصريًا.');
    for (const [key, raw] of Object.entries(edit.styles)) {
      const property = key === 'backgroundColor' ? 'background-color' : key === 'fontSize' ? 'font-size' : 'color';
      value = declarations(value)!.filter(part => declarationProperty(part) !== property).map(part => part.trim()).filter(Boolean).join('; ');
      value = `${value ? `${value}; ` : ''}${property}: ${key === 'fontSize' ? `${raw}px` : raw} !important`;
    }
    const styleLocation = location.attrs?.style;
    if (styleLocation) patches.push({ start: styleLocation.startOffset, end: styleLocation.endOffset, value: `style="${escapeAttribute(value)}"` });
    else {
      let insertion = location.startTag!.endOffset - 1;
      if (source[insertion - 1] === '/') insertion--;
      patches.push({ start: insertion, end: insertion, value: ` style="${escapeAttribute(value)}"` });
    }
  }
  let updated = source;
  for (const patch of patches.sort((a, b) => b.start - a.start)) updated = updated.slice(0, patch.start) + patch.value + updated.slice(patch.end);
  const next = { entryPath: snapshot.entryPath, files: snapshot.files.map(file => ({ ...file, content: file.path === snapshot.entryPath ? updated : file.content })) };
  checkSnapshot(next); return next;
}

export function createStudioDemo(): StudioSnapshot {
  return { entryPath: 'index.html', files: [
    { path: 'index.html', content: `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>مساحة لفكرتك</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <header class="site-header"><strong class="brand">مدار<span> / studio</span></strong><nav><a>الرؤية</a><a>الخدمات</a><a>لنتحدث</a></nav></header>
  <main>
    <section class="hero">
      <span class="eyebrow">أفكار تأخذ شكلًا</span>
      <h1>مساحة جديدة لفكرتك القادمة.</h1>
      <p class="lead">نحوّل الأفكار الطموحة إلى تجارب بسيطة، واضحة، وقريبة من الناس.</p>
      <button class="cta">لنبدأ الحكاية</button>
      <div class="hero-art"><span class="art-circle"></span><span class="art-line"></span><span class="art-caption">من الفكرة إلى الأثر</span></div>
    </section>
    <section class="services"><article><span class="number">01</span><h2>رؤية واضحة</h2><p>نبدأ بالسؤال الصحيح، ونرسم الطريق نحو تجربة لها معنى.</p></article><article><span class="number">02</span><h2>تصميم يتحدث</h2><p>تفاصيل مدروسة تمنح كل فكرة شخصيتها ومساحتها الخاصة.</p></article><article><span class="number">03</span><h2>أثر يستمر</h2><p>نبني تجارب تنمو معك، وتبقى قريبة من احتياجات جمهورك.</p></article></section>
  </main>
  <footer><span>مدار — مساحة للإمكانات</span><small>صُنع بعناية، لفكرة تستحق.</small></footer>
</body></html>\n` },
    { path: 'styles.css', content: `*{box-sizing:border-box}body{margin:0;background:#f6f4ed;color:#20392f;font-family:Tahoma,Arial,sans-serif}button,a{font:inherit}.site-header{max-width:1120px;margin:auto;padding:30px 40px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #d8ded4}.brand{font-size:25px}.brand span{font-size:12px;font-weight:400;color:#6a7d70}nav{display:flex;gap:28px;font-size:12px}main{max-width:1120px;margin:auto}.hero{padding:82px 40px 76px;position:relative;min-height:540px;overflow:hidden}.eyebrow{font-size:12px;letter-spacing:1px;color:#6f826e}.hero h1{font-size:62px;line-height:1.35;letter-spacing:-2px;margin:22px 0;font-weight:700;max-width:min(600px,calc(100% - 350px))}.lead{font-size:15px;line-height:2;max-width:420px;color:#6a7d70}.cta{border:0;background:#264e3c;color:#fff;padding:17px 27px;margin-top:18px;border-radius:4px}.hero-art{position:absolute;left:36px;top:100px;width:300px;height:340px;border:1px solid #bbc9b4;border-radius:150px 150px 12px 12px;background:#e5eadc;overflow:hidden}.art-circle{position:absolute;left:45px;top:45px;width:210px;height:210px;border-radius:50%;background:#aec29b}.art-line{position:absolute;left:100px;top:80px;width:100px;height:300px;background:#607e55;transform:rotate(-32deg);border-radius:55px}.art-caption{position:absolute;bottom:24px;right:28px;color:#f6f4ed;font-size:12px}.services{display:grid;grid-template-columns:repeat(3,1fr);gap:30px;padding:36px 40px 55px;border-top:1px solid #d8ded4}.number{font-size:12px;color:#889b7b}.services h2{font-size:19px;margin:20px 0 12px}.services p{font-size:12px;line-height:2;color:#6a7d70}footer{max-width:1120px;margin:auto;border-top:1px solid #d8ded4;padding:25px 40px 35px;display:flex;justify-content:space-between;font-size:11px;color:#6a7d70}footer small{font-size:10px}@media(max-width:960px){.site-header{padding:24px}.brand{font-size:22px}nav{gap:12px;font-size:10px}.hero{padding:48px 24px;min-height:800px}.hero h1{font-size:43px;letter-spacing:-1px;max-width:100%}.hero-art{top:auto;bottom:40px;left:50%;transform:translateX(-50%);height:300px;width:260px}.services{grid-template-columns:1fr;padding:30px 24px;gap:20px}.services h2{margin-top:10px}footer{padding:24px;gap:15px;flex-wrap:wrap}}\n` },
  ] };
}

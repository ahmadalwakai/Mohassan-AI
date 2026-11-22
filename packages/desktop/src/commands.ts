import { findKnownApp, knownFolderPath } from './apps.ts';
import { normalizeCombo } from './native.ts';
import { looksLikePath } from './paths.ts';
import { findTemplate, type TemplateId } from './projects.ts';

/**
 * The owner's words become one desktop command, or null when the sentence is not
 * plainly about this computer. Nothing here guesses: a sentence that could be a web
 * command, a letter or a question returns null so the existing routes keep it.
 */
export type DesktopCommand =
  | { kind: 'project_create'; name: string | null; template: TemplateId | null; parent: string | null; install: boolean; open: 'editor' | 'folder' | null; description: string | null }
  | { kind: 'project_list' }
  | { kind: 'project_open'; name: string; target: 'folder' | 'editor' | 'terminal' }
  | { kind: 'file_create'; name: string; folder: string | null; content: string | null }
  | { kind: 'folder_create'; name: string; folder: string | null }
  | { kind: 'file_write'; path: string; folder: string | null; content: string; mode: 'append' | 'overwrite' }
  | { kind: 'file_read'; path: string; folder: string | null }
  | { kind: 'file_list'; path: string | null }
  | { kind: 'file_search'; pattern: string; root: string | null }
  | { kind: 'file_delete'; path: string; folder: string | null; what: 'file' | 'folder' }
  | { kind: 'open'; target: string }
  | { kind: 'app_launch'; name: string }
  | { kind: 'shell'; command: string; cwd: string | null }
  | { kind: 'window_list' }
  | { kind: 'window_focus'; target: string }
  | { kind: 'window_close'; target: string }
  | { kind: 'window_minimize'; target: string }
  | { kind: 'window_maximize'; target: string }
  | { kind: 'screenshot'; target: string | null }
  | { kind: 'type'; text: string; window: string | null }
  | { kind: 'keys'; combo: string; window: string | null }
  | { kind: 'click_element'; name: string; window: string | null }
  | { kind: 'click_point'; x: number; y: number }
  | { kind: 'system_info' }
  | { kind: 'clipboard_read' }
  | { kind: 'clipboard_write'; text: string };

export interface ParsedDesktopCommand { command: DesktopCommand; lang: 'ar' | 'en'; /** Changes files, windows or input, as opposed to reading. */ mutating: boolean; text: string }

const ARABIC = /\p{Script=Arabic}/u;
const COURTESY = /^(?:(?:من فضلك|لو سمحت|رجاء|رجاءً|يا موحسن|موحسن|please|kindly|hey mohassan|mohassan)[،,:\s]+)+/iu;
const TRAILING = /[\s.!؟?،,]+$/u;

/** Tatweel removed and line endings normalised; diacritics, spaces and newlines stay, because file content is quoted verbatim. */
export const tidyRequest = (text: string): string => text.normalize('NFC').replace(/ـ/gu, '').replace(/\r\n?/gu, '\n').trim().replace(COURTESY, '').trim();
const oneLine = (text: string) => text.replace(/\s+/gu, ' ').trim();
const unquote = (text: string): string => {
  const value = text.trim();
  const match = /^(?:«([\s\S]*)»|"([\s\S]*)"|“([\s\S]*)”|'([\s\S]*)'|`([\s\S]*)`|```(?:\w+\n)?([\s\S]*?)```)$/u.exec(value);
  return (match ? match.slice(1).find(part => part !== undefined) ?? value : value).trim();
};
const stripTrailing = (text: string) => text.replace(TRAILING, '').trim();

/** Known folder words and paths; anything else is kept as a relative folder name. */
export function folderReference(text: string | undefined | null): string | null {
  if (!text) return null;
  const value = stripTrailing(unquote(oneLine(text))).replace(/^(?:مجلد|المجلد|فولدر|الفولدر|مشروع|المشروع|folder|directory|project|the folder|the directory|the project)\s+/iu, '');
  if (!value) return null;
  return knownFolderPath(value) ?? value;
}

const AR_CREATE = '(?:انشئ|أنشئ|إنشئ|انشىء|أنشىء|اعمل|إعمل|اعملي|سوي|سوّي|ابني|ابنِ|ابن|كون|كوّن|جهز|جهّز|حضر|حضّر|ولد|ولّد)';
const AR_LI = '(?:\\s+لي|\\s+لنا)?';
const EN_CREATE = '(?:create|make|generate|scaffold|set up|setup|start|build|bootstrap|init|initiali[sz]e)';
const EN_ARTICLE = '(?:\\s+(?:a|an|the|me|me a|me an|us a))?(?:\\s+new)?(?:\\s+(?:a|an))?';
const PROJECT_AR = '(?:مشروع|مشروعا|مشروعًا|بروجكت)';
const CONTENT_MARK = /(?:\s+(?:و?(?:اكتب|أكتب|ضع|احفظ|حط)\s+(?:فيه|به|داخله|فيها)\s*:?\s*|(?:بمحتوى|ومحتواه|محتواه|ومحتواها|محتواها|يحتوي(?:\s+على)?|يحوي|نصه|ونصه)\s*:?\s*|(?:with|containing|that contains|that says|whose content is)\s+(?:the\s+)?(?:(?:text|content|contents|following|line|lines)\s*)?(?:is\s+)?:?\s*)|\s*:(?=\s|$)\s*)/iu;
const LOCATION_AR = '(?:في|داخل|على|ضمن|تحت|عند)';
const LOCATION_EN = '(?:in|inside|into|within|under|at|on)';

interface Split { head: string; content: string | null }
/** Splits «create file X in Y with content Z»: the content is everything after the first content marker. */
function splitContent(text: string): Split {
  const match = CONTENT_MARK.exec(text);
  if (!match) return { head: text, content: null };
  const content = text.slice(match.index + match[0].length);
  return { head: text.slice(0, match.index), content: content.trim() ? unquote(content) : null };
}

/** «X في Y» / «X in Y» → name and folder; the folder is the last location phrase. */
function splitLocation(text: string, lang: 'ar' | 'en'): { name: string; folder: string | null } {
  const pattern = lang === 'ar' ? new RegExp(`^(.+?)\\s+${LOCATION_AR}\\s+(?:مجلد\\s+|المجلد\\s+|فولدر\\s+)?(.+)$`, 'u') : new RegExp(`^(.+?)\\s+${LOCATION_EN}\\s+(?:the\\s+)?(?:folder\\s+|directory\\s+)?(.+)$`, 'iu');
  const match = pattern.exec(text);
  if (!match) return { name: stripTrailing(unquote(text)), folder: null };
  return { name: stripTrailing(unquote(match[1]!)), folder: folderReference(match[2]!) };
}

function parseProjectCreate(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  const match = lang === 'ar'
    ? new RegExp(`^${AR_CREATE}${AR_LI}\\s+${PROJECT_AR}(?:\\s+جديد(?:ا|ًا)?)?(?:\\s+(.*))?$`, 'u').exec(text)
    : new RegExp(`^${EN_CREATE}${EN_ARTICLE}\\s+(.*?)\\s*project(?:\\s+(.*))?$|^${EN_CREATE}${EN_ARTICLE}\\s+project(?:\\s+(.*))?$`, 'iu').exec(text);
  if (!match) return null;
  let rest = lang === 'ar' ? (match[1] ?? '') : `${match[1] ?? ''} ${match[2] ?? match[3] ?? ''}`.trim();
  let template: TemplateId | null = null, parent: string | null = null, install = false, open: 'editor' | 'folder' | null = null, name: string | null = null, description: string | null = null;
  const descriptionMatch = /\s+(?:وصفه|ووصفه|الوصف|description|described as)\s*:?\s*(.+)$/iu.exec(rest);
  if (descriptionMatch) { description = unquote(descriptionMatch[1]!); rest = rest.slice(0, descriptionMatch.index); }
  if (/\s*(?:و|ثم\s+|and\s+|then\s+)?(?:ثبت|ثبّت|نزل|نزّل|حمل|حمّل)\s+(?:الحزم|الاعتماديات|المكتبات|npm)|\s+(?:and\s+|then\s+)?(?:install|with)\s+(?:the\s+)?(?:deps|dependencies|packages|npm)/iu.test(rest)) { install = true; rest = rest.replace(/\s*(?:و|ثم\s+|and\s+|then\s+)?(?:ثبت|ثبّت|نزل|نزّل|حمل|حمّل)\s+(?:الحزم|الاعتماديات|المكتبات|npm)|\s+(?:and\s+|then\s+)?(?:install|with)\s+(?:the\s+)?(?:deps|dependencies|packages|npm)/iu, ' '); }
  if (/\s*(?:و|ثم\s+|and\s+|then\s+)?(?:افتحه|افتحها|وافتحه)(?:\s+في\s+(?:vs\s?code|كود|المحرر))?|\s+(?:and\s+|then\s+)?open\s+it(?:\s+in\s+(?:vs\s?code|the\s+editor))?/iu.test(rest)) { open = /vs\s?code|كود|المحرر|editor/iu.test(rest) ? 'editor' : 'folder'; rest = rest.replace(/\s*(?:و|ثم\s+|and\s+|then\s+)?(?:افتحه|افتحها|وافتحه)(?:\s+في\s+(?:vs\s?code|كود|المحرر))?|\s+(?:and\s+|then\s+)?open\s+it(?:\s+in\s+(?:vs\s?code|the\s+editor))?/iu, ' '); }
  const named = lang === 'ar' ? /^(.*?)\s*(?:اسمه|اسمها|باسم|يسمى|يُسمى|سمه|سمّه|اسم)\s+(.+)$/u.exec(rest) : /^(.*?)\s*(?:called|named|name it|with the name|titled)\s+(.+)$/iu.exec(rest);
  let before = rest, after = '';
  if (named) { before = named[1] ?? ''; after = named[2] ?? ''; }
  // The folder may follow the name («اسمه متجري في المستندات») or precede it («في المستندات مشروع ...»).
  const take = (source: string): string => {
    const location = lang === 'ar' ? new RegExp(`^(.*?)\\s*${LOCATION_AR}\\s+(?:مجلد\\s+|المجلد\\s+|فولدر\\s+)?(.+)$`, 'u').exec(source) : new RegExp(`^(.*?)\\s*\\b${LOCATION_EN}\\s+(?:the\\s+)?(?:folder\\s+|directory\\s+)?(.+)$`, 'iu').exec(source);
    if (!location) return source;
    const candidate = folderReference(location[2]!);
    if (candidate && (looksLikePath(candidate) || knownFolderPath(location[2]!) || /^(?:مجلد|المجلد|فولدر|folder|directory)\s/iu.test(location[2]!.trim()))) { parent = candidate; return location[1] ?? ''; }
    return source;
  };
  if (named) { after = take(after); before = take(before); name = stripTrailing(unquote(after)) || null; }
  else before = take(before);
  // Whatever names a template leaves the remaining words as the name.
  const words = oneLine(before).replace(/\b(?:من نوع|نوع|بلغة|بإطار|باطار|بـ|using|with|in|of type|type)\s+/giu, ' ').split(' ').filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    const found = findTemplate(word);
    if (found && !template) template = found.id; else kept.push(word);
  }
  // Two-word template names («node js», «vs code» is not one).
  if (!template) { const joined = kept.join(' '); const found = findTemplate(joined); if (found) { template = found.id; kept.length = 0; } }
  if (!name) {
    const leftover = kept.join(' ').replace(/^(?:جديد|جديدا|جديدًا|صغير|بسيط|new|small|simple|basic)\s*/u, '').trim();
    name = stripTrailing(unquote(leftover)) || null;
  }
  if (name && /^(?:جديد|جديدا|جديدًا|new)$/u.test(name)) name = null;
  return { kind: 'project_create', name, template, parent, install, open, description };
}

function parseFileCreate(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  const match = lang === 'ar'
    ? new RegExp(`^${AR_CREATE}${AR_LI}\\s+(ملف|ملفا|ملفًا|مجلد|مجلدا|مجلدًا|فولدر)(?:\\s+جديد(?:ا|ًا)?)?(?:\\s+(?:نصي|نصيا|نصيًا|text))?(?:\\s+(?:اسمه|اسمها|باسم|يسمى|سمه))?\\s+([\\s\\S]+)$`, 'u').exec(text)
    : new RegExp(`^${EN_CREATE}${EN_ARTICLE}\\s+(?:text\\s+|empty\\s+)?(file|folder|directory)(?:\\s+(?:called|named))?\\s+([\\s\\S]+)$`, 'iu').exec(text);
  if (!match) return null;
  const isFolder = /^(?:مجلد|مجلدا|مجلدًا|فولدر|folder|directory)$/iu.test(match[1]!);
  const { head, content } = splitContent(match[2]!);
  const { name, folder } = splitLocation(oneLine(head), lang);
  if (!name) return null;
  if (isFolder) return { kind: 'folder_create', name, folder };
  return { kind: 'file_create', name, folder, content };
}

function parseFileWrite(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  const match = lang === 'ar'
    ? /^(اكتب|أكتب|إكتب|اضف|أضف|ضيف|احفظ|إحفظ|الحق|ألحق)\s+(?:لي\s+)?(?:هذا\s+|هذه\s+|التالي\s+)?([\s\S]+?)\s+(?:في|داخل|إلى|الى|لـ|ل)\s+(?:نهاية\s+|آخر\s+|اخر\s+)?(?:ال)?ملف\s+([^\n]+)$/u.exec(text)
    : /^(write|add|append|save|put)\s+(?:this\s+|the following\s+|the text\s+)?([\s\S]+?)\s+(?:to|in|into|at the end of|onto)\s+(?:the\s+)?file\s+([^\n]+)$/iu.exec(text);
  if (!match) return null;
  const content = unquote(match[2]!);
  if (!content) return null;
  const { name, folder } = splitLocation(stripTrailing(match[3]!), lang);
  const verb = match[1]!.toLowerCase();
  const mode: 'append' | 'overwrite' = /^(?:اكتب|أكتب|إكتب|احفظ|إحفظ|write|save|put)$/u.test(verb) && /(?:بدل|بدلًا|استبدل|واستبدل|replace|overwrite|instead)/iu.test(text) ? 'overwrite' : 'append';
  return { kind: 'file_write', path: name, folder, content, mode };
}

function parseFileRead(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  const match = lang === 'ar'
    ? /^(?:اقرأ|إقرأ|اقرا|اعرض|أعرض|اطبع|ورني|وريني|أرني|ارني|ما|ماذا|وش|شو|ايش|إيش)\s+(?:لي\s+)?(?:هو\s+)?(?:محتوى|محتويات|نص|يوجد في|مكتوب في|في|داخل)?\s*(?:ال)?ملف\s+(.+)$/u.exec(text)
    : /^(?:read|show|cat|print|display|open and read|what(?:'s| is) (?:in|inside))\s+(?:me\s+)?(?:the\s+)?(?:contents?\s+of\s+)?(?:the\s+)?file\s+(.+)$/iu.exec(text);
  if (!match) return null;
  const { name, folder } = splitLocation(stripTrailing(match[1]!), lang);
  return name ? { kind: 'file_read', path: name, folder } : null;
}

function parseFileList(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  if (lang === 'ar') {
    const match = /^(?:اعرض|أعرض|اطلع|قائمة|اذكر|عدد|ورني|وريني|أرني|ارني|ما|ماهي|ما هي|وش|شو|ايش|إيش)\s+(?:لي\s+)?(?:هي\s+)?(?:ال)?(?:ملفات|الملفات|محتويات|محتوى|ملفات ومجلدات|الملفات والمجلدات)\s*(?:الموجودة\s+|اللي\s+|التي\s+)?(?:في|داخل|على|عندي في|الموجودة في)?\s*(.*)$/u.exec(text);
    if (match) { const target = stripTrailing(match[1] ?? ''); return { kind: 'file_list', path: target && !/^(?:عندي|لدي|جهازي|الكمبيوتر|الحاسوب)$/u.test(target) ? folderReference(target) : null }; }
    return null;
  }
  const match = /^(?:list|show|display|what(?:'s| is| are)(?: in| inside)?|ls|dir)\s+(?:me\s+)?(?:the\s+|my\s+)?(?:files|contents|folders|files and folders)?\s*(?:in|of|inside|under)?\s*(?:the\s+)?(?:folder\s+|directory\s+)?(.*)$/iu.exec(text);
  if (!match || !/files|contents|folders|^ls\b|^dir\b/iu.test(text)) return null;
  const target = stripTrailing(match[1] ?? '');
  return { kind: 'file_list', path: target && !/^(?:my (?:pc|computer)|here)$/iu.test(target) ? folderReference(target) : null };
}

function parseFileSearch(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  const match = lang === 'ar'
    ? /^(?:ابحث|أبحث|إبحث|دور|دوّر|فتش|فتّش|جد|اعثر|أعثر|وين|أين|اين)\s+(?:لي\s+)?(?:عن\s+|على\s+)?(?:ال)?(?:ملف|ملفات|مجلد|مجلدات)\s+(?:اسمه\s+|اسمها\s+|باسم\s+|يسمى\s+)?(.+)$/u.exec(text)
    : /^(?:find|search for|search|locate|look for|where is|where's)\s+(?:me\s+)?(?:a\s+|the\s+|all\s+)?(?:file|files|folder|folders|directory)\s+(?:named\s+|called\s+)?(.+)$/iu.exec(text);
  if (!match) return null;
  const { name, folder } = splitLocation(stripTrailing(match[1]!), lang);
  return name ? { kind: 'file_search', pattern: name, root: folder } : null;
}

function parseFileDelete(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  const match = lang === 'ar'
    ? /^(?:احذف|إحذف|امسح|إمسح|ازل|أزل|شيل|شِل|تخلص من)\s+(?:لي\s+)?(?:ال)?(ملف|مجلد|فولدر)\s+(.+)$/u.exec(text)
    : /^(?:delete|remove|erase|trash|get rid of)\s+(?:the\s+)?(file|folder|directory)\s+(.+)$/iu.exec(text);
  if (!match) return null;
  const what = /^(?:ملف|file)$/iu.test(match[1]!) ? 'file' : 'folder';
  const target = stripTrailing(match[2]!).replace(/^(?:اسمه|اسمها|باسم|named|called)\s+/u, '');
  const { name, folder } = lang === 'ar' ? (() => { const inner = /^(.+?)\s+(?:من|في|داخل)\s+(?:مجلد\s+|المجلد\s+)?(.+)$/u.exec(target); return inner ? { name: stripTrailing(unquote(inner[1]!)), folder: folderReference(inner[2]!) } : { name: stripTrailing(unquote(target)), folder: null }; })() : splitLocation(target.replace(/\s+from\s+/iu, ' in '), lang);
  return name ? { kind: 'file_delete', path: name, folder, what } : null;
}

const WINDOW_WORD_AR = '(?:ال)?(?:نافذة|نافذه|شاشة|شاشه|برنامج|تطبيق|البرنامج|التطبيق)';

function parseWindows(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  if (lang === 'ar') {
    if (/^(?:ما|ماهي|ما هي|اعرض|أعرض|اطلع|ورني|وريني|أرني|ارني|قائمة|اذكر|كم|وش|شو|ايش|إيش)\s+(?:لي\s+)?(?:هي\s+|عدد\s+)?(?:ال)?(?:نوافذ|النوافذ|البرامج|التطبيقات)(?:\s+(?:المفتوحة|المفتوحه|الحالية|الحاليه|الشغالة|الشغاله|التي تعمل|اللي شغالة|اللي شغاله|النشطة|النشطه))?(?:\s+(?:الآن|الان|حاليا|حاليًا|عندي|لدي|على جهازي|في جهازي|على الكمبيوتر|على الشاشة|على الشاشه))*$/u.test(text)) return { kind: 'window_list' };
    let match = new RegExp(`^(?:ركز|ركّز|انتقل|إنتقل|اذهب|إذهب|روح|بدل|بدّل|اظهر|أظهر|فعل|فعّل|حول|حوّل)\\s+(?:لي\\s+)?(?:على\\s+|إلى\\s+|الى\\s+|ل)?${WINDOW_WORD_AR}\\s+(.+)$`, 'u').exec(text);
    if (match) return { kind: 'window_focus', target: stripTrailing(unquote(match[1]!)) };
    match = /^(?:ركز|ركّز|انتقل|إنتقل|اذهب|إذهب|روح|بدل|بدّل|حول|حوّل)\s+(?:على\s+|إلى\s+|الى\s+|ل)?(.+)$/u.exec(text);
    if (match && findKnownApp(match[1]!)) return { kind: 'window_focus', target: stripTrailing(unquote(match[1]!)) };
    match = new RegExp(`^(?:اغلق|أغلق|إغلق|اقفل|أقفل|سكر|سكّر|انه|أنهِ|انهي|أنهي)\\s+(?:لي\\s+)?${WINDOW_WORD_AR}\\s+(.+)$`, 'u').exec(text);
    if (match) return { kind: 'window_close', target: stripTrailing(unquote(match[1]!)) };
    match = /^(?:اغلق|أغلق|إغلق|اقفل|أقفل|سكر|سكّر)\s+(.+)$/u.exec(text);
    if (match && findKnownApp(match[1]!)) return { kind: 'window_close', target: stripTrailing(unquote(match[1]!)) };
    match = new RegExp(`^(?:صغر|صغّر|قزم|قزّم|اخف|أخف|اخفي|أخفي|اخفِ)\\s+(?:لي\\s+)?${WINDOW_WORD_AR}\\s+(.+)$`, 'u').exec(text);
    if (match) return { kind: 'window_minimize', target: stripTrailing(unquote(match[1]!)) };
    match = new RegExp(`^(?:كبر|كبّر|وسع|وسّع|املأ|املا)\\s+(?:لي\\s+)?${WINDOW_WORD_AR}\\s+(.+)$`, 'u').exec(text);
    if (match) return { kind: 'window_maximize', target: stripTrailing(unquote(match[1]!)) };
    return null;
  }
  if (/^(?:list|show|display|what(?:'s| is| are)?|which)\s+(?:me\s+)?(?:all\s+)?(?:the\s+|my\s+)?(?:currently\s+)?(?:open\s+)?(?:windows|apps|applications|programs)(?:\s+(?:are\s+)?(?:open|running))?(?:\s+(?:on|in)\s+(?:my\s+)?(?:pc|computer|screen|desktop))?(?:\s+(?:now|right now|currently))?$/iu.test(text) || /^what(?:'s| is)\s+open(?:\s+(?:on|in)\s+(?:my\s+)?(?:pc|computer|screen|desktop))?(?:\s+(?:now|right now))?$/iu.test(text)) return { kind: 'window_list' };
  let match = /^(?:focus|switch to|activate|bring up|go to|bring (?:me )?to|show)\s+(?:on\s+)?(?:the\s+)?(?:window|app|application|program)\s+(.+)$/iu.exec(text);
  if (match) return { kind: 'window_focus', target: stripTrailing(unquote(match[1]!)) };
  match = /^(?:focus|switch to|activate|bring up|go to)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+window)?$/iu.exec(text);
  if (match && findKnownApp(match[1]!)) return { kind: 'window_focus', target: stripTrailing(unquote(match[1]!)) };
  match = /^(?:close|quit|exit|kill)\s+(?:the\s+)?(?:window|app|application|program)\s+(.+)$/iu.exec(text);
  if (match) return { kind: 'window_close', target: stripTrailing(unquote(match[1]!)) };
  match = /^(?:close|quit|exit)\s+(?:the\s+)?(.+?)(?:\s+window)?$/iu.exec(text);
  if (match && findKnownApp(match[1]!)) return { kind: 'window_close', target: stripTrailing(unquote(match[1]!)) };
  match = /^(?:minimi[sz]e|hide)\s+(?:the\s+)?(?:window\s+)?(.+?)(?:\s+window)?$/iu.exec(text);
  if (match) return { kind: 'window_minimize', target: stripTrailing(unquote(match[1]!)) };
  match = /^(?:maximi[sz]e|enlarge|full ?screen)\s+(?:the\s+)?(?:window\s+)?(.+?)(?:\s+window)?$/iu.exec(text);
  if (match) return { kind: 'window_maximize', target: stripTrailing(unquote(match[1]!)) };
  return null;
}

function parseScreenshot(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  const match = lang === 'ar'
    ? /^(?:(?:خذ|خد|التقط|إلتقط|اخذ|صور|صوّر|اعمل|إعمل|سوي|سوّي|اطلع|أعطني|اعطني|ارسل|أرسل)\s+(?:لي\s+)?)?(?:لقطة|لقطه|صورة|صوره|سكرين شوت|سكرينشوت|سكرين)(?:\s+(?:ل|لل|من|عن)?\s*(?:ال)?(?:شاشة|شاشه|الشاشة|الشاشه|سطح المكتب))?(?:\s+(?:ل|لل|من|عن)?\s*(?:ال)?(?:نافذة|نافذه)\s+(.+))?$/u.exec(text)
      ?? /^(?:صور|صوّر|التقط|إلتقط|خذ|خد)\s+(?:لي\s+)?(?:(?:ال)?(?:شاشة|شاشه|سطح المكتب)|(?:ال)?(?:نافذة|نافذه)\s+(.+))$/u.exec(text)
    : /^(?:(?:take|capture|grab|snap|get|make|send|show)\s+(?:me\s+)?)?(?:a\s+)?(?:screenshot|screen shot|screen capture|screengrab|picture of (?:the|my) screen)(?:\s+of\s+(?:the\s+|my\s+)?(?:screen|desktop))?(?:\s+of\s+(?:the\s+)?(?:window\s+)?(.+))?$/iu.exec(text);
  if (!match) return null;
  return { kind: 'screenshot', target: match[1] ? stripTrailing(unquote(match[1])) : null };
}

/** Explicit PC context for typing and keys: a window, a known program, or the computer itself. */
function windowContext(tail: string | undefined, lang: 'ar' | 'en'): { window: string | null; explicit: boolean } {
  if (!tail) return { window: null, explicit: false };
  const value = stripTrailing(unquote(tail));
  if (lang === 'ar') {
    if (/^(?:ال)?(?:نافذة|نافذه|الشاشة|الشاشه|البرنامج|التطبيق)\s*(?:الحالية|الحاليه|المفتوحة|المفتوحه|النشطة|النشطه|الآن|الان)?$|^(?:الكمبيوتر|الحاسوب|جهازي|كمبيوتري|حاسوبي|لوحة المفاتيح|الكيبورد)$/u.test(value)) return { window: null, explicit: true };
    const named = /^(?:ال)?(?:نافذة|نافذه|برنامج|تطبيق)\s+(.+)$/u.exec(value);
    if (named) return { window: stripTrailing(named[1]!), explicit: true };
    return findKnownApp(value) ? { window: value, explicit: true } : { window: null, explicit: false };
  }
  if (/^(?:the\s+)?(?:current|active|open|focused|foreground)?\s*(?:window|screen|app|application|program)$|^(?:the\s+|my\s+)?(?:pc|computer|keyboard)$/iu.test(value)) return { window: null, explicit: true };
  const named = /^(?:the\s+)?(?:window|app|application|program)\s+(.+)$/iu.exec(value);
  if (named) return { window: stripTrailing(named[1]!), explicit: true };
  return findKnownApp(value) ? { window: value, explicit: true } : { window: null, explicit: false };
}

const KEY_WORD = /^(?:[a-z0-9]|f\d{1,2}|enter|return|tab|esc|escape|space|backspace|delete|del|insert|home|end|pageup|pagedown|pgup|pgdn|up|down|left|right|win|windows|ctrl|control|alt|shift|printscreen|capslock|numlock|menu|plus|minus|comma|period|slash|backslash|semicolon|quote|grave|volumeup|volumedown|mute|playpause|cmd|command|super|إنتر|انتر|إدخال|ادخال|مسافة|مسافه|تاب|هروب|إسكيب|اسكيب|حذف|تراجع|كنترول|كونترول|التحكم|شيفت|ألت|الت|ويندوز|أعلى|اعلى|أسفل|اسفل|يسار|يمين|بداية|نهاية)$/iu;
const isCombo = (text: string): boolean => {
  const parts = text.toLowerCase().split(/\s*\+\s*|\s+و\s+|\s+and\s+/u).map(part => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.length <= 4 && parts.every(part => KEY_WORD.test(part));
};
const hasModifier = (combo: string) => /(?:^|\+)(?:ctrl|alt|win|shift)(?:\+|$)/u.test(combo);

function parseInput(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  if (lang === 'ar') {
    let match = /^(?:اكتب|أكتب|إكتب|اطبع|أطبع)\s+(?:النص\s+|الكلمة\s+|الجملة\s+)?([\s\S]+?)\s+(?:في|داخل|على|ب)\s+(.+)$/u.exec(text);
    if (match) { const context = windowContext(match[2], lang); if (context.explicit) return { kind: 'type', text: unquote(match[1]!), window: context.window }; }
    match = /^(?:اضغط|إضغط|اكبس|إكبس|انقر|إنقر|دوس|دوّس)\s+(?:لي\s+)?(?:على\s+|عل\s+)?(?:زر\s+|الزر\s+|على زر\s+)(.+?)(?:\s+(?:في|داخل|على|ب)\s+(.+))?$/u.exec(text);
    if (match) { const context = windowContext(match[2], lang); if (context.explicit || !match[2]) return match[2] && !context.explicit ? null : { kind: 'click_element', name: stripTrailing(unquote(match[1]!)), window: context.window }; }
    match = /^(?:اضغط|إضغط|اكبس|إكبس|انقر|إنقر|دوس|دوّس)\s+(?:لي\s+)?(?:على\s+|عل\s+)?(?:مفتاح\s+|المفتاح\s+|مفاتيح\s+|اختصار\s+|الاختصار\s+|زر\s+)?(.+?)(?:\s+(?:في|داخل|على|ب)\s+(.+))?$/u.exec(text);
    if (match) {
      const raw = stripTrailing(unquote(match[1]!));
      const point = /^\(?\s*(\d{1,5})\s*[,،]\s*(\d{1,5})\s*\)?$/u.exec(raw);
      if (point && !match[2]) return { kind: 'click_point', x: Number(point[1]), y: Number(point[2]) };
      if (isCombo(raw)) {
        const combo = normalizeCombo(raw);
        const context = windowContext(match[2], lang);
        if (match[2] && !context.explicit) return null;
        if (hasModifier(combo) || context.explicit) return { kind: 'keys', combo, window: context.window };
      }
    }
    return null;
  }
  let match = /^(?:type|enter|input|write)\s+(?:the\s+)?(?:text\s+|word\s+|sentence\s+)?([\s\S]+?)\s+(?:in|into|inside|on|to)\s+(.+)$/iu.exec(text);
  if (match) { const context = windowContext(match[2], lang); if (context.explicit) return { kind: 'type', text: unquote(match[1]!), window: context.window }; }
  match = /^(?:click|press|tap|hit)\s+(?:on\s+)?(?:the\s+)?button\s+(.+?)(?:\s+(?:in|inside|on)\s+(.+))?$/iu.exec(text);
  if (match) { const context = windowContext(match[2], lang); if (match[2] && !context.explicit) return null; return { kind: 'click_element', name: stripTrailing(unquote(match[1]!)), window: context.window }; }
  match = /^(?:press|hit|hold|send|click|tap)\s+(?:on\s+)?(?:the\s+)?(?:key\s+|keys\s+|shortcut\s+|button\s+|at\s+)?(.+?)(?:\s+(?:in|inside|on)\s+(.+))?$/iu.exec(text);
  if (match) {
    const raw = stripTrailing(unquote(match[1]!));
    const point = /^\(?\s*(\d{1,5})\s*,\s*(\d{1,5})\s*\)?$/u.exec(raw);
    if (point && !match[2]) return { kind: 'click_point', x: Number(point[1]), y: Number(point[2]) };
    if (isCombo(raw)) {
      const combo = normalizeCombo(raw);
      const context = windowContext(match[2], lang);
      if (match[2] && !context.explicit) return null;
      if (hasModifier(combo) || context.explicit) return { kind: 'keys', combo, window: context.window };
    }
  }
  return null;
}

function parseShell(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  let match = lang === 'ar'
    ? /^(?:(?:في|داخل)\s+(?:مجلد|المجلد|مشروع|المشروع|فولدر)\s+(.+?)\s*[،,:]?\s+)?(?:نفذ|نفّذ|شغل|شغّل|اجر|أجر|اجرِ|أجرِ|اجري|طبق|طبّق|ارن|اعمل run)\s+(?:لي\s+)?(?:هذا\s+|هذه\s+)?(?:ال)?(?:أمر|امر|الأمر|الامر|كوماند|الكوماند|سكربت|السكربت)(?:\s+التالي)?\s*:?\s*([\s\S]+?)(?:\s+(?:في|داخل)\s+(?:مجلد|المجلد|مشروع|المشروع|فولدر)\s+([^\n]+))?$/u.exec(text)
    : /^(?:(?:in|inside)\s+(?:the\s+)?(?:folder|directory|project)\s+(.+?)\s*[,:]?\s+)?(?:run|execute|exec|launch)\s+(?:this\s+|the\s+|the following\s+)?(?:command|cmd|script|shell command|in (?:the )?terminal)\s*:?\s*([\s\S]+?)(?:\s+(?:in|inside)\s+(?:the\s+)?(?:folder|directory|project)\s+([^\n]+))?$/iu.exec(text);
  if (!match) {
    match = lang === 'ar' ? /^(?:في\s+)?(?:الطرفية|الطرفيه|التيرمينال|terminal|powershell|cmd)\s*:\s*([\s\S]+)$/iu.exec(text) : /^(?:in\s+)?(?:terminal|powershell|cmd|shell)\s*:\s*([\s\S]+)$/iu.exec(text);
    if (!match) return null;
    const command = unquote(match[1]!);
    return command ? { kind: 'shell', command, cwd: null } : null;
  }
  const command = unquote(match[2]!);
  if (!command) return null;
  return { kind: 'shell', command, cwd: folderReference(match[1] ?? match[3] ?? null) };
}

function parseProjects(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  if (lang === 'ar') {
    if (/^(?:ما|ماهي|ما هي|اعرض|أعرض|قائمة|اذكر|ورني|وريني|أرني|ارني|كم|وش|شو|ايش|إيش)\s+(?:لي\s+)?(?:هي\s+|عدد\s+)?(?:ال)?مشاريع(?:ي|\s+عندي|\s+لدي|\s+الموجودة|\s+الموجوده|\s+المسجلة|\s+المسجله|\s+التي أنشأتها|\s+اللي أنشأتها|\s+على جهازي|\s+في جهازي)*\s*(?:عندي|لدي)?$/u.test(text)) return { kind: 'project_list' };
    const match = /^(?:افتح|إفتح|اعرض|أعرض|ادخل|أدخل)\s+(?:لي\s+)?(?:ال)?مشروع\s+(.+?)(?:\s+(?:في|ب|بـ|داخل|على|عبر)\s+(vs ?code|vscode|كود|المحرر|محرر الأكواد|محرر|editor|code|الطرفية|الطرفيه|التيرمينال|terminal|cmd|powershell|المستكشف|explorer|المجلد))?$/iu.exec(text);
    if (match) return { kind: 'project_open', name: stripTrailing(unquote(match[1]!)), target: match[2] ? /طرفي|تيرمينال|terminal|cmd|powershell/iu.test(match[2]) ? 'terminal' : /مستكشف|explorer|المجلد/iu.test(match[2]) ? 'folder' : 'editor' : 'folder' };
    return null;
  }
  if (/^(?:list|show|display|what are)\s+(?:me\s+)?(?:all\s+)?(?:my\s+|the\s+)?projects(?:\s+(?:on|in)\s+(?:my\s+)?(?:pc|computer))?$/iu.test(text)) return { kind: 'project_list' };
  const match = /^(?:open|show)\s+(?:me\s+)?(?:the\s+)?project\s+(.+?)(?:\s+(?:in|with|using)\s+(vs ?code|vscode|code|the editor|editor|terminal|cmd|powershell|explorer|the folder))?$/iu.exec(text);
  if (match) return { kind: 'project_open', name: stripTrailing(unquote(match[1]!)), target: match[2] ? /terminal|cmd|powershell/iu.test(match[2]) ? 'terminal' : /explorer|folder/iu.test(match[2]) ? 'folder' : 'editor' : 'folder' };
  return null;
}

function parseOpen(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  const match = lang === 'ar'
    ? /^(?:افتح|إفتح|شغل|شغّل|ابدأ|ابدا|اطلق|أطلق|اعرض|أعرض)\s+(?:لي\s+)?(?:برنامج\s+|تطبيق\s+|البرنامج\s+|التطبيق\s+|مجلد\s+|المجلد\s+|ملف\s+|الملف\s+|فولدر\s+)?(.+)$/u.exec(text)
    : /^(?:open|launch|start|run|show)\s+(?:me\s+)?(?:the\s+|up\s+)?(?:app\s+|application\s+|program\s+|folder\s+|directory\s+|file\s+)?(.+)$/iu.exec(text);
  if (!match) return null;
  const target = stripTrailing(unquote(match[1]!));
  if (!target) return null;
  const typed = lang === 'ar' ? /^(?:افتح|إفتح|شغل|شغّل|ابدأ|ابدا|اطلق|أطلق|اعرض|أعرض)\s+(?:لي\s+)?(مجلد|المجلد|ملف|الملف|فولدر|برنامج|تطبيق|البرنامج|التطبيق)\s/u.exec(text)?.[1] : /^(?:open|launch|start|run|show)\s+(?:me\s+)?(?:the\s+|up\s+)?(app|application|program|folder|directory|file)\s/iu.exec(text)?.[1];
  const app = findKnownApp(target);
  if (app && !/^(?:مجلد|المجلد|ملف|الملف|فولدر|folder|directory|file)$/iu.test(typed ?? '')) return { kind: 'app_launch', name: app.id };
  const folder = knownFolderPath(target);
  if (folder) return { kind: 'open', target: folder };
  if (/^https?:\/\/\S+$/iu.test(target)) return { kind: 'open', target };
  if (looksLikePath(target)) return { kind: 'open', target };
  if (typed && /^(?:مجلد|المجلد|ملف|الملف|فولدر|folder|directory|file)$/iu.test(typed)) return { kind: 'open', target };
  if (typed && /^(?:برنامج|تطبيق|البرنامج|التطبيق|app|application|program)$/iu.test(typed)) return { kind: 'app_launch', name: target };
  return null;
}

function parseSystem(text: string, lang: 'ar' | 'en'): DesktopCommand | null {
  if (lang === 'ar') {
    if (/^(?:ما|ماهي|ما هي|اعرض|أعرض|اعطني|أعطني|ورني|وريني|أرني|ارني|وش|شو|ايش|إيش)\s+(?:لي\s+)?(?:هي\s+)?(?:معلومات|مواصفات|حالة|حاله|تفاصيل|بيانات)\s+(?:ال)?(?:جهاز|جهازي|الكمبيوتر|الحاسوب|النظام|اللابتوب|الجهاز)(?:\s+(?:عندي|لدي|هذا|الحالي))?$/u.test(text) || /^(?:معلومات|مواصفات|حالة|حاله)\s+(?:ال)?(?:جهاز|جهازي|الكمبيوتر|الحاسوب|النظام)$/u.test(text)) return { kind: 'system_info' };
    if (/^(?:كم|ما|ماهي|ما هي)\s+(?:حجم\s+|مقدار\s+|نسبة\s+)?(?:ال)?(?:ذاكرة|الذاكرة|رام|الرام|مساحة|المساحة|المعالج|البطارية|البطاريه)(?:\s+(?:الحرة|الحره|المتاحة|المتاحه|المتبقية|المتبقيه|الفارغة|الفارغه|عندي|لدي|في جهازي|على القرص|بالجهاز))*\s*[؟?]?$/u.test(text)) return { kind: 'system_info' };
    if (/^(?:ما|ماذا|وش|شو|ايش|إيش|اعرض|أعرض|اقرأ|اقرا)\s+(?:لي\s+)?(?:هو\s+)?(?:في|محتوى|محتويات|داخل|نص)\s+(?:ال)?(?:حافظة|الحافظه|كليب بورد)\s*[؟?]?$/u.test(text)) return { kind: 'clipboard_read' };
    const copy = /^(?:انسخ|إنسخ|ضع|حط)\s+([\s\S]+?)\s+(?:إلى|الى|في|ل)\s+(?:ال)?(?:حافظة|الحافظه|كليب بورد)$/u.exec(text);
    if (copy) return { kind: 'clipboard_write', text: unquote(copy[1]!) };
    return null;
  }
  if (/^(?:show|give|what(?:'s| is| are)|tell me|get)\s+(?:me\s+)?(?:the\s+|my\s+)?(?:system|computer|pc|machine|laptop|device|hardware)\s+(?:info|information|specs|specifications|status|details)$/iu.test(text) || /^(?:system|pc|computer)\s+(?:info|specs|status)$/iu.test(text)) return { kind: 'system_info' };
  if (/^how much\s+(?:free\s+)?(?:ram|memory|disk space|disk|space|storage|battery)(?:\s+(?:do i have|is (?:left|free|available)|left|free|available|remaining))?(?:\s+on\s+(?:my\s+)?(?:pc|computer|disk|drive))?\??$/iu.test(text) || /^what(?:'s| is)\s+my\s+(?:cpu|gpu|processor|graphics card|ram|memory|battery(?: level)?)\??$/iu.test(text)) return { kind: 'system_info' };
  if (/^(?:what(?:'s| is)\s+(?:in|on)\s+(?:the\s+|my\s+)?clipboard|show\s+(?:me\s+)?(?:the\s+)?clipboard|read\s+(?:the\s+)?clipboard)\??$/iu.test(text)) return { kind: 'clipboard_read' };
  const copy = /^(?:copy|put|place)\s+([\s\S]+?)\s+(?:to|into|onto|in)\s+(?:the\s+)?clipboard$/iu.exec(text);
  if (copy) return { kind: 'clipboard_write', text: unquote(copy[1]!) };
  return null;
}

const MUTATING = new Set<DesktopCommand['kind']>(['project_create', 'project_open', 'file_create', 'folder_create', 'file_write', 'file_delete', 'open', 'app_launch', 'shell', 'window_focus', 'window_close', 'window_minimize', 'window_maximize', 'type', 'keys', 'click_element', 'click_point', 'clipboard_write']);

/** Parses one request. The order matters: the most specific shapes first, «open X» last. */
export function parseDesktopCommand(request: string): ParsedDesktopCommand | null {
  if (typeof request !== 'string' || request.length > 6000) return null;
  const text = tidyRequest(request);
  if (!text || text.length < 3) return null;
  const lang: 'ar' | 'en' = ARABIC.test(text) ? 'ar' : 'en';
  // Content-bearing shapes keep the owner's punctuation; questions and plain commands lose the trailing «؟» or «.».
  const plain = text.replace(/[\s؟?!.]+$/u, '');
  const keepsContent = new Set<(value: string, language: 'ar' | 'en') => DesktopCommand | null>([parseShell, parseFileCreate, parseFileWrite, parseInput]);
  const parsers = [parseShell, parseProjectCreate, parseFileCreate, parseFileWrite, parseFileDelete, parseFileSearch, parseFileRead, parseFileList, parseProjects, parseWindows, parseScreenshot, parseSystem, parseInput, parseOpen];
  for (const parser of parsers) {
    const command = parser(keepsContent.has(parser) ? text : plain, lang);
    if (command) return { command, lang, mutating: MUTATING.has(command.kind), text };
  }
  return null;
}

/** A short label for the run's step list and audit trail. */
export function describeDesktopCommand(command: DesktopCommand, lang: 'ar' | 'en'): string {
  const ar = lang === 'ar';
  switch (command.kind) {
    case 'project_create': return ar ? `إنشاء مشروع ${command.name ?? 'جديد'}` : `Create project ${command.name ?? '(new)'}`;
    case 'project_list': return ar ? 'عرض المشاريع' : 'List projects';
    case 'project_open': return ar ? `فتح مشروع ${command.name}` : `Open project ${command.name}`;
    case 'file_create': return ar ? `إنشاء ملف ${command.name}` : `Create file ${command.name}`;
    case 'folder_create': return ar ? `إنشاء مجلد ${command.name}` : `Create folder ${command.name}`;
    case 'file_write': return ar ? `الكتابة في ملف ${command.path}` : `Write to file ${command.path}`;
    case 'file_read': return ar ? `قراءة ملف ${command.path}` : `Read file ${command.path}`;
    case 'file_list': return ar ? 'عرض الملفات' : 'List files';
    case 'file_search': return ar ? `البحث عن ${command.pattern}` : `Search for ${command.pattern}`;
    case 'file_delete': return ar ? `حذف ${command.what === 'file' ? 'ملف' : 'مجلد'} ${command.path}` : `Delete ${command.what} ${command.path}`;
    case 'open': return ar ? `فتح ${command.target}` : `Open ${command.target}`;
    case 'app_launch': return ar ? `تشغيل ${command.name}` : `Launch ${command.name}`;
    case 'shell': return ar ? `تنفيذ الأمر: ${command.command.slice(0, 60)}` : `Run command: ${command.command.slice(0, 60)}`;
    case 'window_list': return ar ? 'عرض النوافذ المفتوحة' : 'List open windows';
    case 'window_focus': return ar ? `الانتقال إلى نافذة ${command.target}` : `Focus window ${command.target}`;
    case 'window_close': return ar ? `إغلاق نافذة ${command.target}` : `Close window ${command.target}`;
    case 'window_minimize': return ar ? `تصغير نافذة ${command.target}` : `Minimize window ${command.target}`;
    case 'window_maximize': return ar ? `تكبير نافذة ${command.target}` : `Maximize window ${command.target}`;
    case 'screenshot': return ar ? 'لقطة شاشة' : 'Screenshot';
    case 'type': return ar ? 'كتابة نص على الكمبيوتر' : 'Type text on the computer';
    case 'keys': return ar ? `ضغط ${command.combo}` : `Press ${command.combo}`;
    case 'click_element': return ar ? `النقر على ${command.name}` : `Click ${command.name}`;
    case 'click_point': return ar ? `النقر عند (${command.x}, ${command.y})` : `Click at (${command.x}, ${command.y})`;
    case 'system_info': return ar ? 'معلومات الجهاز' : 'System information';
    case 'clipboard_read': return ar ? 'قراءة الحافظة' : 'Read clipboard';
    case 'clipboard_write': return ar ? 'النسخ إلى الحافظة' : 'Copy to clipboard';
  }
}

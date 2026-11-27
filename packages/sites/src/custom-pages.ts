import type { SiteBrief } from '@mohassan/contracts';
import type { SiteCommand } from './commands.ts';
import { COPY } from './copy/index.ts';
import { isCustomPage } from './families.ts';
import { normalize } from './text.ts';

const DELETE_PAGE = /^(?:احذف|أحذف|ازل|أزل|remove|delete|drop)\s+(?:الصفح[ةه]|صفح[ةه]|(?:the\s+)?page)(?:\s+(.+))?$/iu;
const RENAME_PAGE = /^(?:(?:أعد|اعد)\s+تسمي[ةه]|(?:غيّر|غير|بدّل|بدل)\s+(?:اسم|عنوان)|rename)\s+(?:الصفح[ةه]|صفح[ةه]|(?:the\s+)?page)(?:\s+(.+))?$/iu;
const RENAME_TITLES = /^(«[^»]+»|"[^"]+"|“[^”]+”|‘[^’]+’|'[^']+'|.+?)\s+(?:إلى|الى|to|as)\s+(.+)$/iu;
const PROTECTED_PATHS = ['index.html', 'contact.html'];
const PROTECTED_NAMES = new Set([
  ...PROTECTED_PATHS,
  ...Object.values(COPY).flatMap(({ labels }) => [labels.nav.home, labels.nav.contact]),
  'home page', 'contact us', 'التواصل', 'تواصل معنا', 'اتصل بنا',
].map(normalize));

function unquote(text: string): string {
  return text.trim().replace(/^(?:«(.*)»|"(.*)"|“(.*)”|‘(.*)’|'(.*)')$/u, '$1$2$3$4$5').trim();
}

export function customPageCommand(raw: string, brief: SiteBrief): SiteCommand | null {
  const rename = raw.match(RENAME_PAGE), remove = raw.match(DELETE_PAGE);
  if (!rename && !remove) return null;
  const titles = rename?.[1]?.match(RENAME_TITLES);
  if (rename && !titles) return { kind: 'unknown', summary: 'اكتب اسم الصفحة الحالي والاسم الجديد. مثلاً «غيّر اسم صفحة الشروط إلى شروط الخدمة».' };

  const name = unquote(titles?.[1] ?? remove?.[1] ?? '');
  if (!name) return { kind: 'unknown', summary: 'اكتب اسم الصفحة التي تريد حذفها أو تغيير اسمها.' };
  const normalized = normalize(name);
  const { pages, lang } = brief;
  if (PROTECTED_NAMES.has(normalized) || pages.some(page => PROTECTED_PATHS.includes(page.path) && normalize(page.title) === normalized)) {
    return { kind: 'unknown', summary: lang === 'ar' ? 'لا يمكن حذف الصفحة الرئيسية أو صفحة التواصل أو تغيير اسميهما.' : 'The home and contact pages cannot be deleted or renamed.' };
  }

  const custom = pages.filter(isCustomPage);
  const byPath = custom.find(page => page.path === normalized);
  const matching = byPath ? [byPath] : custom.filter(page => normalize(page.title) === normalized);
  if (!matching.length) return { kind: 'unknown', summary: `لم أجد صفحة مخصّصة باسم «${name}».` };
  if (matching.length > 1) return { kind: 'unknown', summary: `توجد أكثر من صفحة باسم «${name}». استخدم مسار الصفحة لتحديدها.` };

  const page = matching[0]!;
  if (!titles) {
    return { kind: 'patch', patch: { pages: pages.filter(item => item !== page) }, summary: lang === 'ar' ? `حذفت صفحة «${page.title}».` : `Deleted the page "${page.title}".` };
  }

  const title = unquote(titles[2]!).slice(0, 60).trimEnd();
  if (!title) return { kind: 'unknown', summary: 'اكتب الاسم الجديد للصفحة.' };
  const renamed = {
    ...page,
    title,
    blocks: page.blocks.map(block => block.type === 'text' && block.title === page.title ? { ...block, title } : block),
  };
  return { kind: 'patch', patch: { pages: pages.map(item => item === page ? renamed : item) }, summary: lang === 'ar' ? `غيّرت اسم صفحة «${page.title}» إلى «${title}».` : `Renamed the page "${page.title}" to "${title}".` };
}

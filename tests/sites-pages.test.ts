import type { SiteBrief, SiteLang } from '@mohassan/contracts';
import { applyPatch, commandExamples, composeSite, siteCommand, textFiles } from '@mohassan/sites';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, runScenario } from '../packages/sites/fixtures/scenarios.ts';

function base(lang: SiteLang): SiteBrief {
  return runScenario(SCENARIOS.find(scenario => scenario.id === `services-${lang}`)!).brief;
}

function patched(brief: SiteBrief, text: string): SiteBrief {
  const result = siteCommand(text, brief);
  if (result?.kind !== 'patch') throw new Error(`Expected a patch for ${text}, received ${result?.kind}`);
  return applyPatch(brief, result.patch);
}

describe('custom page commands', () => {
  it.each([
    { lang: 'ar', add: 'أضف صفحة الشروط: يُدفع المبلغ بعد تسليم العمل.', keep: 'أضف صفحة الخصوصية: نحفظ بياناتك.', title: 'الشروط', rename: 'غيّر اسم صفحة «الشروط» إلى «العنوان والشروط»', newTitle: 'العنوان والشروط', remove: 'احذف صفحة العنوان والشروط', body: 'يُدفع المبلغ بعد تسليم العمل.' },
    { lang: 'en', add: 'add a page How to Pay: Pay upon delivery.', keep: 'add a page Privacy: Your details stay private.', title: 'How to Pay', rename: 'rename page "How to Pay" to "Payment Terms"', newTitle: 'Payment Terms', remove: 'delete page Payment Terms', body: 'Pay upon delivery.' },
  ] as const)('renames and removes only the requested page and its navigation entry ($lang)', ({ lang, add, keep, title, rename, newTitle, remove, body }) => {
    const brief = patched(patched(base(lang), add), keep);
    const target = brief.pages.find(page => page.title === title)!;
    const otherPages = brief.pages.filter(page => page.path !== target.path);

    const renamed = patched(brief, rename);
    expect(renamed).toEqual({
      ...brief,
      pages: brief.pages.map(page => page.path === target.path ? { ...page, title: newTitle, blocks: [{ type: 'text', title: newTitle, body }] } : page),
    });
    const renamedFiles = textFiles(composeSite(renamed).files);
    const home = renamedFiles.find(file => file.path === 'index.html')!.content;
    expect(home).toContain(`href="${target.path}">${newTitle}</a>`);
    expect(home).not.toContain(`href="${target.path}">${title}</a>`);
    expect(renamedFiles.find(file => file.path === target.path)?.content).toContain(`<h1>${newTitle}</h1>`);

    const deleted = patched(renamed, remove);
    expect(deleted).toEqual({ ...brief, pages: otherPages });
    const deletedFiles = textFiles(composeSite(deleted).files);
    expect(deletedFiles.some(file => file.path === target.path)).toBe(false);
    expect(deletedFiles.find(file => file.path === 'index.html')?.content).not.toContain(`href="${target.path}"`);
  });

  it.each([
    { lang: 'ar', commands: ['احذف صفحة الرئيسية', 'أعد تسمية صفحة الرئيسية إلى البداية', 'احذف صفحة التواصل', 'غيّر اسم صفحة تواصل إلى المساعدة'] },
    { lang: 'en', commands: ['delete page Home', 'rename page Home to Start', 'remove the page Contact', 'rename page "Contact" to "Support"'] },
  ] as const)('protects home and contact in $lang', ({ lang, commands }) => {
    const brief = base(lang);
    for (const command of commands) {
      const result = siteCommand(command, brief);
      expect(result).toEqual({ kind: 'unknown', summary: expect.stringMatching(lang === 'ar' ? /الرئيسية.*التواصل/u : /home and contact/i) });
    }
  });

  it.each([
    ['ar', 'احذف صفحة الشروط', 'الشروط'],
    ['en', 'rename page "Opening Hours" to "Availability"', 'Opening Hours'],
  ] as const)('replies in Arabic to an unknown page in %s', (lang, command, title) => {
    expect(siteCommand(command, base(lang))).toEqual({ kind: 'unknown', summary: `لم أجد صفحة مخصّصة باسم «${title}».` });
  });

  it('asks for a new page title when the rename command is incomplete', () => {
    expect(siteCommand('غيّر اسم صفحة العنوان الجديد', base('ar'))).toEqual({ kind: 'unknown', summary: expect.stringContaining('الاسم الجديد') });
  });

  it('supports custom paths saved directly in a brief', () => {
    const brief = base('en');
    const custom = { path: 'policies.html', title: 'Policies', inNav: true, blocks: [{ type: 'text', title: 'Policies', body: 'Payment is due on delivery.' }] } as const;
    const withCustom = applyPatch(brief, { pages: [...brief.pages, { ...custom, blocks: [...custom.blocks] }] });
    const renamed = patched(withCustom, 'rename page Policies to Terms');
    expect(renamed.pages.at(-1)).toMatchObject({ path: custom.path, title: 'Terms' });
    expect(patched(renamed, `delete page ${custom.path}`)).toEqual(brief);
  });

  it('requires a path when two custom pages have the same title', () => {
    let brief = patched(base('en'), 'add a page Terms: Payment is due when the work is complete.');
    brief = patched(brief, 'add a page Terms: Pay upon delivery.');
    const duplicates = brief.pages.filter(page => page.title === 'Terms');
    expect(duplicates).toHaveLength(2);
    expect(siteCommand('delete page Terms', brief)).toEqual({ kind: 'unknown', summary: expect.stringContaining('استخدم مسار الصفحة') });
    const deleted = patched(brief, `delete page ${duplicates[0]!.path}`);
    expect(deleted.pages).toEqual(brief.pages.filter(page => page.path !== duplicates[0]!.path));
    const added = patched(deleted, 'add a page Privacy: We keep your details private.');
    expect(added.pages).toContainEqual(duplicates[1]);
    expect(new Set(added.pages.map(page => page.path)).size).toBe(added.pages.length);
  });

  it('lists both page edits as examples in both languages', () => {
    const ar = commandExamples('ar');
    const en = commandExamples('en');
    expect(ar).toEqual(expect.arrayContaining([expect.stringMatching(/^غيّر اسم صفحة/u), expect.stringMatching(/^احذف صفحة/u)]));
    expect(en).toEqual(expect.arrayContaining([expect.stringMatching(/^rename page/i), expect.stringMatching(/^delete page/i)]));
  });
});

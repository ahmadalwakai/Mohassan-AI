export interface SelectionBlock {
  kind: 'paragraph' | 'list' | 'table';
  text: string;
  heading?: string;
  cells?: readonly string[];
}

/** The parts of parse5's default tree used by the HTTP reader. */
interface ReadableNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: readonly { name: string; value: string }[];
  childNodes?: readonly ReadableNode[];
}

const excluded = new Set(['aside', 'button', 'figure', 'footer', 'form', 'header', 'nav', 'noscript', 'script', 'style', 'svg', 'template']);
const excludedClass = /(?:^|\s)(?:hatnote|metadata|mw-editsection|navbox|reflist|sidebar|toc)(?:\s|$)/u;
const headingTag = /^h[1-6]$/u;
const looseBlockTag = /^(?:article|blockquote|dd|div|dt|section)$/u;
const structuralTag = /^(?:article|blockquote|dd|div|dl|dt|h[1-6]|li|ol|p|section|table|ul)$/u;
const clean = (text: string) => text.replace(/\s+/gu, ' ').trim();

function ignored(node: ReadableNode): boolean {
  return excluded.has(node.tagName ?? '') || (node.attrs ?? []).some(({ name, value }) => name === 'hidden'
    || name === 'aria-hidden' && value === 'true'
    || name === 'role' && /^(?:navigation|banner|contentinfo)$/u.test(value)
    || name === 'class' && excludedClass.test(value));
}

function inlineText(node: ReadableNode): string {
  if (ignored(node) || node.tagName === 'ul' || node.tagName === 'ol' || node.tagName === 'table') return '';
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(inlineText).join(' ');
}

/** Retain structure from the same parsed document that supplies readableSource's visible text. */
export function collectPageStructure(body: ReadableNode): SelectionBlock[] {
  const blocks: SelectionBlock[] = [];
  let heading: string | undefined;
  let size = 0;
  function visit(node: ReadableNode): void {
    if (size >= 60_000 || blocks.length >= 500 || ignored(node)) return;
    const tag = node.tagName ?? '';
    const looseParagraph = looseBlockTag.test(tag) && !(node.childNodes ?? []).some(child => structuralTag.test(child.tagName ?? ''));
    if (headingTag.test(tag)) {
      heading = clean(inlineText(node)).slice(0, 240) || undefined;
    } else if (tag === 'p' || tag === 'li' || tag === 'tr' || looseParagraph) {
      const cells = tag === 'tr' ? (node.childNodes ?? []).filter(child => child.tagName === 'td' || child.tagName === 'th') : [];
      if (tag === 'tr' && !cells.some(cell => cell.tagName === 'td')) return;
      const values = cells.map(cell => clean(inlineText(cell)));
      // Use the same space separation as the flat reader so table quotations retain their provenance.
      const text = tag === 'tr' ? clean(values.join(' ')) : clean(inlineText(node));
      if (text && text.length <= 60_000 - size) {
        blocks.push({ kind: tag === 'li' ? 'list' : tag === 'tr' ? 'table' : 'paragraph', text, heading,
          ...(tag === 'tr' ? { cells: values } : {}) });
        size += text.length;
      }
      if (tag !== 'li') return;
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(body);
  return blocks;
}

// Structure travels with the actual read page in memory and stays out of persisted browser observations.
const observedStructure = new WeakMap<object, readonly SelectionBlock[]>();

export function rememberPageStructure(page: object, blocks: readonly SelectionBlock[] | undefined): void {
  if (blocks?.length) observedStructure.set(page, blocks);
}

export function pageStructure(page: object): readonly SelectionBlock[] | undefined {
  return observedStructure.get(page);
}

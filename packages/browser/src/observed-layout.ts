export interface ObservedLayoutBlock {
  kind: 'paragraph' | 'list' | 'table';
  text: string;
  heading?: string;
  cells?: readonly string[];
}

/** Serialized into the existing frame observation. Keep this function independent of host-side bindings. */
export function captureObservedLayout(root: HTMLElement | null): ObservedLayoutBlock[] {
  if (!root) return [];
  const blocks: ObservedLayoutBlock[] = [];
  let heading: string | undefined;
  let size = 0;
  for (const node of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,tr,blockquote,dd,dt')) {
    if (size >= 24_000 || blocks.length >= 350) break;
    if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden'
      || node.closest('nav,footer,header,[hidden],[aria-hidden="true"],.mw-editsection,.reflist,.navbox')) continue;
    const tag = node.tagName;
    if (/^H[1-6]$/u.test(tag)) {
      heading = node.innerText.replace(/\s+/gu, ' ').trim().slice(0, 240) || undefined;
      continue;
    }
    const cells = tag === 'TR' ? [...(node as HTMLTableRowElement).cells].filter(cell => cell.getClientRects().length) : [];
    if (tag === 'TR' && !cells.some(cell => cell.tagName === 'TD')) continue;
    const values = cells.map(cell => cell.innerText.replace(/\s+/gu, ' ').trim());
    const text = (values.length ? values.join(' ') : node.innerText).replace(/\s+/gu, ' ').trim();
    if (!text || text.length > 24_000 - size) continue;
    blocks.push({ kind: tag === 'LI' ? 'list' : tag === 'TR' ? 'table' : 'paragraph', text, heading, ...(values.length ? { cells: values } : {}) });
    size += text.length;
  }
  return blocks;
}

// Same visible text as the browser observation, kept in memory with its structure.
const observedLayouts = new WeakMap<object, readonly ObservedLayoutBlock[]>();

export function rememberObservedLayout<Page extends object>(page: Page, blocks: readonly ObservedLayoutBlock[] | undefined): Page {
  if (blocks?.length) observedLayouts.set(page, blocks);
  return page;
}

export function observedLayout(page: object): readonly ObservedLayoutBlock[] | undefined {
  return observedLayouts.get(page);
}

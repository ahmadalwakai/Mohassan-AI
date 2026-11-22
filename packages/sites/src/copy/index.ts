import type { SiteBrief, SiteKind, SiteLang } from '@mohassan/contracts';
import { oneLine } from '../html.ts';
import { pick } from '../seed.ts';
import { ar } from './ar.ts';
import { en } from './en.ts';
import type { Bank, Copy, KindLists, Labels, SentenceList } from './types.ts';

export type { Bank, Copy, Labels } from './types.ts';
export const COPY: Readonly<Record<SiteLang, Copy>> = { ar, en };

export interface Slots { name: string; city?: string; first?: string; item?: string }
const SLOT_PATTERN = /\{(name|city|first|item)\}/g;

/** Sentences whose every slot has a value. */
export function usable(list: SentenceList, slots: Slots): string[] {
  return list.filter(sentence => [...sentence.matchAll(SLOT_PATTERN)].every(match => Boolean(slots[match[1] as keyof Slots])));
}
export function fill(sentence: string, slots: Slots): string {
  return sentence.replace(SLOT_PATTERN, (_, key: keyof Slots) => oneLine(slots[key] ?? ''));
}
function listFor(bank: Bank, key: string, kind: SiteKind): SentenceList {
  const entry = bank[key];
  if (!entry) throw new Error(`copy: unknown key ${key}`);
  if (Array.isArray(entry)) return entry as SentenceList;
  const lists = entry as KindLists;
  return lists[kind] ?? lists.default ?? Object.values(lists).find((list): list is SentenceList => Array.isArray(list)) ?? [];
}

export interface Writer {
  lang: SiteLang;
  labels: Labels;
  /** A filled sentence for a slot key, chosen stably by the site's seed. Raw: escape before use in HTML. */
  text(key: string, extra?: Partial<Slots>): string;
  /** Every usable variant, for tests and for the baseline script. */
  variants(key: string, extra?: Partial<Slots>): string[];
}

export function createWriter(brief: Pick<SiteBrief, 'lang' | 'kind' | 'name' | 'city' | 'items'>, seed: number): Writer {
  const copy = COPY[brief.lang];
  const slots: Slots = { name: brief.name, city: brief.city, first: brief.items[0]?.title };
  const variants = (key: string, extra: Partial<Slots> = {}) => {
    const merged = { ...slots, ...extra };
    const list = usable(listFor(copy.bank, key, brief.kind), merged);
    return list.map(sentence => fill(sentence, merged));
  };
  return {
    lang: brief.lang,
    labels: copy.labels,
    variants,
    text(key, extra = {}) {
      const merged = { ...slots, ...extra };
      const list = usable(listFor(copy.bank, key, brief.kind), merged);
      if (!list.length) return '';
      return fill(pick(seed, key, list), merged);
    },
  };
}

/** Every sentence of every bank, flattened, for the "no digits, no claims" test. */
export function allSentences(): { lang: SiteLang; key: string; sentence: string }[] {
  const out: { lang: SiteLang; key: string; sentence: string }[] = [];
  for (const lang of ['ar', 'en'] as const) {
    const copy = COPY[lang];
    for (const [key, entry] of Object.entries(copy.bank)) {
      const lists = Array.isArray(entry) ? [entry as SentenceList] : Object.values(entry as KindLists).filter((list): list is SentenceList => Array.isArray(list));
      for (const list of lists) for (const sentence of list) out.push({ lang, key, sentence });
    }
    for (const group of Object.values(copy.labels)) {
      if (typeof group === 'string') { out.push({ lang, key: 'labels', sentence: group }); continue; }
      for (const value of Object.values(group as Record<string, string | Record<string, string>>)) {
        if (typeof value === 'string') out.push({ lang, key: 'labels', sentence: value });
        else for (const inner of Object.values(value)) out.push({ lang, key: 'labels', sentence: inner });
      }
    }
  }
  return out;
}

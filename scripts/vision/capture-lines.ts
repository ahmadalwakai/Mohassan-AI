/**
 * Real screenshots with exact text ground truth, for training and measuring the own OCR reader.
 *
 *   npx tsx scripts/vision/capture-lines.ts --out artifacts/vision-real-v1/captures [--concurrency 3] [--generated 150] [--limit-pages N] [--max-minutes 60]
 *
 * For every page and screen it saves <id>.png and <id>.json. The JSON lists every visible
 * character with its box in CSS pixels (read twice, before and after the screenshot, and kept
 * only when both readings agree), the element it belongs to (direction, size, case, and a reason
 * when it must not be trusted), and whether it is on top at its own centre (not covered).
 *
 * Sources: public pages from scripts/vision/real-pages.json and Wikipedia articles listed in the
 * local corpus (robots.txt is honoured, sites that opt out of AI training are skipped, one
 * navigation per site every 4 s), plus pages generated locally from corpus text and rendered by
 * the same browser (no network). The benchmark pages are never captured.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

type Split = 'train' | 'heldout-site' | 'heldout-page';
type Lang = 'ar' | 'en';
interface Seed { url: string; lang: Lang; split: 'train' | 'heldout-site'; follow?: number; capture?: boolean }
interface Task { url: string; lang: Lang; split: Split; follow: number; capture: boolean; generated?: { seed: number } }
interface VariantSpec { name: string; viewport: { width: number; height: number }; dpr: number; scheme: 'light' | 'dark'; mobile: boolean; scrolls: number }

const ROOT = process.cwd();
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const VARIANTS: Record<string, VariantSpec> = {
  desktop: { name: 'desktop', viewport: { width: 1280, height: 900 }, dpr: 1, scheme: 'light', mobile: false, scrolls: 2 },
  mobile: { name: 'mobile', viewport: { width: 390, height: 844 }, dpr: 3, scheme: 'light', mobile: true, scrolls: 1 },
  retinaDark: { name: 'retinaDark', viewport: { width: 1440, height: 900 }, dpr: 2, scheme: 'dark', mobile: false, scrolls: 1 },
};
/** Titles of bot-check and block pages (Cloudflare, Radware, ...): the site does not want automated visits, so the origin is left. */
const BOT_CHECK = /just a moment|لحظة…|attention required|access denied|are you a robot|captcha|verify you are human|security check/iu;
const AI_BOTS = ['gptbot', 'chatgpt-user', 'ccbot', 'google-extended', 'anthropic-ai', 'claudebot', 'claude-web', 'applebot-extended', 'bytespider', 'perplexitybot', 'cohere-ai', 'omgilibot', 'diffbot'];
const FREEZE_CSS = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
const NAV_GAP_MS = 4000;

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const sha = (text: string) => createHash('sha1').update(text).digest('hex');
const hashInt = (text: string) => parseInt(sha(text).slice(0, 8), 16);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function normalUrl(url: string): string { const u = new URL(url); u.hash = ''; return u.toString().replace(/\/$/, ''); }

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T,>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

// ---------------------------------------------------------------- robots.txt

interface RobotsGroup { agents: string[]; rules: { allow: boolean; path: string }[] }
function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null, lastAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastAgent = true;
    } else {
      lastAgent = false;
      if (!current || (key !== 'allow' && key !== 'disallow')) continue;
      if (key === 'disallow' && !value) continue;
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}
function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}
function robotsAllows(groups: RobotsGroup[], agent: string, path: string, explicitOnly = false): boolean {
  let chosen = groups.filter(group => group.agents.includes(agent));
  if (!chosen.length && !explicitOnly) chosen = groups.filter(group => group.agents.includes('*'));
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of chosen.flatMap(group => group.rules)) {
    if (!ruleMatches(rule.path, path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}
const robotsCache = new Map<string, Promise<{ groups: RobotsGroup[] | null; status: string }>>();
function robotsFor(origin: string) {
  let pending = robotsCache.get(origin);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
        if (response.status >= 500) return { groups: null, status: `robots ${response.status}` };
        if (response.status >= 400) return { groups: [], status: `robots ${response.status} (none)` };
        return { groups: parseRobots(await response.text()), status: 'robots ok' };
      } catch (error) {
        return { groups: null, status: `robots unreachable: ${(error as Error).message.slice(0, 80)}` };
      }
    })();
    robotsCache.set(origin, pending);
  }
  return pending;
}
async function permission(url: string): Promise<{ ok: boolean; reason: string }> {
  const u = new URL(url);
  const robots = await robotsFor(u.origin);
  if (!robots.groups) return { ok: false, reason: robots.status };
  const optOut = AI_BOTS.find(bot => !robotsAllows(robots.groups!, bot, '/', true) && !robotsAllows(robots.groups!, bot, '/a/b-c', true));
  if (optOut) return { ok: false, reason: `ai-opt-out (${optOut})` };
  if (!robotsAllows(robots.groups, '*', u.pathname + u.search)) return { ok: false, reason: 'robots disallow' };
  return { ok: true, reason: robots.status };
}

// ---------------------------------------------------------------- in-page extraction (plain JS, sent as a string)

const EXTRACT = String.raw`(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const ICON = /icon|material|awesome|glyph|symbol|fontello|icomoon|dashicons|remixicon|feather|ionicons/i;
  const info = new Map(), elements = [], chars = [];
  const alpha = (value) => { if (!value || value === 'transparent') return value === 'transparent' ? 0 : 1; const m = /rgba?\(([^)]*)\)/.exec(value); if (!m) return 1; const parts = m[1].split(/[\s,\/]+/).filter(Boolean); if (parts.length < 4) return 1; const a = parts[3]; return a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a); };
  const styleOf = (el) => {
    let index = info.get(el);
    if (index !== undefined) return index;
    const s = getComputedStyle(el);
    let skip = '';
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) skip = 'hidden';
    else if (ICON.test(s.fontFamily)) skip = 'icon-font';
    else if (s.textTransform === 'capitalize' || s.textTransform === 'full-width') skip = 'transform';
    else if (!(s.writingMode || 'horizontal-tb').startsWith('horizontal')) skip = 'vertical';
    else if (parseFloat(s.fontSize) < 6) skip = 'tiny';
    else if (alpha(s.color) < 0.3 || alpha(s.webkitTextFillColor) < 0.3) skip = 'faint';
    else if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) skip = 'ellipsis';
    else if (s.transform && s.transform !== 'none' && !/^matrix\(1, 0, 0, 1,/.test(s.transform)) skip = 'transformed';
    index = elements.length;
    elements.push([s.direction === 'rtl' ? 1 : 0, parseFloat(s.fontSize) || 0, s.textTransform === 'uppercase' ? 1 : s.textTransform === 'lowercase' ? 2 : 0, skip, s.fontFamily.slice(0, 60), s.fontWeight]);
    info.set(el, index);
    return index;
  };
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node, nodeIndex = -1;
  while ((node = walker.nextNode())) {
    nodeIndex++;
    const text = node.data;
    const el = node.parentElement;
    if (!text || !el) continue;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'TEXTAREA' || tag === 'OPTION' || tag === 'TITLE') continue;
    range.selectNodeContents(node);
    let inView = false;
    for (const b of range.getClientRects()) if (b.width > 0 && b.height > 0 && b.right > 0 && b.left < vw && b.bottom > 0 && b.top < vh) { inView = true; break; }
    if (!inView) continue;
    const e = styleOf(el);
    for (let i = 0; i < text.length; i++) {
      const start = i, code = text.charCodeAt(i);
      const end = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? i + 2 : i + 1;
      i = end - 1;
      if (start > 99999) break;
      range.setStart(node, start); range.setEnd(node, end);
      const rects = range.getClientRects();
      if (rects.length !== 1) continue;
      const r = rects[0];
      if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh) continue;
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      const visible = hit && (hit === el || el.contains(hit) || hit.contains(el)) ? 1 : 0;
      chars.push([nodeIndex, start, text.slice(start, end), Math.round(r.left * 100) / 100, Math.round(r.top * 100) / 100, Math.round(r.right * 100) / 100, Math.round(r.bottom * 100) / 100, e, visible]);
    }
  }
  return { vw, vh, dpr: window.devicePixelRatio, scrollY: Math.round(window.scrollY), title: document.title.slice(0, 200), lang: document.documentElement.lang || '', chars, elements };
})()`;

const LINKS = String.raw`(() => {
  const out = new Set();
  const bad = /login|signin|sign-in|register|account|search|\/tag|\/tags|author|video|live|subscribe|privacy|terms|contact|about|cookie|newsletter|podcast|\/shop\/cart|javascript:|mailto:|tel:/i;
  for (const a of document.querySelectorAll('a[href]')) {
    let u; try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
    if (u.origin !== location.origin) continue;
    u.hash = ''; u.search = '';
    const path = u.pathname;
    if (bad.test(path) || path.length < 12) continue;
    if (!(/\d/.test(path) || path.split('/').filter(Boolean).length >= 2)) continue;
    if ((a.textContent || '').trim().length < 12) continue;
    out.add(u.toString());
    if (out.size >= 80) break;
  }
  return [...out];
})()`;

// ---------------------------------------------------------------- locally generated pages

const AR_FONTS = ['Arial', 'Tahoma', 'Segoe UI', 'Calibri', 'Times New Roman', 'Sakkal Majalla', 'Simplified Arabic', 'Traditional Arabic', 'Arabic Typesetting', 'Microsoft Sans Serif', 'Courier New'];
const EN_FONTS = ['Arial', 'Segoe UI', 'Calibri', 'Cambria', 'Verdana', 'Tahoma', 'Times New Roman', 'Consolas', 'Courier New', 'Candara', 'Constantia', 'Palatino Linotype', 'Bahnschrift', 'Franklin Gothic Medium', 'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Ebrima', 'Gadugi'];
// Never bold: Traditional Arabic Bold is a held-out font. Never light weights: Calibri Light is held out.
const NO_BOLD = new Set(['Traditional Arabic']);
const ALLOWED_TEXT = /^[\x20-\x7Eء-غف-ي٠-٩،؛؟٪«»©®°±×÷–—‘’“”…•€£¥§¢]+$/;

async function sampleLines(path: string, bytes: number, keep: (line: string) => boolean, limit: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf-8').split(/\r?\n/).slice(1, -1).map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line.length >= 12 && line.length <= 300 && ALLOWED_TEXT.test(line) && keep(line));
    return lines.slice(0, limit);
  } finally { await handle.close(); }
}

function escapeHtml(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function generatedHtml(seed: number, lang: Lang, corpus: Record<Lang, string[]>): { html: string; font: string } {
  const rng = mulberry32(seed);
  const rtl = lang === 'ar';
  const font = pick(rng, rtl ? AR_FONTS : EN_FONTS);
  const bold = NO_BOLD.has(font) ? 400 : pick(rng, [600, 700]);
  const dark = rng() < 0.3;
  const bg = dark ? pick(rng, ['#0f1115', '#1b1d22', '#202124', '#111827']) : pick(rng, ['#ffffff', '#f7f7f8', '#fafaf7', '#f3f4f6']);
  const ink = dark ? pick(rng, ['#e8e8e8', '#f1f5f9', '#d1d5db']) : pick(rng, ['#111111', '#1f2937', '#222222', '#333333']);
  const muted = dark ? pick(rng, ['#9ca3af', '#a1a1aa']) : pick(rng, ['#6b7280', '#666666', '#757575']);
  const accent = pick(rng, ['#1a56db', '#047857', '#b91c1c', '#7c3aed', '#c2410c', '#0e7490', '#be185d']);
  const card = dark ? pick(rng, ['#1f2329', '#2a2d33']) : pick(rng, ['#ffffff', '#f9fafb', '#eef2f7']);
  const words = (min: number, max: number) => {
    const all = pick(rng, corpus[lang]).split(' ');
    const count = Math.min(all.length, min + Math.floor(rng() * (max - min + 1)));
    const start = Math.floor(rng() * Math.max(1, all.length - count + 1));
    return all.slice(start, start + count).join(' ');
  };
  const price = () => rtl ? `${(rng() * 9000 + 5).toFixed(pick(rng, [0, 2]))} ${pick(rng, ['ريال', 'ر.س', 'درهم', 'جنيه', 'دينار'])}` : `${pick(rng, ['$', '€', '£', 'USD '])}${(rng() * 9000 + 5).toFixed(2)}`;
  const date = () => { const d = 1 + Math.floor(rng() * 28), m = 1 + Math.floor(rng() * 12), y = 2018 + Math.floor(rng() * 9); return pick(rng, [`${d}/${m}/${y}`, `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`]); };
  const mixed = (text: string) => rtl && rng() < 0.25 ? `${text} ${pick(rng, ['iPhone 15', 'Samsung', 'Google', 'PDF', 'Wi-Fi', '5G', 'USB-C', 'WhatsApp', 'YouTube'])}` : text;
  const size = (base: number, spread: number) => Math.round(base + rng() * spread);
  const t = (text: string, px: number, weight = 400, color = ink) => `<span style="font-size:${px}px;font-weight:${weight};color:${color}">${escapeHtml(text)}</span>`;
  const parts: string[] = [];
  const headerBg = rng() < 0.5 ? accent : card;
  const navInk = headerBg === accent ? '#ffffff' : ink;
  const nav = Array.from({ length: 4 + Math.floor(rng() * 4) }, () => t(words(1, 2), size(13, 4), 400, navInk)).join('<i style="display:inline-block;width:22px"></i>');
  parts.push(`<header style="background:${headerBg};padding:14px 28px;display:flex;gap:28px;align-items:center">${t(words(1, 2), size(18, 10), bold, headerBg === accent ? '#ffffff' : ink)}<nav>${nav}</nav></header>`);
  const sections: string[] = [];
  sections.push(`<section style="padding:22px 28px"><h1 style="margin:0 0 10px">${t(mixed(words(3, 8)), size(24, 16), bold)}</h1><p style="margin:0;max-width:820px;line-height:${(1.4 + rng() * 0.5).toFixed(2)}">${t(words(14, 30), size(14, 5))}</p></section>`);
  const columns = 2 + Math.floor(rng() * 3);
  const cards = Array.from({ length: columns * (1 + Math.floor(rng() * 2)) }, () => `<article style="background:${card};border-radius:10px;padding:14px">${t(mixed(words(3, 7)), size(15, 5), bold)}<p style="margin:8px 0;line-height:1.5">${t(words(8, 18), size(13, 3), 400, rng() < 0.5 ? ink : muted)}</p>${t(rng() < 0.5 ? date() : price(), size(11, 3), 400, muted)}</article>`).join('');
  sections.push(`<section style="padding:6px 28px;display:grid;grid-template-columns:repeat(${columns},1fr);gap:16px">${cards}</section>`);
  if (rng() < 0.6) {
    const rows = Array.from({ length: 3 + Math.floor(rng() * 5) }, () => `<tr>${[words(1, 3), price(), date(), String(Math.floor(rng() * 999))].map(cell => `<td style="padding:6px 12px;border-bottom:1px solid ${muted}">${t(cell, size(13, 3))}</td>`).join('')}</tr>`).join('');
    sections.push(`<section style="padding:12px 28px"><table style="border-collapse:collapse">${rows}</table></section>`);
  }
  if (rng() < 0.5) {
    const items = Array.from({ length: 3 + Math.floor(rng() * 4) }, () => `<li style="margin:4px 0">${t(`• ${words(3, 9)}`, size(13, 4))}</li>`).join('');
    sections.push(`<section style="padding:8px 28px"><ul style="list-style:none;margin:0;padding:0">${items}</ul></section>`);
  }
  if (rng() < 0.6) {
    const buttons = Array.from({ length: 2 + Math.floor(rng() * 3) }, () => { const filled = rng() < 0.6; return `<span style="display:inline-block;margin:0 8px 8px 0;padding:8px 16px;border-radius:8px;background:${filled ? accent : card}">${t(words(1, 3), size(13, 3), NO_BOLD.has(font) ? 400 : 600, filled ? '#ffffff' : ink)}</span>`; }).join('');
    sections.push(`<section style="padding:8px 28px">${buttons}</section>`);
  }
  for (let i = sections.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [sections[i], sections[j]] = [sections[j], sections[i]]; }
  parts.push(...sections);
  parts.push(`<footer style="padding:18px 28px;margin-top:12px;border-top:1px solid ${muted}">${t(`${words(3, 8)} © ${2015 + Math.floor(rng() * 11)}`, size(11, 3), 400, muted)}</footer>`);
  const html = `<!doctype html><html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>html,body{margin:0;background:${bg};font-family:'${font}'}p,h1{margin:0}</style></head><body>${parts.join('')}</body></html>`;
  return { html, font };
}

// ---------------------------------------------------------------- capture

interface Shot { id: string; url: string; variant: string; scroll: number; chars: number; inconsistent: number; split: Split; lang: Lang; site: string; error?: string }

function consistent(first: any, second: any): { chars: unknown[]; dropped: number } {
  const key = (c: any[]) => `${c[2]}|${Math.round(c[3] * 2)}|${Math.round(c[4] * 2)}|${Math.round(c[5] * 2)}|${Math.round(c[6] * 2)}|${c[8]}`;
  const later = new Set<string>(second.chars.map(key));
  const kept = first.chars.filter((c: any[]) => later.has(key(c)));
  return { chars: kept, dropped: first.chars.length - kept.length };
}

async function capture(page: Page, task: Task, variant: VariantSpec, out: string, shots: Shot[], extra: Record<string, unknown>): Promise<void> {
  let lastScroll = -1;
  for (let scroll = 0; scroll < variant.scrolls; scroll++) {
    if (scroll > 0) { await page.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.85))'); await page.waitForTimeout(1500); }
    await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => undefined);
    const first = await page.evaluate(EXTRACT) as any;
    if (first.scrollY === lastScroll) break;
    lastScroll = first.scrollY;
    const png = await page.screenshot({ type: 'png' });
    const second = await page.evaluate(EXTRACT) as any;
    const { chars, dropped } = consistent(first, second);
    const id = sha(`${task.url}|${variant.name}|${scroll}`).slice(0, 16);
    const site = task.generated ? 'generated' : new URL(task.url).hostname.replace(/^www\./, '');
    await writeFile(join(out, `${id}.png`), png);
    await writeFile(join(out, `${id}.json`), JSON.stringify({ id, url: task.url, site, lang: task.lang, split: task.split, variant: variant.name, dpr: variant.dpr, scheme: variant.scheme,
      viewport: [variant.viewport.width, variant.viewport.height], mobile: variant.mobile, scroll, scrollY: first.scrollY, png: `${id}.png`, title: first.title, pageLang: first.lang,
      capturedAt: new Date().toISOString(), inconsistent: dropped, elements: first.elements, chars, ...extra }));
    shots.push({ id, url: task.url, variant: variant.name, scroll, chars: chars.length, inconsistent: dropped, split: task.split, lang: task.lang, site });
  }
}

async function main() {
  const out = arg('--out', join('artifacts', 'vision-real-v1', 'captures'))!;
  const concurrency = Number(arg('--concurrency', '3'));
  const generatedCount = Number(arg('--generated', '150'));
  const limitPages = Number(arg('--limit-pages', '0'));
  const deadline = Date.now() + Number(arg('--max-minutes', '60')) * 60_000;
  await mkdir(out, { recursive: true });
  const config = JSON.parse(await readFile(arg('--seeds', join('scripts', 'vision', 'real-pages.json'))!, 'utf-8'));
  const benchmark = JSON.parse(await readFile(join('artifacts', 'vision-ocr-v1', 'real', 'manifest.json'), 'utf-8')).pages.map((page: { url: string }) => normalUrl(page.url));
  const excluded = new Set<string>(benchmark);

  // Seeds grouped by origin; Wikipedia articles come from the local corpus listings.
  const groups = new Map<string, Task[]>();
  const add = (task: Task) => { if (excluded.has(normalUrl(task.url)) && task.capture) return; const origin = task.generated ? `generated-${task.generated.seed % concurrency}` : new URL(task.url).origin; const list = groups.get(origin) ?? []; list.push(task); groups.set(origin, list); };
  const pageSplit = (url: string, split: 'train' | 'heldout-site'): Split => split === 'heldout-site' ? split : hashInt(normalUrl(url)) % 100 < 12 ? 'heldout-page' : 'train';
  if (!flag('--only-generated')) {
    for (const seed of config.seeds as Seed[]) add({ url: seed.url, lang: seed.lang, split: pageSplit(seed.url, seed.split), follow: seed.follow ?? 0, capture: seed.capture !== false });
    const wiki = async (file: string, count: number, host: (url: string) => string, lang: Lang) => {
      const lines = (await readFile(file, 'utf-8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { url: string });
      const rng = mulberry32(hashInt(file));
      for (let i = lines.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [lines[i], lines[j]] = [lines[j], lines[i]]; }
      let taken = 0;
      for (const doc of lines) { if (taken >= count) break; const url = host(doc.url); if (excluded.has(normalUrl(url))) continue; add({ url, lang, split: pageSplit(url, 'train'), follow: 0, capture: true }); taken++; }
    };
    const docs = join('artifacts', 'corpora', 'arabic-foundation-v1');
    await wiki(join(docs, 'ar.train.documents.jsonl'), config.wikipedia.ar, url => url, 'ar');
    await wiki(join(docs, 'en.train.documents.jsonl'), config.wikipedia.simple, url => url, 'en');
    await wiki(join(docs, 'en.validation.documents.jsonl'), config.wikipedia.en, url => url.replace('://simple.wikipedia.org/', '://en.wikipedia.org/'), 'en');
  }
  const corpus: Record<Lang, string[]> = { ar: [], en: [] };
  if (generatedCount > 0) {
    const arabicShare = (line: string) => { const letters = line.match(/\p{L}/gu) ?? []; return letters.length ? letters.filter(c => /[؀-ۿ]/u.test(c)).length / letters.length : 0; };
    corpus.ar = await sampleLines(join('artifacts', 'corpora', 'lexicon-text', 'ar.txt'), 12_000_000, line => arabicShare(line) >= 0.8, 20000);
    corpus.en = await sampleLines(join('artifacts', 'corpora', 'lexicon-text', 'en.txt'), 12_000_000, line => arabicShare(line) === 0 && !/^(extracted-date|description):/i.test(line), 20000);
    for (let i = 0; i < generatedCount; i++) add({ url: `generated:${i}`, lang: i % 5 < 3 ? 'ar' : 'en', split: 'train', follow: 0, capture: true, generated: { seed: 9000 + i } });
  }
  console.log(`groups ${groups.size}, tasks ${[...groups.values()].reduce((sum, list) => sum + list.length, 0)}; corpus lines ar ${corpus.ar.length} en ${corpus.en.length}`);

  const browser: Browser = await chromium.launch({ headless: true });
  const shots: Shot[] = [], skipped: { url: string; reason: string }[] = [];
  const visited = new Set<string>();
  let pagesDone = 0;
  const queue = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  let nextGroup = 0;
  const worker = async (index: number) => {
    while (nextGroup < queue.length) {
      const [origin, tasks] = queue[nextGroup++];
      const contexts = new Map<string, BrowserContext>();
      let lastNav = 0, stopOrigin = false;
      try {
        for (let t = 0; t < tasks.length; t++) {
          const task = tasks[t];
          if (Date.now() > deadline || (limitPages && pagesDone >= limitPages)) break;
          const key = normalUrl(task.url);
          if (visited.has(key)) continue;
          visited.add(key);
          if (!task.generated) {
            const allowed = await permission(task.url);
            if (!allowed.ok) { skipped.push({ url: task.url, reason: allowed.reason }); console.log(`[${index}] skip ${task.url}: ${allowed.reason}`); if (/ai-opt-out|unreachable|robots 5/.test(allowed.reason)) break; continue; }
          }
          const h = hashInt(key);
          const names = task.capture ? ['desktop', ...(h % 3 === 0 ? ['mobile'] : []), ...(h % 4 === 1 ? ['retinaDark'] : [])] : ['desktop'];
          for (const name of names) {
            const variant = VARIANTS[name];
            const contextKey = `${name}|${task.lang}`;
            let context = contexts.get(contextKey);
            if (!context) {
              context = await browser.newContext({ viewport: variant.viewport, deviceScaleFactor: variant.dpr, colorScheme: variant.scheme, isMobile: variant.mobile, hasTouch: variant.mobile,
                locale: task.lang === 'ar' ? 'ar-SA' : 'en-US', ...(variant.mobile ? { userAgent: IPHONE_UA } : {}) });
              contexts.set(contextKey, context);
            }
            const page = await context.newPage();
            try {
              let extra: Record<string, unknown> = {};
              if (task.generated) {
                const made = generatedHtml(task.generated.seed, task.lang, corpus);
                await page.setContent(made.html, { waitUntil: 'load' });
                extra = { generated: true, font: made.font };
              } else {
                const wait = lastNav + NAV_GAP_MS - Date.now();
                if (wait > 0) await sleep(wait);
                lastNav = Date.now();
                await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
              }
              await page.addStyleTag({ content: FREEZE_CSS }).catch(() => undefined);
              await page.waitForTimeout(task.generated ? 300 : 1500);
              if (!task.generated && BOT_CHECK.test(await page.title().catch(() => ''))) {
                skipped.push({ url: task.url, reason: 'bot-check page' });
                console.log(`[${index}] skip ${task.url}: bot-check page`);
                stopOrigin = true;
                break;
              }
              if (task.capture) await capture(page, task, variant, out, shots, extra);
              if (name === 'desktop' && task.follow > 0) {
                const links = (await page.evaluate(LINKS) as string[]).filter(link => !visited.has(normalUrl(link)) && !excluded.has(normalUrl(link)));
                const rng = mulberry32(h);
                for (let i = links.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [links[i], links[j]] = [links[j], links[i]]; }
                const baseSplit: 'train' | 'heldout-site' = task.split === 'heldout-site' ? 'heldout-site' : 'train';
                for (const link of links.slice(0, task.follow)) tasks.push({ url: link, lang: task.lang, split: pageSplit(link, baseSplit), follow: 0, capture: true });
              }
            } catch (error) {
              skipped.push({ url: task.url, reason: `${name}: ${(error as Error).message.split('\n')[0].slice(0, 160)}` });
              console.log(`[${index}] fail ${task.url} (${name}): ${(error as Error).message.split('\n')[0].slice(0, 120)}`);
            } finally {
              await page.close().catch(() => undefined);
            }
          }
          pagesDone++;
          if (pagesDone % 10 === 0) console.log(`pages ${pagesDone}, screenshots ${shots.length}, skipped ${skipped.length}`);
          if (stopOrigin) { console.log(`[${index}] leaving ${origin}: bot-check page`); break; }
        }
      } finally {
        for (const context of contexts.values()) await context.close().catch(() => undefined);
      }
      console.log(`[${index}] finished ${origin}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
  await browser.close();
  const bySplit = shots.reduce<Record<string, number>>((acc, shot) => { acc[shot.split] = (acc[shot.split] ?? 0) + 1; return acc; }, {});
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), screenshots: shots.length, bySplit, excluded: [...excluded], shots, skipped }, null, 1), 'utf-8');
  console.log(`done: ${shots.length} screenshots`, bySplit, `skipped ${skipped.length}`);
}

main().catch(error => { console.error(error); process.exit(1); });

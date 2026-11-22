import type { SiteLang } from '@mohassan/contracts';
import type { Theme } from './theme.ts';

const FONTS: Readonly<Record<SiteLang, string>> = {
  ar: `system-ui, -apple-system, "Segoe UI", "Noto Sans Arabic", "Noto Naskh Arabic", Tahoma, Arial, sans-serif`,
  en: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
};

/** Whitespace and comments out, quoted strings untouched. Enough for a stylesheet we wrote ourselves. */
export function minifyCss(css: string): string {
  const out: string[] = [];
  const pieces = css.replace(/\/\*[\s\S]*?\*\//g, '').split(/("[^"]*")/);
  for (const [index, piece] of pieces.entries()) {
    if (index % 2 === 1) { out.push(piece); continue; }
    out.push(piece.replace(/\s+/g, ' ').replace(/\s*([{};:,>])\s*/g, '$1').replace(/;}/g, '}'));
  }
  return out.join('').trim();
}

interface Part { blocks?: readonly string[]; css: string }

/**
 * One stylesheet per site, built from the theme tokens. Logical properties keep RTL and LTR identical;
 * there are no inline styles anywhere, so the page CSP can forbid them. Rules for blocks the site does
 * not use are left out, then everything is minified.
 */
export function stylesheet(theme: Theme, lang: SiteLang, used?: ReadonlySet<string>): string {
  const s = theme.scale;
  const size = (step: number) => `${(1 * s ** step).toFixed(3)}rem`;
  const parts: Part[] = [
    { css: `:root {
  --c-primary: ${theme.primary}; --c-primary-ink: ${theme.primaryInk}; --c-primary-deep: ${theme.primaryDeep}; --c-primary-soft: ${theme.primarySoft}; --c-primary-soft-ink: ${theme.primarySoftInk};
  --c-accent: ${theme.accent}; --c-accent-ink: ${theme.accentInk}; --c-ink: ${theme.ink}; --c-muted: ${theme.muted}; --c-surface: ${theme.surface}; --c-surface-alt: ${theme.surfaceAlt}; --c-line: ${theme.line};
  --c-hero: ${theme.heroBg}; --c-hero-ink: ${theme.heroInk}; --c-hero-muted: ${theme.heroMuted};
  --radius: ${theme.radius}; --radius-sm: ${theme.radiusSmall}; --font: ${FONTS[lang]}; --w-heading: ${theme.headingWeight};
  --fs-1: clamp(${size(3)}, 2.2vw + 1.2rem, ${size(5)}); --fs-2: clamp(${size(2)}, 1.2vw + 1rem, ${size(3)}); --fs-3: ${size(1)}; --fs-lead: ${size(0.5)};
  --space: clamp(3rem, 6vw, 5.5rem); --container: 1120px; --shadow: 0 10px 30px -18px rgba(0, 0, 0, 0.25);
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; font-family: var(--font); font-size: 1.0625rem; line-height: 1.65; color: var(--c-ink); background: var(--c-surface); overflow-wrap: anywhere; }
img, svg { display: block; max-width: 100%; }
img { height: auto; }
a { color: var(--c-primary-deep); text-decoration-thickness: 1px; text-underline-offset: 0.15em; }
a:hover { text-decoration-thickness: 2px; }
h1, h2, h3 { margin: 0 0 0.5rem; line-height: 1.2; font-weight: var(--w-heading); letter-spacing: ${theme.mood === 'bold' ? '-0.015em' : '0'}; text-wrap: balance; }
h1 { font-size: var(--fs-1); }
h2 { font-size: var(--fs-2); }
h3 { font-size: var(--fs-3); }
p { margin: 0 0 1rem; }
ul, ol { margin: 0; padding: 0; }
.container { width: min(100% - 2rem, var(--container)); margin-inline: auto; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; inset-inline-start: 1rem; top: -4rem; padding: 0.5rem 1rem; background: var(--c-primary-deep); color: #fff; border-radius: var(--radius-sm); z-index: 100; }
.skip-link:focus { top: 1rem; }
:focus-visible { outline: 3px solid var(--c-accent); outline-offset: 3px; }
.btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.8rem 1.35rem; border-radius: var(--radius-sm); font-weight: 600; text-decoration: none; border: 2px solid transparent; transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease; min-height: 44px; }
.btn:hover { transform: translateY(-1px); }
.btn-primary { background: var(--c-primary-deep); color: #fff; box-shadow: var(--shadow); }
.btn-primary:hover { background: var(--c-primary); color: var(--c-primary-ink); }
.btn-ghost { background: transparent; color: var(--c-primary-deep); border-color: currentColor; }
.btn-ghost:hover { background: var(--c-primary-soft); }
.btn-small { padding: 0.45rem 0.9rem; font-size: 0.9rem; background: var(--c-primary-soft); color: var(--c-primary-soft-ink); min-height: 36px; }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
.price { font-weight: 700; color: var(--c-primary-deep); white-space: nowrap; }
.card-icon { display: inline-flex; align-items: center; justify-content: center; width: 52px; height: 52px; border-radius: var(--radius-sm); background: var(--c-primary-soft); color: var(--c-primary-soft-ink); flex: none; }
.site-header { position: sticky; top: 0; z-index: 50; background: color-mix(in srgb, var(--c-surface) 92%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--c-line); }
.header-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 72px; }
.brand { display: inline-flex; align-items: center; gap: 0.7rem; text-decoration: none; color: var(--c-ink); }
.brand-mark { width: 40px; height: 40px; border-radius: 12px; }
.brand-name { font-weight: 800; font-size: 1.15rem; }
.site-nav { display: flex; align-items: center; gap: 1.25rem; }
.site-nav ul { display: flex; gap: 0.25rem; list-style: none; }
.site-nav li a { display: inline-block; padding: 0.55rem 0.8rem; border-radius: var(--radius-sm); color: var(--c-ink); text-decoration: none; font-weight: 600; }
.site-nav li a:hover, .site-nav li a[aria-current="page"] { background: var(--c-surface-alt); color: var(--c-primary-deep); }
.nav-toggle { display: none; background: none; border: 1px solid var(--c-line); border-radius: var(--radius-sm); padding: 0.5rem; color: var(--c-ink); cursor: pointer; min-width: 44px; min-height: 44px; }
.nav-toggle .icon-close { display: none; }
.nav-open .nav-toggle .icon-open { display: none; }
.nav-open .nav-toggle .icon-close { display: block; }
.hero { padding-block: var(--space); background: var(--c-hero); color: var(--c-hero-ink); position: relative; overflow: hidden; }
.hero::before { content: ""; position: absolute; inset: 0; background-image: url("assets/pattern.svg"); opacity: ${theme.mood === 'calm' ? '0.5' : '0.8'}; pointer-events: none; mask-image: linear-gradient(to bottom, rgba(0,0,0,0.9), transparent); }
.hero > .container { position: relative; }
.hero-grid { display: grid; gap: 2.5rem; align-items: center; }
.hero-text .eyebrow { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--c-hero-muted); font-weight: 600; margin-bottom: 0.75rem; }
.hero-lead { font-size: var(--fs-lead); color: var(--c-hero-muted); max-width: 38rem; }
.hero-art { max-width: 420px; margin-inline: auto; width: 100%; filter: drop-shadow(0 24px 40px rgba(0, 0, 0, 0.18)); }
.hero-img { border-radius: var(--radius); box-shadow: var(--shadow); object-fit: cover; aspect-ratio: 4 / 3; width: 100%; }
.hero-centered { text-align: center; }
.hero-centered .hero-text { max-width: 44rem; margin-inline: auto; }
.hero-centered .actions, .hero-centered .eyebrow { justify-content: center; }
.hero-centered .hero-lead { margin-inline: auto; }
.hero-cover .hero-art { filter: drop-shadow(0 24px 40px rgba(0, 0, 0, 0.4)); }
.hero-cover .btn-ghost { color: var(--c-hero-ink); }
.hero-cover .btn-ghost:hover { background: rgba(255, 255, 255, 0.12); }
.hero-small { padding-block: calc(var(--space) * 0.55); background: var(--c-surface-alt); color: var(--c-ink); }
.hero-small::before { opacity: 0.35; }
.hero-small h1 { font-size: var(--fs-2); margin: 0; }
.notfound { padding-block: var(--space); text-align: center; }
.notfound .actions { justify-content: center; }
.section { padding-block: var(--space); }
.section + .section { padding-top: 0; }
.section-head { max-width: 40rem; margin-bottom: 2rem; }
.lead { color: var(--c-muted); font-size: var(--fs-lead); }
.more { margin-top: 2rem; }
.prose p { margin-bottom: 1rem; }
.prose p:last-child { margin-bottom: 0; }
.site-footer { border-top: 1px solid var(--c-line); padding-block: 2.5rem; background: var(--c-surface-alt); color: var(--c-muted); }
.footer-grid { display: grid; gap: 1.5rem; align-items: start; }
.site-footer .brand-name { color: var(--c-ink); display: block; margin-bottom: 0.4rem; }
.site-footer ul { list-style: none; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
.site-footer a { color: var(--c-ink); text-decoration: none; }
.site-footer a:hover { text-decoration: underline; }
.footer-line { margin: 0; }
.rights { margin: 0; font-size: 0.95rem; }
.cards, .tiles, .people, .plans, .quotes, .posts, .gallery-grid { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
.card, .tile, .person, .plan, .quote, .post, .contact-card, .hours-card, .map-card { background: var(--c-surface); border: 1px solid var(--c-line); border-radius: var(--radius); box-shadow: var(--shadow); }
` },
    { blocks: ['items'], css: `
.card { padding: 1.5rem; display: flex; flex-direction: column; gap: 0.5rem; }
.card p { color: var(--c-muted); margin: 0; }
.card .card-icon { margin-bottom: 0.5rem; }
.card-img { border-radius: var(--radius-sm); aspect-ratio: 4 / 3; object-fit: cover; width: 100%; margin-bottom: 0.5rem; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: auto; padding-top: 0.75rem; }
.menu-list { list-style: none; display: grid; gap: 0; border: 1px solid var(--c-line); border-radius: var(--radius); background: var(--c-surface); overflow: hidden; }
.menu-row { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 1.1rem 1.4rem; }
.menu-row + .menu-row { border-top: 1px dashed var(--c-line); }
.menu-row h3 { margin: 0; font-size: 1.05rem; }
.menu-row p { margin: 0.2rem 0 0; color: var(--c-muted); font-size: 0.95rem; }
.menu-price { font-weight: 700; color: var(--c-primary-deep); white-space: nowrap; }
.list-rows { list-style: none; display: grid; gap: 0.75rem; }
.list-row { display: flex; align-items: flex-start; gap: 1rem; padding: 1rem 1.25rem; background: var(--c-surface); border: 1px solid var(--c-line); border-radius: var(--radius); }
.list-icon { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--radius-sm); background: var(--c-primary-soft); color: var(--c-primary-soft-ink); flex: none; }
.list-row h3 { margin: 0; font-size: 1.05rem; }
.list-row p { margin: 0.2rem 0 0; color: var(--c-muted); }
.tile { overflow: hidden; display: flex; flex-direction: column; }
.tile-img { aspect-ratio: 4 / 3; object-fit: cover; width: 100%; }
.tile-art { aspect-ratio: 4 / 3; display: grid; place-items: center; color: var(--c-primary-ink); background: var(--c-primary); background-image: url("assets/pattern.svg"); }
.tile-art-2 { background-color: var(--c-primary-deep); color: #fff; }
.tile-art-3 { background-color: var(--c-accent); color: var(--c-accent-ink); }
.tile-text { padding: 1.25rem 1.5rem; }
.tile-text p { color: var(--c-muted); margin: 0; }
` },
    { blocks: ['gallery'], css: `
.gallery-grid figure { margin: 0; border-radius: var(--radius); overflow: hidden; }
.gallery-img { aspect-ratio: 1; object-fit: cover; width: 100%; transition: transform 0.4s ease; }
.gallery-grid figure:hover .gallery-img { transform: scale(1.03); }
` },
    { blocks: ['text'], css: `
.about-grid { display: grid; gap: 2.5rem; align-items: center; }
.about-img { border-radius: var(--radius); box-shadow: var(--shadow); aspect-ratio: 4 / 3; object-fit: cover; width: 100%; }
` },
    { blocks: ['features'], css: `
.points { list-style: none; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); }
.points li { display: flex; gap: 1rem; align-items: flex-start; padding: 1.25rem; background: var(--c-surface-alt); border-radius: var(--radius); }
.points h3 { margin: 0 0 0.25rem; font-size: 1.05rem; }
.points p { margin: 0; color: var(--c-muted); }
.point-icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--radius-sm); background: var(--c-primary-soft); color: var(--c-primary-soft-ink); flex: none; }
` },
    { blocks: ['steps'], css: `
.steps-list { list-style: none; counter-reset: step; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); }
.steps-list li { counter-increment: step; position: relative; padding: 1.5rem; padding-inline-start: 4.25rem; background: var(--c-surface); border: 1px solid var(--c-line); border-radius: var(--radius); }
.steps-list li::before { content: counter(step); position: absolute; inset-inline-start: 1.25rem; top: 1.35rem; width: 2.1rem; height: 2.1rem; border-radius: 50%; display: grid; place-items: center; background: var(--c-primary-deep); color: #fff; font-weight: 700; }
.steps-list h3 { margin: 0 0 0.25rem; font-size: 1.05rem; }
.steps-list p { margin: 0; color: var(--c-muted); }
` },
    { blocks: ['team'], css: `
.person { padding: 1.5rem; text-align: center; }
.person-img { width: 112px; height: 112px; border-radius: 50%; object-fit: cover; margin: 0 auto 1rem; }
.person-initial { display: grid; place-items: center; width: 88px; height: 88px; margin: 0 auto 1rem; border-radius: 50%; background: var(--c-primary-soft); color: var(--c-primary-soft-ink); font-weight: 800; font-size: 2rem; }
.person h3 { margin-bottom: 0.15rem; }
.person .role { color: var(--c-primary-deep); font-weight: 600; margin-bottom: 0.5rem; }
.person p { color: var(--c-muted); margin: 0; }
` },
    { blocks: ['faq'], css: `
.faq-list { display: grid; gap: 0.75rem; max-width: 52rem; }
.faq-list details { background: var(--c-surface); border: 1px solid var(--c-line); border-radius: var(--radius); padding: 0 1.25rem; }
.faq-list summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1.1rem 0; cursor: pointer; font-weight: 700; list-style: none; }
.faq-list summary::-webkit-details-marker { display: none; }
.faq-list details[open] summary svg { transform: rotate(180deg); }
.faq-list summary svg { transition: transform 0.2s ease; flex: none; color: var(--c-primary-deep); }
.faq-answer { padding-bottom: 1.25rem; color: var(--c-muted); }
` },
    { blocks: ['pricing'], css: `
.plans { align-items: stretch; }
.plan { padding: 1.75rem; display: flex; flex-direction: column; gap: 1rem; }
.plan-featured { border-color: var(--c-primary); box-shadow: 0 18px 40px -20px color-mix(in srgb, var(--c-primary) 60%, transparent); }
.plan-price { display: flex; align-items: baseline; gap: 0.4rem; margin: 0; }
.plan-price strong { font-size: 1.8rem; color: var(--c-primary-deep); }
.plan-price span { color: var(--c-muted); }
.plan ul { list-style: none; display: grid; gap: 0.5rem; }
.plan li { display: flex; gap: 0.5rem; align-items: flex-start; color: var(--c-muted); }
.plan li svg { color: var(--c-primary-deep); flex: none; margin-top: 0.3rem; }
.plan-note { color: var(--c-muted); font-size: 0.95rem; margin: 0; }
.plan .btn { margin-top: auto; justify-content: center; }
` },
    { blocks: ['testimonials'], css: `
.quote { padding: 1.5rem; margin: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.quote svg { color: var(--c-accent); }
.quote blockquote { margin: 0; }
.quote blockquote p { margin: 0; font-size: 1.05rem; }
.quote figcaption { color: var(--c-muted); font-weight: 600; }
` },
    { blocks: ['facts'], css: `
.facts-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); margin: 0; }
.fact { padding: 1.5rem; text-align: center; background: var(--c-primary-soft); border-radius: var(--radius); }
.fact dd { margin: 0; font-size: 2.2rem; font-weight: 800; color: var(--c-primary-soft-ink); line-height: 1.1; }
.fact dt { color: var(--c-primary-soft-ink); font-weight: 600; margin-top: 0.3rem; }
` },
    { blocks: ['posts'], css: `
.post { padding: 1.5rem; }
.post-date { color: var(--c-muted); font-size: 0.95rem; }
` },
    { blocks: ['hours'], css: `
.hours-card { display: flex; gap: 1.25rem; align-items: flex-start; padding: 1.5rem; }
.hours-card h2 { font-size: var(--fs-3); margin-bottom: 0.5rem; }
.hours-list { list-style: none; display: grid; gap: 0.35rem; color: var(--c-muted); }
` },
    { blocks: ['cta'], css: `
.cta { padding-block: 0 var(--space); }
.cta-band { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1.5rem; padding: 2.25rem; border-radius: var(--radius); background: var(--c-primary-deep); color: #fff; background-image: url("assets/pattern.svg"); }
.cta-band h2 { color: #fff; }
.cta-band p { color: #ffffff; margin: 0; }
.cta-band .actions { margin: 0; }
.cta-band .btn-primary { background: #fff; color: var(--c-primary-deep); }
.cta-band .btn-ghost { color: #fff; }
` },
    { blocks: ['contact'], css: `
.contact-layout { display: grid; gap: 2rem; }
.contact-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); align-content: start; }
.contact-card { display: flex; gap: 1rem; align-items: center; padding: 1.25rem; }
.contact-card a { font-weight: 600; word-break: break-all; }
.contact-label { display: block; color: var(--c-muted); font-size: 0.9rem; }
.social { display: flex; align-items: center; gap: 0.75rem; margin-top: 1.5rem; flex-wrap: wrap; }
.social a { display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--c-surface-alt); color: var(--c-primary-deep); }
.contact-form { display: grid; gap: 1rem; padding: 1.75rem; background: var(--c-surface-alt); border-radius: var(--radius); }
.field { display: grid; gap: 0.35rem; font-weight: 600; }
.field-row { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); }
.field input, .field textarea { font: inherit; padding: 0.75rem 0.9rem; border: 1px solid var(--c-line); border-radius: var(--radius-sm); background: var(--c-surface); color: var(--c-ink); width: 100%; min-height: 44px; }
.field textarea { resize: vertical; }
.form-note { color: var(--c-muted); font-size: 0.95rem; margin: 0; }
` },
    { blocks: ['map'], css: `
.map-card { display: flex; gap: 1.25rem; align-items: flex-start; padding: 1.5rem; }
.map-card p { margin: 0 0 0.75rem; }
` },
    { css: `
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .section, .cta { animation: reveal linear both; animation-timeline: view(); animation-range: entry 0% entry 28%; }
  }
}
@keyframes reveal { from { transform: translateY(16px); } to { transform: none; } }
@media (min-width: 760px) {
  .hero-grid { grid-template-columns: 1.1fr 0.9fr; }
  .about-grid { grid-template-columns: 1.2fr 0.8fr; }
  .footer-grid { grid-template-columns: 1.2fr 1fr auto; }
  .contact-layout { grid-template-columns: 1fr 1.1fr; align-items: start; }
}
@media (max-width: 759.98px) {
  .nav-toggle { display: inline-flex; align-items: center; justify-content: center; }
  .site-nav { display: none; position: absolute; inset-inline: 0; top: 100%; flex-direction: column; align-items: stretch; gap: 0.75rem; padding: 1rem; background: var(--c-surface); border-bottom: 1px solid var(--c-line); box-shadow: var(--shadow); }
  .nav-open .site-nav { display: flex; }
  .site-nav ul { flex-direction: column; }
  .site-nav li a { display: block; padding: 0.8rem 1rem; }
  .site-nav .btn { justify-content: center; }
  .hero-art { max-width: 300px; }
  .cta-band { padding: 1.75rem; }
}
@media (min-width: 1024px) {
  .hero { padding-block: calc(var(--space) * 1.2); }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .btn, .gallery-img, .faq-list summary svg { transition: none; }
}
@media print {
  .site-header, .nav-toggle, .cta, .btn, .contact-form { display: none !important; }
  body { color: #000; background: #fff; }
}
` },
  ];
  const kept = parts.filter(part => !part.blocks || !used || part.blocks.some(block => used.has(block)));
  return minifyCss(kept.map(part => part.css).join('\n'));
}

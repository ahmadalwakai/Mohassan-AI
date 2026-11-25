import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SafeNetwork } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { parseMonitorFeedXml } from '../apps/server/src/monitors/feed-xml-v2.js';
import { observePageV2, type MonitorPageAnchor } from '../apps/server/src/monitors/page-v2.js';
import { createMonitorReader } from '../apps/server/src/monitors/sources.js';

const at = '2026-11-25T12:00:00.000Z';
const url = 'https://publisher.example/updates';
const arabic = readFileSync(new URL('./fixtures/monitors/v2-arabic.html', import.meta.url), 'utf8');
const source = { kind: 'page', url } as const;
const price = { source, read: { kind: 'number', label: 'price' } } as const;
const timing: MonitorSpec['timing'] = { urgency: 'normal', lifetimeMs: 86_400_000, initialIntervalMs: 900_000, maxChecks: 48, maxNotifications: 1 };
function page(html: string, spec: Parameters<typeof observePageV2>[3] = price, anchor?: MonitorPageAnchor) {
  return observePageV2(html, url, 'text/html', spec, at, anchor);
}
function value(result: ReturnType<typeof page>) {
  if (result.kind !== 'value') throw new Error(JSON.stringify(result));
  return result;
}

describe('monitor v2 page extraction', () => {
  it('selects schema.org Offer values before the visible price and attaches the typed currency', () => {
    const html = `<script type="application/ld+json">{
      "@context":"https://schema.org","@graph":[
      {"@type":"Product","name":"Telescope","sku":"telescope","offers":{"@id":"#buy"}},
      {"@type":"Offer","@id":"#buy","price":"1234.50","priceCurrency":"SAR","availability":{"@id":"https://schema.org/OutOfStock"}}
      ]}</script><main><p>Price: SAR 2499</p><p>In stock</p></main>`;
    expect(value(page(html))).toMatchObject({ observation: { value: 1234.5, excerpt: 'price: Telescope · 1234.50 · SAR' },
      anchor: { origin: 'structured', pattern: { currency: 'SAR' } } });
    expect(value(page(html, { source, read: { kind: 'status', label: 'availability' } })).observation.value).toBe('out of stock');
    expect(value(page(html, { source, read: { kind: 'main' }, v2: { target: { property: 'productName' } } })).observation.value).toBe('Telescope');
    expect(page(html, { ...price, v2: { target: { currency: 'EUR' } } }).kind).toBe('unsafe-target');
  });

  it('reads microdata for events and offers, including element-specific values', () => {
    const html = `<main><article itemscope itemtype="https://schema.org/Event">
      <h1 itemprop="name">Festival</h1>
      <time itemprop="startDate" datetime="2026-11-25T12:00:00+03:00">December</time>
      <link itemprop="eventStatus" href="https://schema.org/EventPostponed">
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <meta itemprop="priceCurrency" content="EUR"><data itemprop="price" value="32">Price EUR 72</data>
      </div></article></main>`;
    expect(value(page(html, { source, read: { kind: 'date' } })).observation.value).toBe('2026-11-25');
    expect(value(page(html, { source, read: { kind: 'status', label: 'event status' } })).observation.value).toBe('event postponed');
    expect(value(page(html))).toMatchObject({ observation: { value: 32 }, anchor: { pattern: { currency: 'EUR' } } });
    expect(value(page(`<div itemscope itemtype="https://schema.org/Offer" itemref="pricing"></div>
      <span id="pricing"><data itemprop="price" value="29">Visible price: EUR 63</data><meta itemprop="priceCurrency" content="EUR"></span>`)))
      .toMatchObject({ observation: { value: 29 }, anchor: { pattern: { currency: 'EUR' } } });
  });

  it('makes current, struck-through and different-currency prices selectable', () => {
    const html = '<main><p>Price <del>USD 380</del>, now USD 340</p><p>Price EUR 300</p></main>';
    const result = page(html);
    expect(result.kind).toBe('clarify');
    if (result.kind !== 'clarify') return;
    expect(result.candidates.map(item => [item.observation.value, item.anchor.pattern.currency, Boolean(item.anchor.old)]))
      .toEqual([[380, 'USD', true], [340, 'USD', false], [300, 'EUR', false]]);
    const chosen = result.candidates[1];
    expect(value(page(html.replace('340', '330'), price, chosen.anchor)).observation.value).toBe(330);
  });

  it('relocates a matching label, currency and context, and pauses for a changed unit', () => {
    const before = value(page('<main><article><h2>Member plan</h2><p>Price SAR 10 per seat</p></article></main>'));
    const after = value(page('<main><h2>Unrelated</h2><p>Price EUR 8</p><section><h2>Member plan</h2><div>Price SAR 12 per seat</div></section></main>',
      price, before.anchor));
    expect(after).toMatchObject({ observation: { value: 12 }, relocation: { confidence: 0.9, at } });
    const weight = { source, read: { kind: 'number', label: 'weight' } } as const;
    const pounds = value(page('<main><p>Weight 5 lb</p></main>', weight));
    expect(page('<main><p>Weight 3 kg</p></main>', weight, pounds.anchor)).toMatchObject({ kind: 'unsafe-target', confidence: 0 });
    expect(page('<main><p>Price EUR 12</p></main>', price, before.anchor)).toMatchObject({ kind: 'unsafe-target', confidence: 0 });
    const scoped = { ...price, source: { ...source, anchor: 'Member plan' } };
    expect(page('<main><h2>Other plan</h2><p>Price SAR 10</p></main>', scoped).kind).toBe('missing');
  });

  it('retains anchored text and phrase identity when the watched section moves', () => {
    const scoping = { ...source, anchor: 'Ticket notes' };
    const before = '<main><section><h2>Ticket notes</h2><p>Tickets available</p></section></main>';
    const after = '<main><article><h3>Ticket notes</h3><div>Tickets available</div></article></main>';
    const text = { source: scoping, read: { kind: 'main' } } as const;
    const first = value(page(before, text));
    expect(value(page(after, text, first.anchor))).toMatchObject({ observation: { blocks: first.observation.blocks }, relocation: { at } });
    const phrase = { source: scoping, read: { kind: 'phrase', phrase: 'available' } } as const;
    const seeded = value(page(before, phrase));
    expect(value(page(after.replace('Tickets available', 'Tickets not available'), phrase, seeded.anchor)))
      .toMatchObject({ observation: { value: false }, relocation: { at } });
  });

  it('asks for an explicit choice after a middling-confidence relocation', () => {
    const before = value(page('<main><section><h2>Member plan</h2><p>Price SAR 10 per seat</p></section></main>'));
    const result = page('<main><div>Price SAR 9 per person</div><div>Price SAR 8 per booking</div></main>', price, before.anchor);
    expect(result).toMatchObject({ kind: 'clarify', candidates: [{ observation: { value: 9 } }, { observation: { value: 8 } }] });
  });

  it('parses Arabic and Persian digits, currency, availability, registration, and Hijri dates', () => {
    expect(value(page(arabic)).observation.value).toBe(1234.5);
    expect(value(page(arabic.replace('١٬٢٣٤٫٥٠', '۱٬۲۳۴٫۵۰'))).observation.value).toBe(1234.5);
    const date = { source, read: { kind: 'date' } } as const;
    expect(value(page(arabic, date)).observation.value).toBe('2026-11-25');
    expect(value(page(arabic.replace('۱۵ جمادى الآخرة ۱۴۴۸ هـ', '١٥/٦/١٤٤٨ هـ'), date)).observation.value).toBe('2026-11-25');
    expect(page(arabic.replace('۱۵ جمادى الآخرة ۱۴۴۸ هـ', '٣١/٦/١٤٤٨ هـ'), date).kind).toBe('missing');
    const availability = { source: { ...source, anchor: 'المخزون' }, read: { kind: 'status', label: 'availability' } } as const;
    expect(value(page(arabic, availability)).observation.value).toBe('in stock');
    expect(value(page(arabic.replace('متوفر', 'نفدت الكمية'), availability)).observation.value).toBe('out of stock');
    expect(value(page(arabic.replace('متوفر', 'قريباً'), availability)).observation.value).toBe('coming soon');
    const registration = { source: { ...source, anchor: 'التسجيل' }, read: { kind: 'status', label: 'registration' } } as const;
    const closed = value(page(arabic, registration));
    expect(closed.observation.value).toBe('registration closed');
    expect(value(page(arabic.replace('التسجيل مغلق', 'التسجيل مفتوح'), registration, closed.anchor)).observation.value)
      .toBe('registration open');
  });
});

describe('bounded monitor feed XML', () => {
  it('reads Atom and keeps date-only sitemap updates out of hour-of-day training', () => {
    expect(parseMonitorFeedXml(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Updates &amp; events</title><link rel="self" href="/atom.xml"/><link href="/updates/1?a=1&amp;b=2"/>
      <published>2026-11-25T12:00:00+00:00</published></entry></feed>`)).toEqual({
      kind: 'feed', entries: [{ url: '/updates/1?a=1&b=2', title: 'Updates & events', published: at }],
    });
    expect(parseMonitorFeedXml('<urlset><url><loc>https://publisher.example/updates/2</loc><lastmod>2026-11-25</lastmod></url></urlset>'))
      .toEqual({ kind: 'sitemap', entries: [{ url: 'https://publisher.example/updates/2' }] });
  });

  it('rejects external declarations, unresolved references, excessive nesting, and oversized XML', () => {
    expect(parseMonitorFeedXml('<!DOCTYPE rss SYSTEM "urn:fixture:external"><rss><channel/></rss>')).toBeUndefined();
    expect(parseMonitorFeedXml('<rss><channel><item><title>&unsupported;</title><link>/1</link></item></channel></rss>')).toBeUndefined();
    expect(parseMonitorFeedXml('<rss>' + '<x>'.repeat(25) + '</x>'.repeat(25) + '</rss>')).toBeUndefined();
    expect(parseMonitorFeedXml('<rss>' + 'x'.repeat(512 * 1024) + '</rss>')).toBeUndefined();
  });
});

async function usingServer(handle: (request: IncomingMessage, response: ServerResponse) => void,
  test: (origin: string) => Promise<void>) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await test(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe('monitor v2 feed discovery transport', () => {
  it('revalidates feed and sitemap independently, follows checked redirects, and reserves one host slot', async () => {
    const requests: string[] = [];
    let generation = 1;
    let sitemapUnavailable = false;
    await usingServer((request, response) => {
      const path = request.url!;
      requests.push(path);
      const etag = path === '/rss.xml' ? `"feed-${generation}"` : '"first"';
      if (path === '/robots.txt') return response.end('User-agent: *\nDisallow: /private\nSitemap: /publisher-sitemap.xml');
      if (path === '/feed') {
        response.writeHead(302, { location: '/rss.xml' });
        return response.end();
      }
      if (path === '/publisher-sitemap.xml' && sitemapUnavailable) {
        response.writeHead(503);
        return response.end();
      }
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304);
        return response.end();
      }
      if (path === '/updates') {
        response.writeHead(200, { 'content-type': 'text/html; charset=UTF-8', etag });
        return response.end('<link rel="alternate" type="application/rss+xml" href="/feed"><main><ul><li>HTML fallback</li></ul></main>');
      }
      response.writeHead(200, { 'content-type': 'text/xml', etag });
      if (path === '/publisher-sitemap.xml') return response.end(`<urlset><url>
        <loc>${new URL('/updates/sitemap', 'http://' + request.headers.host).href}</loc><lastmod>2026-11-25T09:30:00Z</lastmod>
        </url></urlset>`);
      return response.end(`<rss><channel><item><title>Item ${generation}</title>
        <link>/updates/${generation}?utm_source=fixture</link><pubDate>Wed, 25 Nov 2026 12:00:00 GMT</pubDate>
        </item></channel></rss>`);
    }, async origin => {
      const db = {} as Kysely<any>;
      const reader = createMonitorReader({ db, network: new SafeNetwork({ testOrigins: [origin] }), clock: () => Date.parse(at) });
      const spec: MonitorSpec = { source: { kind: 'page', url: origin + '/updates' }, read: { kind: 'items' },
        condition: { kind: 'new-item' }, timing, language: 'en', title: 'Fixture updates', message: 'An item appeared.' };
      const reserveHost = vi.fn(async () => null);
      const options = { ownerId: 'fixture-owner', v2: true, reserveHost };
      const initial = await reader.read(spec, options);
      expect(initial).toMatchObject({ kind: 'value', observation: { value: ['Item 1', origin + '/updates/sitemap'],
        itemKeys: [origin + '/updates/1', origin + '/updates/sitemap'] },
        publicationTimes: ['2026-11-25T09:30:00.000Z', at] });
      expect(reserveHost).toHaveBeenCalledExactlyOnceWith('127.0.0.1');
      if (initial.kind !== 'value') throw new Error('Missing feed baseline');
      generation++;
      const second = await reader.read(spec, { ...options, cache: initial.cache });
      expect(second).toMatchObject({ kind: 'value', observation: { value: ['Item 2', origin + '/updates/sitemap'] } });
      expect(requests.filter(path => path === '/rss.xml')).toHaveLength(2);
      expect(requests.filter(path => path === '/publisher-sitemap.xml')).toHaveLength(2);
      if (second.kind !== 'value') throw new Error('Missing updated feed');
      expect(await reader.read(spec, { ...options, cache: second.cache })).toMatchObject({ kind: 'unchanged', publicationTimes: ['2026-11-25T09:30:00.000Z', at] });
      sitemapUnavailable = true;
      expect(await reader.read(spec, { ...options, cache: second.cache })).toMatchObject({ kind: 'unreachable' });
      expect(await reader.read(spec, { ownerId: 'fixture-owner' })).toMatchObject({ kind: 'value', observation: { value: ['HTML fallback'] } });
    });
  });

  it('does not dispatch a feed redirect blocked by robots and can use the scoped sitemap', async () => {
    const requests: string[] = [];
    await usingServer((request, response) => {
      const path = request.url!;
      requests.push(path);
      if (path === '/robots.txt') return response.end('User-agent: *\nDisallow: /private');
      if (path === '/feed') {
        response.writeHead(302, { location: '/private' });
        return response.end();
      }
      response.writeHead(200, { 'content-type': path === '/updates' ? 'text/html' : 'text/xml' });
      if (path === '/updates') return response.end('<link rel="alternate" type="application/atom+xml" href="/feed">');
      return response.end('<urlset><url><loc>/unrelated</loc></url><url><loc>/updates/new</loc></url></urlset>');
    }, async origin => {
      const db = {} as Kysely<any>;
      const reader = createMonitorReader({ db, network: new SafeNetwork({ testOrigins: [origin] }), clock: () => Date.parse(at) });
      const spec: MonitorSpec = { source: { kind: 'page', url: origin + '/updates' }, read: { kind: 'items' },
        condition: { kind: 'new-item' }, timing, language: 'en', title: 'Fixture updates', message: 'An item appeared.' };
      expect(await reader.read(spec, { ownerId: 'fixture-owner', v2: true })).toMatchObject({ kind: 'value',
        observation: { itemKeys: [origin + '/updates/new'] } });
      expect(requests).not.toContain('/private');
    });
  });
});

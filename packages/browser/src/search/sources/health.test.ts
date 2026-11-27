import { describe, expect, it, vi } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { SearchProviderFailure } from '../providers.js';
import { compileQuery } from '../ranking.js';
import { healthProviders, healthSafetyNote } from './health.js';
import { createHealthRequester } from './health-network.js';
import { healthEnglishQuery } from './health-utils.js';

const signal = new AbortController().signal;
const medlinePlus = 'https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&term=asthma';
const robotsUrl = 'https://wsearch.nlm.nih.gov/robots.txt';

function response(url: string, status: number, body = '', headers: Record<string, string> = {}): SafeResponse {
  return { url, status, body: Buffer.from(body), headers };
}

class HealthNetworkFixture extends SafeNetwork {
  override request = vi.fn<SafeNetwork['request']>();
}

describe('health providers', () => {
  it('offers health authorities through their checked contracts and omits PubMed because robots denies it', () => {
    const providers = healthProviders(new HealthNetworkFixture(), () => 0);
    expect(providers.map(provider => provider.name)).toContain('MedlinePlus');
    expect(providers.every(provider => provider.planned.domains.includes('health'))).toBe(true);
    expect(providers.some(provider => provider.planned.hosts.includes('eutils.ncbi.nlm.nih.gov'))).toBe(false);
    expect(providers.every(provider => provider.planned.contract.checked === '2026-11-27')).toBe(true);
    expect(providers.some(provider => provider.supports(compileQuery('what are the symptoms of asthma?')))).toBe(true);
    expect(providers.some(provider => provider.supports(compileQuery('What is asthma?')))).toBe(true);
    expect(providers.some(provider => provider.supports(compileQuery('ما أعراض الربو؟')))).toBe(true);
    expect(providers.some(provider => provider.supports(compileQuery('how to align a CSS grid')))).toBe(false);
  });

  it('returns the requested Arabic note and the equivalent English note', () => {
    expect(healthSafetyNote('ar')).toBe('هذه معلومات عامة وليست استشارة طبية؛ راجع طبيباً لحالتك.');
    expect(healthSafetyNote('en')).toBe('This is general information and does not constitute medical advice, so consult a doctor about your condition.');
  });

  it.each([
    ['What are the symptoms of asthma?', 'asthma'],
    ['side effects of albuterol', 'albuterol'],
    ['how is influenza spread?', 'influenza'],
    ['What is asthma?', 'asthma'],
  ])('queries English authorities for the subject in %s', (question, subject) => {
    expect(healthEnglishQuery(compileQuery(question))).toBe(subject);
  });

  it('rejects recognized credentials before preparing an external query', () => {
    const query = compileQuery('What are the symptoms of asthma? password=example-fixture');
    expect(() => healthEnglishQuery(query)).toThrow(expect.objectContaining({ code: 'RESEARCH_QUERY_SECRET' }));
  });
});

describe('health provider transport', () => {
  it('keeps robots-denied resources off the network', async () => {
    const network = new HealthNetworkFixture();
    network.request.mockResolvedValueOnce(response(robotsUrl, 200, 'User-agent: *\nDisallow: /ws/\n'));
    const request = createHealthRequester(network, () => 0);

    await expect(request(new URL(medlinePlus), signal)).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DENIED' });
    await expect(request(new URL(medlinePlus), signal)).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DENIED' });
    expect(network.request.mock.calls.map(([url]) => url)).toEqual([robotsUrl]);
  });

  it('honors robots Retry-After before trying either the policy or the API again', async () => {
    const network = new HealthNetworkFixture();
    network.request.mockResolvedValueOnce(response(robotsUrl, 429, '', { 'retry-after': '15' }));
    let now = 0;
    const request = createHealthRequester(network, () => now);

    await expect(request(new URL(medlinePlus), signal)).rejects.toMatchObject(new SearchProviderFailure('rate_limited', 15_000));
    now = 5000;
    await expect(request(new URL(medlinePlus), signal)).rejects.toMatchObject(new SearchProviderFailure('rate_limited', 10_000));
    expect(network.request).toHaveBeenCalledTimes(1);
    now = 15_000;
    network.request.mockResolvedValueOnce(response(robotsUrl, 404)).mockResolvedValueOnce(response(medlinePlus, 200, 'fixture body'));
    await expect(request(new URL(medlinePlus), signal)).resolves.toBe('fixture body');
  });

  it('paces requests across health factories using the same clock', async () => {
    const network = new HealthNetworkFixture();
    network.request.mockImplementation(async url => response(url, url === robotsUrl ? 404 : 200));
    let time = 0;
    const now = () => time;
    const first = createHealthRequester(network, now);
    const second = createHealthRequester(network, now);

    await first(new URL(medlinePlus), signal);
    await expect(second(new URL(medlinePlus), signal)).rejects.toMatchObject(new SearchProviderFailure('rate_limited', 1000));
    expect(network.request.mock.calls.map(([url]) => url)).toEqual([robotsUrl, medlinePlus]);
    time = 1000;
    await second(new URL(medlinePlus), signal);
    expect(network.request.mock.calls.filter(([url]) => url === medlinePlus)).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import { pipelineFromEvidence } from '../apps/server/src/assistant/council-web-pipeline.js';
import { proposeCouncilAnswers } from '../apps/server/src/assistant/council-deliberation.js';

const page = (title: string, text: string, file = 'record') => ({
  kind: 'page' as const, url: `https://example.org/fixtures/${file}`, title, text,
});

// Fictional evidence from the review, with each expected value also used to build its source sentence.
const population = (4_200_000).toLocaleString('en-US');
const arabicPopulation = `يبلغ عدد سكان فريدونيا ${population} نسمة حسب تعداد 2030.`;
const date = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2030, 4, 17)));
const founder = 'سامر نادر';

describe('council web pipeline evidence', () => {
  it.each([
    ['What is the population of Freedonia?', page('Freedonia (فريدونيا)', arabicPopulation), population],
    ['What is the population of Freedonia?', page('Freedonia', `The population of Freedonia is ${population} people.`), population],
    ['كم عدد سكان فريدونيا؟', page('فريدونيا', arabicPopulation), population],
    ['متى افتتحت مكتبة بايلايت؟', page('مكتبة بايلايت', `افتتحت مكتبة بايلايت في ${date}.`), date],
    ['من أسس مكتبة بايلايت؟', page('مكتبة بايلايت', `أسس مكتبة بايلايت المهندس ${founder}.`), founder],
    ['من أسس مكتبة بايلايت؟', page('مكتبة بايلايت', `أسس المهندس ${founder} مكتبة بايلايت.`), founder],
  ] as const)('proposes a literal answer with its cited sentence for %s', (question, source, answer) => {
    const proposal = pipelineFromEvidence(question, [source]);
    expect(proposal).toEqual({ answer, citation: { url: source.url, quote: source.text } });
    expect(proposeCouncilAnswers([{ member: 'pipeline', answer, evidence: proposal?.citation }], [source]))
      .toEqual([{ member: 'pipeline', answer, evidenceUrl: source.url, evidenceQuote: source.text }]);
  });

  it('rejects a neighboring population and a count in an untranslated unrelated article', () => {
    expect(pipelineFromEvidence('كم عدد سكان بايلايت؟', [page('بايلايت', arabicPopulation)])).toBeUndefined();
    expect(pipelineFromEvidence('What is the population of Baylight?', [page('Freedonia', arabicPopulation)])).toBeUndefined();
    expect(pipelineFromEvidence('What is the population of Freedonia?', [page('Freedonia', arabicPopulation.replace('فريدونيا', 'مارلو'))])).toBeUndefined();
  });

  it('rejects a founder from an unrelated organization', () => {
    expect(pipelineFromEvidence('من أسس متحف بايلايت؟', [page('مكتبة بايلايت', `أسس مكتبة بايلايت المهندس ${founder}.`)]))
      .toBeUndefined();
  });

  it('abstains when sources give different populations', () => {
    const otherPopulation = (4_200_000 + 1).toLocaleString('en-US');
    const pages = [page('فريدونيا', arabicPopulation), page('فريدونيا', arabicPopulation.replace(population, otherPopulation), 'alternative')];
    expect(pipelineFromEvidence('كم عدد سكان فريدونيا؟', pages)).toBeUndefined();
  });
});

import type { ChatCapabilities } from '@mohassan/contracts';
import { describe, expect, it } from 'vitest';
import { detectManners } from '../apps/server/src/assistant/manners/detect.js';
import { renderMannersClause, renderMannersReply } from '../apps/server/src/assistant/manners/replies.js';
import { mannersDevelopmentCases, mannersDevelopmentControls } from './fixtures/manners-development.js';

const capabilities: ChatCapabilities = { chatModel: false, available: ['web', 'computation'] };

describe('manners development corpus', () => {
  it('measures speech acts, request preservation, and replies on the authored social messages', () => {
    const rows = [];
    const mismatches = [];
    const seen = new Set<string>();

    for (const [variety, cases] of Object.entries(mannersDevelopmentCases)) {
      const language = variety === 'english' ? 'en' : 'ar';
      const script = language === 'ar' ? /\p{Script=Arabic}/u : /\p{Script=Latin}/u;
      let passed = 0;
      for (const [message, act, request = null] of cases) {
        expect(seen.has(message), `duplicate development message: ${message}`).toBe(false);
        seen.add(message);

        const result = detectManners(message);
        const reply = result && (result.request
          ? renderMannersClause(result, capabilities)
          : renderMannersReply(result, capabilities).text);
        const languageMatches = variety === 'mixed' || result?.language === language && script.test(reply ?? '');
        if (result?.act === act && result.request === request && languageMatches && reply?.trim()) {
          passed++;
        } else {
          mismatches.push({
            variety,
            message,
            expected: { act, request, language: variety === 'mixed' ? 'mixed' : language },
            actual: result && { act: result.act, request: result.request, language: result.language, reply },
          });
        }
      }
      rows.push(`${variety} ${passed}/${cases.length}`);
    }

    console.info(`Manners development: ${seen.size - mismatches.length}/${seen.size} (${rows.join(', ')})`);
    expect(seen.size).toBeGreaterThanOrEqual(250);
    expect(mismatches).toEqual([]);
  });

  it('keeps ordinary requests and mentions of social phrases on the normal path', () => {
    const falsePositives = mannersDevelopmentControls.filter(message => detectManners(message) !== null);

    console.info(`Manners controls: ${mannersDevelopmentControls.length - falsePositives.length}/${mannersDevelopmentControls.length}`);
    expect(falsePositives).toEqual([]);
  });
});

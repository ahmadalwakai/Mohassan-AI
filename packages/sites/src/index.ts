export { composeSite, fileBytes, textFiles, GENERATOR_VERSION } from './compose.ts';
export { checkSite, briefDigitRuns } from './check.ts';
export { zipFiles, listZip, crc32 } from './zip.ts';
export { isSiteRequest, SITE_REQUEST, siteSentence, detectKind, detectCity, detectName, detectRequests } from './recognize.ts';
export { siteQuestion, missingWants, applyAnswers, completeBrief, MAX_ROUNDS, KIND_LABELS, WANT_LABELS, kindByLabel, parseTeam, parseFaq, parsePricing, parsePoints, parseFacts, parseTestimonials, parsePosts } from './plan.ts';
export type { SiteQuestion, SiteQuestionField, Completion } from './plan.ts';
export { siteCommand, applyPatch, commandExamples, fulfilWant } from './commands.ts';
export type { SiteCommand } from './commands.ts';
export { buildPages, placeBlock, removeBlocks, ITEMS_PAGE, PAGE_TITLES } from './families.ts';
export { deriveTheme, contrastRatio, themePairs, colourFromWord, COLOUR_WORDS, KIND_COLOURS, KIND_MOODS } from './theme.ts';
export type { Theme } from './theme.ts';
export { createWriter, allSentences, COPY } from './copy/index.ts';
export { normalize, parseItems, findNumbers, detectLang } from './text.ts';
export { slugify, telDigits, asciiDigits } from './html.ts';
export { contentTypeFor } from './mime.ts';
export { seedOf, pick } from './seed.ts';
export type { SiteFile, SiteImageAsset, ComposeOptions, ComposedSite } from './types.ts';

/** What the chat keeps between turns for one site conversation. */
export interface SiteChatState {
  partial: import('@mohassan/contracts').SitePartialBrief;
  /** The wants asked by the pending card, in field order. */
  asked?: import('@mohassan/contracts').SiteWant[];
  siteId?: string;
  /** A block that still needs the user's content after a command ("add a team section"). */
  pendingWant?: { want: import('@mohassan/contracts').SiteWant; title?: string };
  requestText: string;
}

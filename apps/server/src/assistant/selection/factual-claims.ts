import { foldText } from '../../../../../packages/skills/src/stems.js';

export interface SearchFactRequest {
  type: 'currency' | 'composition';
  language: 'ar' | 'en';
  subject: string;
}

const CURRENCY_REQUEST_EN = /^(?:(?:what|which) (?:is (?:the )?)?(?:official |national |local )?currency (?:of|in|for) (.+)|(?:what|which) (?:official |national |local )?currency (?:does|do) (.+) (?:use|accept))$/u;
const CURRENCY_REQUEST_AR = /^(?:ما(?: هي)?|ماذا|ايش|اي|وش|شنو|شو) (?:ال)?عمله(?: (?:الرسميه|الوطنيه|المحليه))?(?: (?:التي|اللي) (?:يستخدم\p{L}*|تستخدم\p{L}*|يتعامل\p{L}* بها))?(?: في| ل)? (.+)$/u;
const COMPOSITION_REQUEST = /^(?:what|which) [\p{L}\s-]+? (?:makes? up|constitutes?|accounts? for|represents?) (?:most|the majority) of (.+)$/u;

const CURRENCY_CLAIM_EN = /^(?<value>[\p{L}\p{M}'’-]+(?: [\p{L}\p{M}'’-]+){0,6}) (?:is|serves as) the (?:official |national |local )?currency (?:of|in|for) (?<owner>[^.!?;]+)[.!?]?$/u;
const CURRENCY_CLAIM_AR = /^(?<value>[\p{Script=Arabic}\p{M}]+(?: [\p{Script=Arabic}\p{M}]+){0,5}) (?:هو|هي) (?:ال)?عمله(?: (?:الرسميه|الوطنيه|المحليه))? (?:في |ل)?(?<owner>[^.،!?؛]+)(?:[.،!?؛].*)?$/u;
const COMPOSITION_CLAIM = /^(?<value>[\p{L}\p{M}'’-]+(?: [\p{L}\p{M}'’-]+){0,5}) (?:makes? up|constitutes?|accounts? for|represents?) (?:about |approximately |roughly )?(?<percent>\d{1,3}(?:\.\d+)?)\s*(?:percent|%) of (?<scope>[^,;!?]+)(?:[,;!?].*)?$/u;
const MEASUREMENT_BASIS = / by (?:mass|volume|weight)$/u;
const NONASSERTION = /(?:^|\s)(?:no|not|never|former|alleged|claimed|reported|estimated|if|لا|ليس|ليست|سابقا|المزعوم|لو|اذا)(?=\s|$)/u;
const JOINT_SHARE = /\b(?:and|or|with|plus|both|either|combined|together)\b/u;

function ownerKey(owner: string, language: SearchFactRequest['language']): string {
  const clean = owner.replace(/[.؟?!]$/u, '').replace(/[’‘]/gu, "'").trim();
  if (language === 'ar') return clean.replace(/^ال(?=\p{L}{3})/u, '');
  return clean.replace(/^(.+)'s (.+)$/u, '$2 of $1').replace(/^the /u, '').replace(/ of the /gu, ' of ');
}

export function searchFactRequest(question: string, language: SearchFactRequest['language']): SearchFactRequest | undefined {
  const query = foldText(question).trim().replace(/[؟?!]+$/u, '').replace(/\s+/gu, ' ');
  const currency = (language === 'ar' ? CURRENCY_REQUEST_AR : CURRENCY_REQUEST_EN).exec(query);
  if (currency) return { type: 'currency', language, subject: ownerKey(currency[1] ?? currency[2], language) };
  const composition = language === 'en' ? COMPOSITION_REQUEST.exec(query) : null;
  if (composition) return { type: 'composition', language, subject: ownerKey(composition[1], language) };
  return undefined;
}

/** A standalone assertion must name the requested owner. Return its normalized value for conflict checks. */
export function searchFactValue(request: SearchFactRequest, text: string): string | undefined {
  const line = foldText(text).trim().replace(/\s+/gu, ' ');
  if (request.type === 'currency') {
    const claim = (request.language === 'ar' ? CURRENCY_CLAIM_AR : CURRENCY_CLAIM_EN).exec(line)?.groups;
    if (!claim || NONASSERTION.test(claim.value)) return undefined;
    const owners = [claim.owner, ...claim.owner.split(request.language === 'ar' ? /\s+و(?=\p{L})/u : /\s+and\s+|,\s*/u)];
    return owners.some(owner => ownerKey(owner, request.language) === request.subject)
      ? claim.value.replace(/^(?:the |ال(?=\p{L}{3}))/u, '') : undefined;
  }
  const claim = COMPOSITION_CLAIM.exec(line)?.groups;
  if (!claim || NONASSERTION.test(claim.value) || JOINT_SHARE.test(claim.value)) return undefined;
  const percent = Number(claim.percent);
  if (percent <= 50 || percent > 100) return undefined;
  const scope = claim.scope.replace(/\.$/u, '');
  // A conventional measurement basis describes the reported fraction, which remains qualified in the displayed sentence.
  const owner = MEASUREMENT_BASIS.test(scope)
    ? scope.replace(MEASUREMENT_BASIS, '').replace(/^(the )?dry /u, '$1')
    : scope;
  return ownerKey(owner, request.language) === request.subject ? claim.value.replace(/^the /u, '') : undefined;
}

export const CAPITAL_CITY_COORDINATION = /^(?:and|as well as) (?:the )?(?:largest|biggest|most populous|principal) city (?=of )/u;
export const CAPITAL_CITY_COPULA = /\b(?:is|was) (?:also )?(?:the )?$/u;
export const WRITTEN_WORK_LABEL = '(?:novel|book|play|poem|story|essay|paper|memoir|biography)';
export const WRITTEN_WORK_CREDIT = new RegExp(`^(?<work>[^.,:;!?]{1,150}?) (?:is|was) (?:an?|the) ${WRITTEN_WORK_LABEL} by (?<credit>[^.,:;!?]+)`, 'iu');
export const PROPER_NAME = /\p{Lu}[\p{L}\p{M}’'-]+(?:\s+(?:(?:de|del|van|von|al|bin|ibn)\s+)?(?:\p{Lu}[\p{L}\p{M}’'-]+|\p{Lu}\.))+/u;
const CREDITED_AUTHOR = new RegExp(`^${PROPER_NAME.source}`, 'u');
const PUBLICATION_HISTORY = /^[,;]\s+(?:(?:first|originally|initially|later|subsequently) )?published (?:in|on|from|during|between) [\p{L}\p{N}\s'’-]*\d[\p{L}\p{N}\s'’-]*[.!]?$/iu;

export function creditedAuthor(credit: string): string | undefined {
  return CREDITED_AUTHOR.exec(credit)?.[0];
}

export function hasWrittenWorkPublicationHistory(text: string): boolean {
  const credit = WRITTEN_WORK_CREDIT.exec(text);
  return Boolean(credit && creditedAuthor(credit.groups!.credit) && PUBLICATION_HISTORY.test(text.slice(credit[0].length)));
}

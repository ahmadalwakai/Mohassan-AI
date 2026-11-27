import { BrowserError } from '@mohassan/browser';
import { searchFailureDetails, type SearchFailure } from '@mohassan/contracts/reply-messages';

export class SearchProvidersError extends BrowserError {
  constructor(readonly failures: readonly SearchFailure[]) {
    super('RESEARCH_PROVIDERS_FAILED', searchFailureDetails(failures, 'en'), 502);
  }
}

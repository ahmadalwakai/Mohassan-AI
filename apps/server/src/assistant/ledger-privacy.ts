import { redactSensitiveCredentialText } from '../sensitive-credential-text.js';

/** A stored run may predate redaction at the conversation checkpoint. */
export function redactLegacyLedgerProjection<T extends object>(view: T): T {
  return JSON.parse(JSON.stringify(view, (_key, value: unknown) =>
    typeof value === 'string' ? redactSensitiveCredentialText(value) : value)) as T;
}

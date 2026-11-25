import { publicSearchScan, publicSearchText } from '@mohassan/browser';
import type { MonitorSpec } from '@mohassan/contracts';
import { containsSensitiveCredentialText, redactSensitiveCredentialText } from '../sensitive-credential-text.js';

export function monitorContainsCredentials(value: string): boolean {
  const decoded = publicSearchScan(value);
  return containsSensitiveCredentialText(value) || containsSensitiveCredentialText(decoded);
}

export function monitorSourceContainsCredentials(source: MonitorSpec['source']): boolean {
  return Object.values(source).some(value => typeof value === 'string' && monitorContainsCredentials(value));
}

export function redactMonitorEvidence(value: string): string {
  return monitorContainsCredentials(value) ? '[REDACTED]' : publicSearchText(redactSensitiveCredentialText(value));
}

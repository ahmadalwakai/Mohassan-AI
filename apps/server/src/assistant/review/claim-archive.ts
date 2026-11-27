import { createHash } from 'node:crypto';
import { constants, deflateRawSync, inflateRawSync } from 'node:zlib';
import type { Claim, ConversationLedger } from './ledger.js';

function encodeCheckpointData(value: unknown): string {
  return deflateRawSync(JSON.stringify(value), { level: constants.Z_BEST_SPEED }).toString('base64');
}

function decodeCheckpointData<T>(data: string): T {
  return JSON.parse(inflateRawSync(Buffer.from(data, 'base64')).toString()) as T;
}

export interface ClaimArchive {
  buckets: Record<string, string>;
  decisions: Claim[];
}

function bucketFor(subject: string): string {
  return createHash('sha256').update(subject).digest('hex')[0]!;
}

export function readClaimArchive(archive: ClaimArchive): NonNullable<ConversationLedger['archivedClaims']> {
  const decoded = new Map<string, Claim[]>();
  return {
    decisions: archive.decisions,
    forSubject(subject) {
      const bucket = bucketFor(subject);
      const data = archive.buckets[bucket];
      if (!data) return [];
      let claims = decoded.get(bucket);
      if (!claims) {
        claims = decodeCheckpointData<Claim[]>(data);
        decoded.set(bucket, claims);
      }
      return claims.filter(claim => claim.subject === subject);
    },
  };
}

export function extendClaimArchive(previous: ClaimArchive | undefined, additions: readonly Claim[]): ClaimArchive {
  const buckets = { ...previous?.buckets };
  const decisions = new Map(previous?.decisions.map(claim => [claim.subject, claim]));
  const changed = new Map<string, Claim[]>();
  for (const claim of additions) {
    const bucket = bucketFor(claim.subject);
    let claims = changed.get(bucket);
    if (!claims) {
      claims = buckets[bucket] ? decodeCheckpointData<Claim[]>(buckets[bucket]) : [];
      changed.set(bucket, claims);
    }
    // Historical comparisons need the extracted assertion and its position.
    // The decision summary keeps the original clause separately.
    claims.push({ ...claim, text: '' });
    if (claim.kind === 'decision') {
      decisions.delete(claim.subject);
      decisions.set(claim.subject, claim);
    }
  }
  for (const [bucket, claims] of changed) buckets[bucket] = encodeCheckpointData(claims);
  return { buckets, decisions: [...decisions.values()] };
}

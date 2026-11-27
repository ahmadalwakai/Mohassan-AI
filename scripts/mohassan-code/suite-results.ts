import type { SuiteCase } from './suite-cases.ts';

interface SuiteObservation {
  first: string;
  approvalPrompt?: string;
  approvalDetail?: string;
  final?: string;
  finalText: string | null;
  codingEffect: boolean;
  readyForReview: boolean;
}

export function scoreSuiteCase(item: SuiteCase, observed: SuiteObservation) {
  const misses: string[] = [];
  if (item.approval) {
    if (observed.first !== 'waiting_approval' || !observed.approvalPrompt) misses.push('Missing approval card');
    if (!observed.final || observed.final === 'timeout' || observed.final === 'waiting_approval') {
      misses.push('No settled result after approval');
    }
    const card = `${observed.approvalPrompt ?? ''}\n${observed.approvalDetail ?? ''}`;
    for (const expected of item.expectApproval ?? []) {
      if (!card.includes(expected)) misses.push(`Missing approval text: ${expected}`);
    }
    if (!observed.codingEffect) misses.push('Missing coding task');
    if (item.needsModel ? observed.readyForReview : !observed.readyForReview) {
      misses.push(item.needsModel ? 'Unexpected review checkpoint' : 'Missing verified review checkpoint');
    }
  } else if (observed.first === 'waiting_approval' || observed.approvalPrompt) {
    misses.push('Unexpected approval card');
  }
  if (item.control && observed.codingEffect) misses.push('Unexpected coding activity');
  for (const expected of item.expect) {
    if (!observed.finalText?.includes(expected)) misses.push(`Missing reply text: ${expected}`);
  }
  for (const forbidden of item.reject ?? []) {
    if (observed.finalText?.includes(forbidden)) misses.push(`Forbidden reply text: ${forbidden}`);
  }
  return { met: misses.length === 0, misses };
}

export function suiteTotals(rows: readonly { capability: SuiteCase['capability']; met: boolean }[]) {
  const totals = { check: { met: 0, total: 0 }, search: { met: 0, total: 0 }, imports: { met: 0, total: 0 },
    fix: { met: 0, total: 0 }, control: { met: 0, total: 0 }, all: { met: 0, total: 0 } };
  for (const { capability, met } of rows) {
    totals[capability].total++;
    totals.all.total++;
    if (met) {
      totals[capability].met++;
      totals.all.met++;
    }
  }
  return totals;
}

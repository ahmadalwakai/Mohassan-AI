import type { CampaignEventInput, GoogleAdsReadback } from '@mohassan/contracts';
import { addEvidence, appendStep, planStep, setStepAuthorization, settleStep, startStep, tryEnterPhase, type RunLedger } from './agent-run.js';

/** Projects host campaign events into the same persisted plan every chat client reads. */
export function observeCampaignLedger(ledger: RunLedger, serial: number, event: CampaignEventInput, at: number, readback?: GoogleAdsReadback) {
  const id = `ads-task-${serial}`;
  if (event.type === 'task_started') {
    if (!ledger.plan?.steps.some(step => step.id === id)) {
      const readbackOnly = event.data.mode === 'readback_only';
      const created = appendStep(ledger, planStep({ id, capability: readbackOnly ? 'ads.read' : event.data.createInAccount ? 'ads.campaign' : 'ads.check',
        input: null,
        outcome: readbackOnly ? 'Reconcile the saved campaign by fresh readback without another write' : event.data.createInAccount ? 'Create the requested campaign PAUSED and compare its remote fields' : 'Validate the advertising draft',
        acceptance: event.data.createInAccount ? ['The intended account and corrected fields match a fresh remote read'] : ['The deterministic advertising validator accepts the draft'],
        authorization: event.data.createInAccount && !readbackOnly ? 'required' : 'not_needed', required: true }), at);
      if (!created) throw new Error('The execution plan has no space for the required advertising verification step.');
    }
    startStep(ledger, id, at);
    tryEnterPhase(ledger, 'executing', at);
    return;
  }
  const step = ledger.plan?.steps.find(item => item.id === id);
  if (!step) return;
  if (event.type === 'account_observed') addEvidence(ledger, { stepId: id, kind: 'observation', independent: true,
    label: `Account ${event.data.customerId}, ${event.data.currency}, ${event.data.timeZone}, ${event.data.range.start} to ${event.data.range.end}`,
    reference: `customers/${event.data.customerId}`, observedAt: Date.parse(event.data.checkedAt) }, at);
  if (event.type === 'approval_required' && event.data.satisfied && event.data.ownerRequested) setStepAuthorization(ledger, id, 'granted', at);
  if (event.type === 'verification_completed') {
    tryEnterPhase(ledger, 'verifying', at);
    const remote = event.data.scope === 'readback' && event.data.authority === 'google_ads_api';
    addEvidence(ledger, { stepId: id, kind: remote ? 'readback' : 'observation', independent: true,
      label: `${event.data.scope}: ${event.data.checks.filter(check => check.passed).length}/${event.data.checks.length} checks match`,
      reference: remote ? readback?.campaignResourceName : null, observedAt: remote && readback ? Date.parse(readback.checkedAt) : at }, at);
  }
  if (event.type === 'external_operation_started') tryEnterPhase(ledger, 'executing', at);
  if (event.type === 'task_completed') {
    const verified = event.data.outcome === 'draft_checked' ? step.capability === 'ads.check'
      : readback?.passed === true && readback.fields.length > 0 && readback.fields.every(field => field.passed)
        && readback.campaignResourceName === event.data.campaignResourceName;
    settleStep(ledger, id, verified ? 'verified' : 'unknown', at);
  }
  if (event.type === 'task_failed') settleStep(ledger, id, event.data.reconciliationRequired ? 'unknown' : 'failed', at);
  if (event.type === 'task_cancelled') settleStep(ledger, id, event.data.reconciliationRequired ? 'unknown' : 'invalidated', at);
}

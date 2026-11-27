import type { ArbiterDecisionLog, ModelObservation } from './manager.js';
import { isMonitorDecisionLabel, monitorDecisionModelId, monitorDecisionType, monitorHeadComponent,
  monitorReasonerComponent } from './monitor-decision.js';

export type ShadowLanguage = 'ar' | 'en' | 'mixed';
type SummaryLanguage = ShadowLanguage | 'unknown';
type SummaryOutcome = ModelObservation['outcome'] | 'unknown';
export type ShadowModelCall = Pick<ModelObservation, 'model' | 'attempted' | 'disagreed' | 'fallback'> &
  { outcome?: ModelObservation['outcome'] };

interface Counts {
  considered: number;
  attempted: number;
  compared: number;
  disagreements: number;
  fallbacks: number;
  outcomes: Map<SummaryOutcome, number>;
}

function counts(): Counts {
  return { considered: 0, attempted: 0, compared: 0, disagreements: 0, fallbacks: 0, outcomes: new Map() };
}

function add(count: Counts, call: ShadowModelCall): void {
  count.considered++;
  if (call.attempted === true) count.attempted++;
  if (typeof call.disagreed === 'boolean') count.compared++;
  if (call.disagreed === true) count.disagreements++;
  if (call.fallback === 'existing-rules') count.fallbacks++;
  const outcome = call.outcome ?? 'unknown';
  count.outcomes.set(outcome, (count.outcomes.get(outcome) ?? 0) + 1);
}

function report({ outcomes, ...count }: Counts) {
  return {
    ...count,
    disagreementRate: count.compared ? count.disagreements / count.compared : null,
    outcomes: Object.fromEntries([...outcomes].map(([outcome, numerator]) => [outcome, {
      numerator, denominator: count.considered,
    }])),
  };
}

function monitorCalls(decisions: readonly ArbiterDecisionLog[]): ShadowModelCall[] {
  return decisions.flatMap(decision => {
    const outcome = decision.modelOutcome;
    if (decision.type !== monitorDecisionType || outcome === undefined) return [];
    const call: ShadowModelCall = { model: monitorDecisionModelId, attempted: true, outcome };
    if (outcome !== 'ok') return [{ ...call, fallback: 'existing-rules' }];
    const host = decision.claimants?.find(claim => claim.component === monitorReasonerComponent)?.label;
    const learned = decision.claimants?.find(claim => claim.component === monitorHeadComponent)?.label;
    if (isMonitorDecisionLabel(host) && isMonitorDecisionLabel(learned)) call.disagreed = host !== learned;
    return [call];
  });
}

/** Counts completed turns using the same rules for the live manager and JSONL reports. */
export class ShadowModelCounts {
  private turns = 0;
  private readonly languages: Record<SummaryLanguage, number> = { ar: 0, en: 0, mixed: 0, unknown: 0 };
  private readonly models = new Map<string, { total: Counts; byLanguage: Map<SummaryLanguage, Counts> }>();

  recordTurn(language: ShadowLanguage | undefined, models: readonly ShadowModelCall[], arbiter: readonly ArbiterDecisionLog[] = []): void {
    const bucket = language ?? 'unknown';
    this.turns++;
    this.languages[bucket]++;
    for (const call of [...models, ...monitorCalls(arbiter)]) {
      const model = this.models.get(call.model) ?? { total: counts(), byLanguage: new Map<SummaryLanguage, Counts>() };
      const languageCounts = model.byLanguage.get(bucket) ?? counts();
      add(model.total, call);
      add(languageCounts, call);
      model.byLanguage.set(bucket, languageCounts);
      this.models.set(call.model, model);
    }
  }

  summary() {
    return {
      turns: this.turns,
      turnsByLanguage: { ...this.languages },
      models: [...this.models].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([model, { total, byLanguage }]) => ({
        model, ...report(total),
        byLanguage: Object.fromEntries([...byLanguage].map(([language, count]) => [language, report(count)])),
      })),
    };
  }
}

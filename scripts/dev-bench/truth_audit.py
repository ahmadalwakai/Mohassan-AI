"""Capture truth-check decisions beside native development scores."""

TRUTH_FLAG = 'MOHASSAN_TRUTH_CHECK'


def instrument_truth_observer(path, mode, replace):
    source = path.read_text()
    source = replace(source, '  answer: string;\n', '  answer: string;\n  truthChecks?: BenchTruthCheck[];\n')
    source = replace(source, '  const turns: CapabilityTurnObservation[] = [];', '''  const turns: CapabilityTurnObservation[] = [];
  const truth: { record: Omit<BenchTruthCheck, 'published'>; replacement: string | null }[] = [];''')
    source = replace(source, "judgeShadow: { logFile: '', observe(input) {",
                     f"judgeShadow: {{ logFile: '', truthMode: '{mode}', observe(input) {{")
    source = replace(source, '        const verdict = judge(input);', f'''        const {{ verdict, truth: check }} = evaluateJudgeReply(input, '{mode}');
        if (check) truth.push({{
          record: {{ ...check, candidate: createHash('sha256').update(input.reply).digest('hex') }},
          replacement: verdict.withholdText,
        }});''')
    source = replace(source, '    for (const turn of item.turns) {',
                     '    for (const turn of item.turns) {\n      truth.length = 0;')
    source = replace(source, "        turns.push({ answer: replies.join('\\n'),", '''        const truthChecks = truth.map(({ record, replacement }) => ({
          ...record, published: record.applied && replacement !== null && replies.some(reply => reply.includes(replacement)),
        }));
        turns.push({ truthChecks, answer: replies.join('\\n'),''')
    path.write_text("import { evaluateJudgeReply } from '../../apps/server/src/assistant/truth-publication.js';\n"
                    "type BenchTruthCheck = NonNullable<ReturnType<typeof evaluateJudgeReply>['truth']>\n"
                    "  & { candidate: string; published: boolean };\n" + source)


def instrument_truth_scoring(path, replace):
    source = replace(path.read_text(), 'replies: observation.turns.map(turn => turn.answer)',
                     'replies: observation.turns.map(turn => turn.answer),\n'
                     '            truthChecks: observation.turns.map(turn => turn.truthChecks ?? [])')
    path.write_text(source)


def summarize_withholds(shadow_scores, enabled_scores):
    """Classify a published turn with the native answer checks on its matching shadow draft."""
    if [score['id'] for score in shadow_scores] != [score['id'] for score in enabled_scores]:
        raise ValueError('Truth audit case coverage or order differs across candidate arms')
    summary = dict.fromkeys(('publishedDecisions', 'publishedTurns', 'multiDecisionTurns',
                            'falseAlarms', 'saves', 'unmatchedTurns'), 0)
    for shadow, enabled in zip(shadow_scores, enabled_scores, strict=True):
        for index, checks in enumerate(enabled['truthChecks']):
            published = [check for check in checks if check['published']]
            if not published:
                continue
            summary['publishedDecisions'] += len(published)
            summary['publishedTurns'] += 1
            summary['multiDecisionTurns'] += len(published) > 1
            baseline_checks = shadow['truthChecks'][index] if index < len(shadow['truthChecks']) else []
            comparable = {check['candidate'] for check in baseline_checks if check['decision'] == 'withhold'}
            if any(check['candidate'] not in comparable for check in published):
                summary['unmatchedTurns'] += 1
                continue
            failures = shadow['turns'][index]['failures']
            scored_incorrect = any(failure['stage'] == 'answer' for failure in failures)
            summary['saves' if scored_incorrect else 'falseAlarms'] += 1
    return summary

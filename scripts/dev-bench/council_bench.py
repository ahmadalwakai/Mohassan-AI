"""Inject the production council into the pinned, network-guarded owner fixture."""

from collections import Counter, defaultdict
from math import ceil


IMPORTS = """import type { ModelCouncil } from '@mohassan/contracts';
import { createModelCouncil } from '../../apps/server/src/assistant/model-council.js';
import { modelRoots } from '../../packages/model-relations/src/registry.js';
import { createModelRuntime } from '../../packages/model-relations/src/runtime.js';
"""

ADAPTER_IMPORT = "import { loadCouncilModelAdapter } from '../../apps/server/src/assistant/council-runners.js';\n"

SCORING = """council: observation.turns.map((turn, index) => {
              if (!turn.council) return null;
              const expected = item.turns[index]?.expect;
              const correct = (answer: string | undefined) => {
                if (!expected?.requiredContent.length || answer === undefined) return null;
                return expected.requiredContent.every(rule => rule.anyOf.some(value =>
                  (rule.match === 'number' ? includesNumber : includesLiteral)(answer, value)))
                  && !expected.forbiddenContent.some(value => includesLiteral(answer, value));
              };
              return { chosen: turn.council.chosen, changed: turn.council.changed, elapsedMs: turn.council.elapsedMs,
                v5Eligible: turn.councilObservation?.v5Eligible ?? false,
                uncertaintyPath: turn.councilObservation?.uncertaintyPath ?? null,
                sentCorrect: correct(turn.answer),
                members: turn.council.members.map(member => ({ model: member.model, round: member.round,
                  outcome: member.outcome, correct: member.round === 'answer' && member.outcome === 'ok'
                    ? correct(member.output) : null })) };
            }),
            publishedV5: observation.turns.reduce((count, turn) => count + (turn.publishedV5 ?? 0), 0),"""

COUNCIL_CAPTURE = """  const councilObservations: Array<{
    chosen: string;
    elapsedMs: number;
    v5Eligible: boolean;
    uncertaintyPath: 'empty_pipeline' | 'blocked_with_pages' | 'completed_withheld' | 'other' | null;
  }> = [];"""

COUNCIL_SERVICE = r"""    const roots = modelRoots(process.cwd());
    modelRuntime = createModelRuntime({ artifactRoots: roots@ADAPTER@ });
    const councilService = createModelCouncil({ runner: modelRuntime });
    control = await createCommandChatControl(database.db, {
      modelCouncil: { async deliberate(turn) {
        const result = await councilService.deliberate(turn);
        const hasPages = turn.evidence.some(page => page.kind === 'page' && Boolean(
          page.url && /^https?:\/\//iu.test(page.url) && page.text.trim()))
          || result.council.members.some(member => member.model === 'web-search' && member.outcome === 'ok');
        const pipeline = result.council.members.find(member => member.model === 'pipeline');
        const uncertaintyPath = result.chosen !== 'uncertain' ? null
          : !turn.pipeline.text.trim() ? 'empty_pipeline'
          : turn.pipeline.status === 'blocked' && hasPages ? 'blocked_with_pages'
          : turn.pipeline.status === 'completed' && pipeline?.judge === 'withhold' ? 'completed_withheld' : 'other';
        councilObservations.push({
          chosen: result.chosen, elapsedMs: result.council.elapsedMs, v5Eligible: turn.v5MayAnswer === true, uncertaintyPath,
        });
        return result;
      } },"""


def instrument_observer(path, substitute, *, enabled, use_adapter):
    source = path.read_text()
    marker = "import { createCommandChatControl, type CommandChatConfig }"
    imports = IMPORTS if enabled else IMPORTS.splitlines(keepends=True)[0]
    source = substitute(source, marker, imports + (ADAPTER_IMPORT if use_adapter else "") + marker)
    source = substitute(source, "  modelCalls: number;", """  modelCalls: number;
  council?: ModelCouncil;
  councilObservation?: { v5Eligible: boolean; uncertaintyPath: string | null };
  publishedV5?: number;""")
    if enabled:
        marker = "  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;"
        source = substitute(source, marker, marker + "\n  let modelRuntime: ReturnType<typeof createModelRuntime> | undefined;\n" + COUNCIL_CAPTURE)
        marker = "    control = await createCommandChatControl(database.db, {"
        source = substitute(source, marker, COUNCIL_SERVICE.replace("@ADAPTER@", ", loadAdapter: loadCouncilModelAdapter" if use_adapter else ""))
        marker = "    for (const turn of item.turns) {"
        source = substitute(source, marker, marker + "\n      councilObservations.length = 0;")
        marker = "    finally { globalThis.fetch = realFetch; }"
        source = substitute(source, marker, """    finally {
      try { await modelRuntime?.close(); }
      finally { globalThis.fetch = realFetch; }
    }""")
    marker = "        const replies = detail.messages.filter(message => message.role === 'assistant' && !oldMessages.has(message.id)).map(message => message.text);"
    source = substitute(source, marker, """        const newReplies = detail.messages.filter(message => message.role === 'assistant' && !oldMessages.has(message.id));
        const replies = newReplies.map(message => message.text);
        const council = newReplies.findLast(message => message.council)?.council;
""" + ("""        const councilObservation = council && councilObservations.findLast(item =>
          item.chosen === council.chosen && item.elapsedMs === council.elapsedMs);
""" if enabled else ""))
    marker = "          modelCalls: Math.max(detail.run.engine.modelCalls, modelReceipts.length),"
    source = substitute(source, marker, marker + """
          ...(council ? { council } : {}),
          publishedV5: newReplies.filter(message => message.experiment === 'v5').length,""" +
        ("\n          ...(councilObservation ? { councilObservation } : {})," if enabled else ""))
    path.write_text(source)


def instrument_scoring(path, substitute):
    source = path.read_text()
    marker = "import { failureStages, scoreCapabilityCase, summarizeCapability } from './score.js';"
    source = substitute(source, marker, marker.replace("failureStages, ", "failureStages, includesLiteral, includesNumber, "))
    marker = "replies: observation.turns.map(turn => turn.answer) });"
    path.write_text(substitute(source, marker, "replies: observation.turns.map(turn => turn.answer),\n            " + SCORING + " });"))


def summarize_council(scores):
    coverage = Counter()
    changed = Counter()
    decisions = Counter()
    elapsed = []
    v5_eligible = 0
    members = defaultdict(lambda: defaultdict(Counter))
    uncertainty = defaultdict(Counter)
    for score in scores:
        for turn in score.get('council', []):
            if not turn:
                continue
            group = f'{score["area"]}/{score["language"]}'
            coverage[group] += 1
            decisions[turn['chosen']] += 1
            elapsed.append(turn['elapsedMs'])
            v5_eligible += turn['v5Eligible']
            correct = turn['sentCorrect']
            verdict = 'correct' if correct is True else 'wrong' if correct is False else 'ungraded'
            if turn['changed']:
                changed[verdict] += 1
            if turn['chosen'] == 'uncertain':
                path = turn['uncertaintyPath'] or 'other'
                uncertainty[path][verdict] += 1
                uncertainty[path]['casePassed' if score['passed'] else 'caseFailed'] += 1
            for member in turn['members']:
                counts = members[group][member['model']]
                counts['recorded'] += 1
                if member['correct'] is not None:
                    counts['graded'] += 1
                    counts['correct'] += member['correct']
    verdicts = ('correct', 'wrong', 'ungraded')
    elapsed.sort()
    return {
        'turns': sum(coverage.values()),
        'turnsByAreaAndLanguage': dict(coverage),
        'changed': {'total': sum(changed.values()), **{key: changed[key] for key in verdicts}},
        'decisions': dict(sorted(decisions.items())),
        'elapsedMs': {'count': len(elapsed), **{key: elapsed[ceil(quantile * len(elapsed)) - 1] if elapsed else None
                                             for key, quantile in (('p50', 0.5), ('p95', 0.95))}},
        'v5': {'eligibleCouncilTurns': v5_eligible, 'selectedCouncilTurns': decisions['chat-v5'],
               'publishedReplies': sum(score.get('publishedV5', 0) for score in scores)},
        'uncertainty': {
            'total': decisions['uncertain'],
            'byPath': {path: {'total': sum(counts[key] for key in verdicts),
                              **{key: counts[key] for key in (*verdicts, 'casePassed', 'caseFailed')}}
                       for path, counts in sorted(uncertainty.items())},
        },
        'membersByAreaAndLanguage': {
            group: {model: {'recorded': counts['recorded'], 'graded': counts['graded'], 'correct': counts['correct'],
                            'accuracy': counts['correct'] / counts['graded'] if counts['graded'] else None}
                    for model, counts in sorted(group_members.items())}
            for group, group_members in sorted(members.items())
        },
    }

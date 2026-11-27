"""Inject the production council into the pinned, network-guarded owner fixture."""

from collections import Counter, defaultdict


IMPORTS = """import type { ModelCouncil } from '@mohassan/contracts';
import { createModelCouncil } from '../../apps/server/src/assistant/model-council.js';
import { loadCouncilModelAdapter } from '../../apps/server/src/assistant/council-runners.js';
import { modelRoots } from '../../packages/model-relations/src/registry.js';
import { createModelRuntime } from '../../packages/model-relations/src/runtime.js';
"""

SCORING = """council: observation.turns.map((turn, index) => {
              if (!turn.council) return null;
              const expected = item.turns[index]?.expect;
              const correct = (answer: string | undefined) => {
                if (!expected?.requiredContent.length || answer === undefined) return null;
                return expected.requiredContent.every(rule => rule.anyOf.some(value =>
                  (rule.match === 'number' ? includesNumber : includesLiteral)(answer, value)))
                  && !expected.forbiddenContent.some(value => includesLiteral(answer, value));
              };
              return { chosen: turn.council.chosen, changed: turn.council.changed,
                sentCorrect: correct(turn.answer),
                members: turn.council.members.map(member => ({ model: member.model, round: member.round,
                  outcome: member.outcome, correct: member.round === 'answer' && member.outcome === 'ok'
                    ? correct(member.output) : null })) };
            }),"""


def instrument_observer(path, substitute):
    source = path.read_text()
    marker = "import { createCommandChatControl, type CommandChatConfig }"
    source = substitute(source, marker, IMPORTS + marker)
    source = substitute(source, "  modelCalls: number;", "  modelCalls: number;\n  council?: ModelCouncil;")
    marker = "  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;"
    source = substitute(source, marker, marker + "\n  let modelRuntime: ReturnType<typeof createModelRuntime> | undefined;")
    marker = "    control = await createCommandChatControl(database.db, {"
    source = substitute(source, marker, """    const roots = modelRoots(process.cwd());
    modelRuntime = createModelRuntime({ artifactRoots: roots, loadAdapter: loadCouncilModelAdapter });
    control = await createCommandChatControl(database.db, {
      modelCouncil: createModelCouncil({ runner: modelRuntime }),""")
    marker = "        const resumedRun = previousRun?.id === run.id ? previousRun : undefined;"
    source = substitute(source, marker, """        const council = detail.messages.findLast(message =>
          message.role === 'assistant' && !oldMessages.has(message.id))?.council;
""" + marker)
    marker = "          modelCalls: Math.max(detail.run.engine.modelCalls, modelReceipts.length),"
    source = substitute(source, marker, marker + "\n          ...(council ? { council } : {}),")
    marker = "    finally { globalThis.fetch = realFetch; }"
    source = substitute(source, marker, """    finally {
      try { await modelRuntime?.close(); }
      finally { globalThis.fetch = realFetch; }
    }""")
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
    members = defaultdict(lambda: defaultdict(Counter))
    for score in scores:
        for turn in score.get('council', []):
            if not turn:
                continue
            group = f'{score["area"]}/{score["language"]}'
            coverage[group] += 1
            if turn['changed']:
                correct = turn['sentCorrect']
                changed['correct' if correct is True else 'wrong' if correct is False else 'ungraded'] += 1
            for member in turn['members']:
                counts = members[group][member['model']]
                counts['recorded'] += 1
                if member['correct'] is not None:
                    counts['graded'] += 1
                    counts['correct'] += member['correct']
    return {
        'turnsByAreaAndLanguage': dict(coverage),
        'changed': {'total': sum(changed.values()), **{key: changed[key] for key in ('correct', 'wrong', 'ungraded')}},
        'membersByAreaAndLanguage': {
            group: {model: {'recorded': counts['recorded'], 'graded': counts['graded'], 'correct': counts['correct'],
                            'accuracy': counts['correct'] / counts['graded'] if counts['graded'] else None}
                    for model, counts in sorted(group_members.items())}
            for group, group_members in sorted(members.items())
        },
    }

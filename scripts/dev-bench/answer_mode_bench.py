"""Measure dispatch-to-final-reply wall time and in-process CPU for development turns."""

import math
import re
import unicodedata


PIPELINE_SCORING = ''',
            councilWeb: observation.turns.map(turn => {
              const search = turn.council?.members[0];
              if (search?.model !== 'web-search' || search.round !== 'search') return null;
              const proposal = turn.council?.discussion?.proposals.find(item => item.member === 'pipeline');
              return { pipelineAnswer: proposal?.answer.trim() || null };
            })'''

SOURCE_LINE = re.compile(r'^\s*(?:\*\*)?(?:sources?|المصدر|المصادر)\s*(?:\*\*)?\s*[:：]', re.I)
LINK = re.compile(r'!?\[[^\]\n]*\]\([^\)\n]*\)|https?://\S+', re.I)


def instrument_observer(path, substitute):
    source = path.read_text()
    marker = '  latencyMs: number;'
    source = substitute(source, marker, marker + '\n  finalAnswerMs?: number;\n  cpuMs?: number;')
    marker = '      const started = performance.now();'
    source = substitute(source, marker, marker + '\n      const cpuStarted = process.cpuUsage();')
    marker = '        const detail = await control.detail(ownerId, conversationId);'
    source = substitute(source, marker, marker + '\n        const finalAnswerMs = performance.now() - started;\n        const cpuMs = elapsedCpuMs(cpuStarted);')
    marker = "boundaryCalls.filter(call => call.outcome === 'denied').length, latencyMs,"
    source = substitute(source, marker, marker + ' finalAnswerMs, cpuMs,')
    marker = 'turns.push(failedTurn(error!, calls.slice(offset), performance.now() - started));'
    source = substitute(source, marker, '''turns.push({ ...failedTurn(error!, calls.slice(offset), performance.now() - started),
          cpuMs: elapsedCpuMs(cpuStarted) });''')
    source += '''
function elapsedCpuMs(started: NodeJS.CpuUsage) {
  const { user, system } = process.cpuUsage(started);
  return (user + system) / 1000;
}
'''
    path.write_text(source)


def instrument_scoring(path, substitute, *, capture_pipeline=False):
    marker = 'replies: observation.turns.map(turn => turn.answer)'
    path.write_text(substitute(path.read_text(), marker, marker + ''',
            turnResources: observation.turns.map(turn => ({
              finalAnswerMs: turn.answer.trim() ? turn.finalAnswerMs ?? null : null,
              cpuMs: turn.cpuMs ?? null,
            }))''' + (PIPELINE_SCORING if capture_pipeline else '')))


def summarize_turn_resources(scores):
    wall, cpu = [], []
    for score in scores:
        resources = score['turnResources']
        if len(resources) != len(score['replies']):
            raise ValueError(f'{score["id"]}: resource samples do not match observed turns')
        for turn in resources:
            for key, samples in (('finalAnswerMs', wall), ('cpuMs', cpu)):
                sample = turn[key]
                if sample is None:
                    continue
                if type(sample) not in (int, float) or not math.isfinite(sample) or sample < 0:
                    raise ValueError(f'{score["id"]}: invalid {key} sample')
                samples.append(sample)

    wall.sort()

    def percentile(fraction):
        return wall[math.ceil(fraction * len(wall)) - 1] if wall else None

    return {
        'finalAnswerTurns': len(wall),
        'p50FinalAnswerMs': percentile(0.50),
        'p95FinalAnswerMs': percentile(0.95),
        'cpuMeasuredTurns': len(cpu),
        'meanNodeCpuMsPerTurn': math.fsum(cpu) / len(cpu) if cpu else None,
    }


def answer_words(text):
    text = unicodedata.normalize('NFKD', text.casefold())
    text = ''.join(str(unicodedata.decimal(char)) if char.isdecimal() else char
                   for char in text if not unicodedata.combining(char) and char != 'ـ')
    text = re.sub(r'(?<=\d)[,٬](?=\d{3}(?:[,٬]|\b))', '', text)
    return ' '.join(re.findall(r'\d+(?:[.٫]\d+)*|[^\W\d_]+', text.replace('٫', '.')))


def in_reply(proposal, reply):
    body = '\n'.join(line for line in reply.splitlines() if not SOURCE_LINE.match(line))
    normalized = answer_words(proposal)
    return bool(normalized and f' {normalized} ' in f' {answer_words(LINK.sub(" ", body))} ')


def summarize_pipeline_proposals(off, council_web):
    groups = {name: {'turns': 0, 'pipelineProposals': 0, 'presentInOffReply': 0}
              for name in ('councilWeb', 'factualFamily', 'factualFamilyCouncilWeb')}
    for baseline, candidate in zip(off, council_web, strict=True):
        if any(baseline[key] != candidate[key] for key in ('id', 'area', 'language')):
            raise ValueError('Answer-mode comparison requires aligned development cases')
        turns = candidate['councilWeb']
        if len(turns) != len(candidate['replies']):
            raise ValueError(f'{candidate["id"]}: council-web samples do not match observed turns')
        for index, turn in enumerate(turns):
            factual = candidate['area'] == 'factual'
            proposal = turn['pipelineAnswer'] if turn is not None else None
            off_reply = baseline['replies'][index] if index < len(baseline['replies']) else ''
            matches = bool(proposal and in_reply(proposal, off_reply))
            for name, eligible in (('councilWeb', turn is not None), ('factualFamily', factual),
                                   ('factualFamilyCouncilWeb', factual and turn is not None)):
                if eligible:
                    groups[name]['turns'] += 1
                    groups[name]['pipelineProposals'] += bool(proposal)
                    groups[name]['presentInOffReply'] += matches
    return groups

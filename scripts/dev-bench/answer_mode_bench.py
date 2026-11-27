"""Measure dispatch-to-final-reply wall time and in-process CPU for development turns."""

import math


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


def instrument_scoring(path, substitute):
    marker = 'replies: observation.turns.map(turn => turn.answer)'
    path.write_text(substitute(path.read_text(), marker, marker + ''',
            turnResources: observation.turns.map(turn => ({
              finalAnswerMs: turn.answer.trim() ? turn.finalAnswerMs ?? null : null,
              cpuMs: turn.cpuMs ?? null,
            }))'''))


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

"""Add monitor observations to the development-only fixture runner."""

from pathlib import Path
import re
import shutil


AUDIT_MODULE = 'monitor-audit.mjs'


def add_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError(f'Monitor audit instrumentation requires exactly one {before!r}')
    return source.replace(before, after)


def instrument_decision(path, name, kind):
    source = path.read_text()
    internal_name = f'{name}WithoutBenchTiming'
    source, count = re.subn(rf'export function {name}(?=\()', f'function {internal_name}', source)
    if count != 1:
        raise ValueError(f'Monitor audit instrumentation could not find {name} in {path.name}')
    path.write_text(f"import {{ sampleMonitorDecision }} from '../../../../scripts/agent-capability-bench/{AUDIT_MODULE}';\n"
                    + source + f'\nexport function {name}(...args: Parameters<typeof {internal_name}>): ReturnType<typeof {internal_name}> {{\n'
                    f"  return sampleMonitorDecision('{kind}', () => {internal_name}(...args));\n}}\n")


def instrument_product(checkout):
    monitors = checkout / 'apps/server/src/monitors'
    detection = monitors / 'detection.ts'
    instrument_decision(detection, 'detectMonitorNeed', 'detection')
    intents = monitors / 'v2-chat-intents.ts'
    if intents.is_file():
        instrument_decision(intents, 'parseMonitorManagement', 'management')
        instrument_decision(intents, 'detectMonitorAnswerOffer', 'proactive')
    network = checkout / 'packages/browser/src/network.ts'
    source = add_once(network.read_text(), '    const browser=options.browser===true;', '''    if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
      throw new BrowserError('CAPABILITY_FIXTURE_ONLY', 'This action has no authorized fixture.', 403);
    }
    options.signal?.throwIfAborted();
    await options.beforeDispatch?.();
    return monitorFixtureRead(this.validate(input, options.allowedOrigins).href);
    const browser=options.browser===true;''')
    network.write_text(f"import {{ monitorFixtureRead }} from '../../../scripts/agent-capability-bench/{AUDIT_MODULE}';\n" + source)
    return [detection, network, *([intents] if intents.is_file() else [])]


def instrument_observer(path):
    module = path.parent / AUDIT_MODULE
    if not module.exists():
        shutil.copyfile(Path(__file__).with_name(AUDIT_MODULE), module)
    source = add_once(path.read_text(), 'const nowIso = () => new Date().toISOString();', 'const nowIso = monitorFixtureTime;')
    source = add_once(source, '    setupMs = performance.now() - setupStart;\n    let priorDetail',
                      '    await monitorChat(database.db)?.initialize();\n    setupMs = performance.now() - setupStart;\n    let priorDetail')
    source = add_once(source, '    for (const turn of item.turns) {', '    for (const turn of item.turns) {\n      beginMonitorTurn();')
    source = add_once(source, '        if (!detail.run) throw fixturesOnly();',
                      '        observeMonitorCard(detail.monitorProposal);\n        if (!detail.run) throw fixturesOnly();')
    path.write_text("import { monitorChat } from '../../apps/server/src/monitors/chat.js';\n"
                    f"import {{ beginMonitorTurn, monitorFixtureTime, observeMonitorCard }} from './{AUDIT_MODULE}';\n" + source)
    return module


def instrument_scoring(path):
    source = add_once(path.read_text(), 'const observation = await observe(item);',
                      'const { observation, monitorAudit } = await observeMonitors(item, observe);')
    source = add_once(source, 'replies: observation.turns.map(turn => turn.answer)',
                      'replies: observation.turns.map(turn => turn.answer), monitorAudit')
    path.write_text(f"import {{ observeMonitors }} from './{AUDIT_MODULE}';\n" + source)

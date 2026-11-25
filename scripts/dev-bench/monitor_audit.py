"""Add monitor observations to the development-only fixture runner."""

from os.path import relpath
from pathlib import Path
import re
import shutil


AUDIT_MODULE = 'monitor-audit.mjs'
SOURCE_FLAGS = ('MOHASSAN_MONITORS_GITHUB', 'MOHASSAN_MONITORS_PDF', 'MOHASSAN_MONITORS_VISUAL')


def add_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError(f'Monitor audit instrumentation requires exactly one {before!r}')
    return source.replace(before, after)


def instrument_decision(path, module, name, kind, *, classify=True):
    source = path.read_text()
    internal_name = f'{name}WithoutBenchTiming'
    source, count = re.subn(rf'export function {name}(?=\()', f'function {internal_name}', source)
    if count != 1:
        raise ValueError(f'Monitor audit instrumentation could not find {name} in {path.name}')
    if 'import { sampleMonitorDecision }' not in source:
        source = f"import {{ sampleMonitorDecision }} from '{relpath(module, path.parent)}';\n" + source
    classify_arg = '' if classify else ', false'
    path.write_text(source + f'\nexport function {name}(...args: Parameters<typeof {internal_name}>): ReturnType<typeof {internal_name}> {{\n'
                    f"  return sampleMonitorDecision('{kind}', () => {internal_name}(...args){classify_arg});\n}}\n")


def instrument_product(checkout):
    monitors = checkout / 'apps/server/src/monitors'
    module = checkout / 'scripts/agent-capability-bench' / AUDIT_MODULE
    detection = monitors / 'detection.ts'
    instrument_decision(detection, module, 'detectMonitorNeed', 'detection')
    instrument_decision(detection, module, 'monitorHistoryMayMatter', 'detection', classify=False)
    intents = monitors / 'v2-chat-intents.ts'
    measured = [detection]
    if intents.is_file():
        instrument_decision(intents, module, 'parseMonitorManagement', 'management')
        instrument_decision(intents, module, 'detectMonitorAnswerOffer', 'proactive')
        measured.append(intents)
    github_intent = monitors / 'sources/github-intent.ts'
    if github_intent.is_file():
        instrument_decision(github_intent, module, 'githubIntentMayMatter', 'detection', classify=False)
        instrument_decision(github_intent, module, 'detectGithubMonitorNeed', 'detection')
        instrument_decision(github_intent, module, 'detectGithubAnswerOffer', 'proactive')
        measured.append(github_intent)
    reasoner = monitors / 'decision/reasoner.ts'
    if reasoner.is_file():
        instrument_decision(reasoner, module, 'reasonMonitorContext', 'context')
        measured.append(reasoner)
    network = checkout / 'packages/browser/src/network.ts'
    source = network.read_text()
    start_marker = '    const browser=options.browser===true;'
    stop_marker = '\n  }\n  async text('
    if source.count(start_marker) != 1 or source.count(stop_marker) != 1:
        raise ValueError('Monitor audit could not isolate SafeNetwork.request for fixture-only reads')
    start, stop = source.index(start_marker), source.index(stop_marker)
    source = source[:start] + '''    const url = this.validate(input, options.allowedOrigins).href;
    if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
      throw new BrowserError('CAPABILITY_FIXTURE_ONLY', 'This action has no authorized fixture.', 403);
    }
    options.signal?.throwIfAborted();
    await options.beforeDispatch?.();
    options.signal?.throwIfAborted();
    return monitorFixtureRead(url);''' + source[stop:]
    network.write_text(f"import {{ monitorFixtureRead }} from '../../../scripts/agent-capability-bench/{AUDIT_MODULE}';\n" + source)
    return [*measured, network]


def instrument_observer(path):
    module = path.parent / AUDIT_MODULE
    if not module.exists():
        shutil.copyfile(Path(__file__).with_name(AUDIT_MODULE), module)
    source = add_once(path.read_text(), 'const nowIso = () => new Date().toISOString();', 'const nowIso = monitorFixtureTime;')
    source = add_once(source, '    await migrate(database.db);', '''    await migrate(database.db);
    await commandChatMigration(database.db, migrateRemindersInTransaction);
    await migrateMembers(database.db);
    await migrateMemberDataRights(database.db);''')
    source = add_once(source, "    const { memory, tools } = memoryAndInventory(database, record);",
                      "    await database.db.insertInto('workspace_members').values({ user_id: ownerId, role: fixture.member ? 'member' : 'owner' }).execute();\n"
                      "    const { memory, tools } = memoryAndInventory(database, record);")
    source = add_once(source, '      ...web, tools, recordExperiences: false,',
                      '      ...web, searchProvider: monitorFixtureSearch(web.searchProvider), tools, recordExperiences: false,')
    source = add_once(source, '    setupMs = performance.now() - setupStart;\n    let priorDetail',
                      '    await monitorChat(database.db)?.initialize();\n    setupMs = performance.now() - setupStart;\n    let priorDetail')
    source = add_once(source, '    for (const turn of item.turns) {', '    for (const turn of item.turns) {\n      beginMonitorTurn();')
    source = add_once(source, '        if (!detail.run) throw fixturesOnly();',
                      '        observeMonitorCard(detail.monitorProposal);\n        if (!detail.run) throw fixturesOnly();')
    path.write_text("import { commandChatMigration } from '../../apps/server/src/command-chat.js';\n"
                    "import { migrateMemberDataRights } from '../../apps/server/src/member-data-migration.js';\n"
                    "import { migrateMembers } from '../../apps/server/src/members.js';\n"
                    "import { monitorChat } from '../../apps/server/src/monitors/chat.js';\n"
                    "import { migrateRemindersInTransaction } from '../../apps/server/src/reminders/migration.js';\n"
                    f"import {{ beginMonitorTurn, monitorFixtureSearch, monitorFixtureTime, observeMonitorCard }} from './{AUDIT_MODULE}';\n" + source)
    return module


def instrument_scoring(path):
    source = add_once(path.read_text(), 'const observation = await observe(item);',
                      'const { observation, monitorAudit } = await observeMonitors(item, observe);')
    source = add_once(source, 'replies: observation.turns.map(turn => turn.answer)',
                      'replies: observation.turns.map(turn => turn.answer), monitorAudit')
    path.write_text(f"import {{ observeMonitors }} from './{AUDIT_MODULE}';\n" + source)

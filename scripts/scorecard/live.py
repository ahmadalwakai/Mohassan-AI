"""Run the development scorecard on the existing pinned dev-bench harness."""

from contextlib import contextmanager
from datetime import datetime, timezone
from importlib import import_module
import json
import os
from pathlib import Path
import platform
import re
import sys

from .receipts import safe_input_path


PRODUCTION_COMMIT = "29448aea3fa10d226ef82ec5bf0a65e723d6ec39"
SUITES = json.loads(Path(__file__).with_name("suites.json").read_bytes())
PROTECTED = ("artifacts/brain-lab/holdout-v1", "artifacts/chat-training/conversation-v1/holdout")
FIXTURE_SWITCHES = ("MOHASSAN_JUDGE_SHADOW", "MOHASSAN_JUDGE_FIX", "MOHASSAN_JUDGE_WITHHOLD", "MOHASSAN_MIND")


@contextmanager
def development_modules(root):
    """The existing launcher uses local, non-package imports."""
    directory = str(root / "scripts/dev-bench")
    names = ("run", "runner", "monitor_audit")
    previous = {name: sys.modules.pop(name) for name in names if name in sys.modules}
    sys.path.insert(0, directory)
    try:
        yield import_module("run"), import_module("runner")
    finally:
        sys.path.remove(directory)
        for name in names:
            sys.modules.pop(name, None)
        sys.modules.update(previous)


def _profiles(bench):
    # Wave 4 profile and Wave 5 rollout defaults. The owner can supply other switches on named arms.
    # https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/docs/INTEGRATION-WAVE-5-2026-11-25.md#rollout-flags-and-environment (retrieved 2026-11-27)
    special_off = {
        "MOHASSAN_PLAN_COMPILER": "off",
        "TEST_DRIVEN_CODING_ENABLED": "false",
        "MOHASSAN_MODEL_RELATIONS": "off",
    }
    baseline = {name: special_off.get(name, "0") for name in bench.OVERRIDES} | {
        "MOHASSAN_JUDGE_SHADOW": "0", "MOHASSAN_JUDGE_FIX": "0", "MOHASSAN_JUDGE_WITHHOLD": "0", "MOHASSAN_MIND": "0",
    }
    production = {
        **bench.BASE_FLAGS,
        "MOHASSAN_ARITHMETIC_SEARCH": "1",
        "MOHASSAN_MODEL_RELATIONS": "shadow",
    }
    return baseline, production


def default_arms(root):
    with development_modules(root) as (_, bench):
        baseline, production = _profiles(bench)
    return [
        {"id": "baseline", "commit": PRODUCTION_COMMIT, "switches": baseline},
        {"id": "production", "commit": PRODUCTION_COMMIT, "switches": production},
    ]


def machine_details():
    processors = Path("/proc/cpuinfo")
    cpu_model = next((line.partition(":")[2].strip() for line in processors.read_text().splitlines()
                      if line.partition(":")[0].strip() == "model name"), None) if processors.is_file() else None
    return {
        "system": platform.system(), "release": platform.release(), "architecture": platform.machine(),
        "processor": cpu_model or platform.processor() or platform.machine(), "logical_cpus": os.cpu_count(),
        "available_cpus": len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
    }


def _instrument_observer(path, bench, switches, model):
    source = path.read_text()
    replace = bench.apply_once
    source = replace(source, "  latencyMs: number;", """  latencyMs: number;
  scorecard?: { firstProgressMs: number | null; finalAnswerMs: number | null; cpuMs: number | null };""")
    if switches.get("MOHASSAN_JUDGE_SHADOW") == "0":
        source = replace(source, "judgeShadow: { logFile:", "...(process.env.MOHASSAN_JUDGE_SHADOW === '0' ? {} : { judgeShadow: { logFile:")
        source = replace(source, "judgeWithholdForOwner: true,", "judgeWithholdForOwner: true }),")
    if switches.get("MOHASSAN_JUDGE_FIX") == "0":
        source = replace(source, "judgeFixForOwner: true", "judgeFixForOwner: false")
    if switches.get("MOHASSAN_JUDGE_WITHHOLD") == "0":
        source = replace(source, "judgeWithholdForOwner: true", "judgeWithholdForOwner: false")
    if switches.get("MOHASSAN_MIND") == "1":
        source = _mind_adapter(source, replace)
    source = replace(source, "  const database = await createDatabase({});", """  const database = await createDatabase({});
  const progress = await import('../../apps/server/src/ops/metrics/chat-progress.js').catch(error => {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  progress?.enableChatProgressMarkers(database.db);""")
    source = _model_adapter(source, replace, model)
    source = replace(source, "      const started = performance.now();", """      const started = performance.now();
      const beganAt = Date.now();
      const childrenStarted = models?.childCpuMs();
      const cpuStarted = process.cpuUsage();
      let firstProgressMs: number | null = null;
      const accept = (conversation: ChatConversation) => {
        if (conversation.progress && firstProgressMs === null) firstProgressMs = performance.now() - started;
        return conversation.id;
      };
      const resources = (finalAnswerMs: number | null) => {
        // Node supplies these process CPU counters in microseconds.
        // https://nodejs.org/api/process.html#processcpuusagepreviousvalue (retrieved 2026-11-27)
        const { user, system } = process.cpuUsage(cpuStarted);
        const childrenFinished = models?.childCpuMs();
        const childrenMs = childrenStarted == null || childrenFinished == null ? null : childrenFinished - childrenStarted;
        return { firstProgressMs, finalAnswerMs, cpuMs: childrenMs === null || childrenMs < 0 ? null : (user + system) / 1000 + childrenMs };
      };""")
    source = replace(source, "(await control.create(ownerId, { goal: turn.text })).id",
                     "accept(await control.create(ownerId, { goal: turn.text }))")
    source = replace(source, "await control.approve(ownerId, conversationId, { approvalId: priorDetail.approval.id, approved: turn.approve });",
                     "accept(await control.approve(ownerId, conversationId, { approvalId: priorDetail.approval.id, approved: turn.approve }));")
    source = replace(source, "          await control.send(ownerId, conversationId, { text: turn.text,",
                     "          accept(await control.send(ownerId, conversationId, { text: turn.text,")
    source = replace(source, "...(answers ? { answers } : {}) });", "...(answers ? { answers } : {}) }));")
    source = replace(source, "        error = 'observation';", "        const measured = resources(latencyMs);\n        error = 'observation';")
    source = replace(source, "        if (!detail.run) throw fixturesOnly();", """        if (!detail.run) throw fixturesOnly();
        if (detail.run.id !== previousRun?.id) {
          const event = await database.db.selectFrom('chat_events').select('data')
            .where('run_id', '=', detail.run.id).where('kind', '=', 'visibility').executeTakeFirst();
          const value = typeof event?.data === 'string' ? JSON.parse(event.data) : event?.data;
          const at = value?.firstProgressAtMs;
          if (typeof at === 'number' && at >= beganAt) measured.firstProgressMs = at - beganAt;
        }""")
    source = replace(source, "        turns.push({ answer: replies.join('\\n'),", """        turns.push({
          scorecard: { ...measured, finalAnswerMs: replies.some(reply => reply.trim()) ? measured.finalAnswerMs : null },
          answer: replies.join('\\n'),""")
    source = replace(source, "turns.push(failedTurn(error!, calls.slice(offset), performance.now() - started));", """turns.push({
          ...failedTurn(error!, calls.slice(offset), performance.now() - started), scorecard: resources(null),
        });""")
    path.write_text(source)


def _mind_adapter(source, replace):
    # Keep the Mind's I/O within the same capability fixtures as the rest of chat.
    source = "import { createMind } from '../../apps/server/src/assistant/mind/index.js';\n" + source
    return replace(source, "      ...web, tools, recordExperiences:", """      ...web, tools,
      mind: createMind(),
      mindDeps: () => ({
        search: (query, limit, signal) => web.searchProvider.search(query, limit, signal),
        async read(url, signal) {
          const page = await web.readPage(url, signal);
          const original = fixture.pages?.find(item => new URL(item.url).href === new URL(url).href);
          const visible = page && page !== 'disallowed' ? page : null;
          return { url, status: page === 'disallowed' ? 403 : visible?.status ?? original?.status ?? 404,
            text: visible?.text ?? '', html: visible ? original?.html ?? '' : '', headers: {} };
        },
        async memory(query) {
          const found = await tools.memory?.search(ownerId, query);
          return !found || typeof found === 'string' ? [] : found.evidence;
        },
        async knowledge() { record('knowledge_search', 'recorded'); return [...(fixture.knowledge ?? [])]; },
        now: () => new Date(),
      }),
      recordExperiences:""")


def _model_adapter(source, replace, model):
    source = "import type { createDevelopmentModels } from './development-models.js';\n" + source
    source = replace(source, "  turns: CapabilityTurnObservation[];", """  turns: CapabilityTurnObservation[];
  scorecardModels: { diskBytes: number | null; residentBytes: number | null; attempts: number; succeeded: number };""")
    source = replace(source, "item: CapabilityCaseInput, timeoutMs: number): Promise<CapabilityCaseObservation>", """item: CapabilityCaseInput, timeoutMs: number,
  models: Awaited<ReturnType<typeof createDevelopmentModels>> | undefined): Promise<CapabilityCaseObservation>""")
    source = replace(source, "recordExperiences: false, models:", "recordExperiences: false, ...(models?.council ? { modelCouncil: models.council } : {}), models:")
    source = replace(source, "return { setupMs, turns };", """return { setupMs, turns, scorecardModels: { diskBytes: models?.diskBytes ?? null,
    ...(await models?.sample() ?? { attempts: 0, succeeded: 0, residentBytes: null }) } };""")
    source = replace(source, "  let documents: Documents | undefined;", """  let documents: Documents | undefined;
  let models: Awaited<ReturnType<typeof createDevelopmentModels>> | undefined;""")
    source = replace(source, "    await migrateDocuments(database.db);", f"""    await migrateDocuments(database.db);
    const probe = await import('./development-models.js').catch(error => {{
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || {json.dumps(model)} !== null) throw error;
      return null;
    }});
    models = await probe?.createDevelopmentModels({json.dumps(model)});""")
    source = replace(source, "options.timeoutMs ?? 30_000);", "options.timeoutMs ?? 30_000, models);")
    return replace(source, "    try { await documents?.shutdown(); }", "    try { await models?.close(); await documents?.shutdown(); }")


def _instrument_runner(path, version, bench, switches, model=None):
    model_probe = Path(__file__).with_name("development-models.ts")
    path.with_name(model_probe.name).write_bytes(model_probe.read_bytes())
    _instrument_observer(path.with_name("observe.ts"), bench, switches, model)
    bench.instrument_runner(path, version)
    source = bench.apply_once(path.read_text(), "replies: observation.turns.map(turn => turn.answer)", """replies: observation.turns.map(turn => turn.answer),
            // Node reports maximum harness-process RSS in kilobytes.
            // https://nodejs.org/api/process.html#processresourceusage (retrieved 2026-11-27)
            scorecard: { turns: observation.turns.map(turn => turn.scorecard ?? null), expectedTurns: item.turns.length,
              peakRssBytes: process.resourceUsage().maxRSS * 1024, ...observation.scorecardModels }""")
    path.write_text(source)


def _run_one(root, output, arm, coordinator, bench, workers, offline, model_settings):
    original_instrument = bench.instrument_runner
    original_environment = bench.collect_environment
    original_log = bench.run_logged
    original_git = bench.git
    original_archive = bench.hash_product
    switches = dict(arm.get("switches", {}))
    model = arm.get("model_version")
    baseline, production = _profiles(bench)
    if arm["id"] == "baseline":
        if any(name not in ("TEST_DRIVEN_CODING_PYTHON", *baseline) or
               name in baseline and value != baseline[name] for name, value in switches.items()):
            raise ValueError("The baseline has fixed off settings")
        if arm.get("model") or model:
            raise ValueError("The no-model baseline cannot select a model")
        switches = baseline | switches | {"MOHASSAN_JUDGE_FIX": "0", "MOHASSAN_JUDGE_WITHHOLD": "0"}
    else:
        switches = production | switches
    recorded_commands = {}
    adapter_switches = {name: switches.pop(name) for name in FIXTURE_SWITCHES if name in switches}
    if any(value not in ("0", "1") for value in adapter_switches.values()):
        raise ValueError("Fixture switches require 0 or 1")
    if model and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]*", model):
        raise ValueError("Model selection requires a registry ID")

    def instrument(path, version):
        # Call the unmodified harness instrumentation first using its own module.
        class Instrumentation:
            apply_once = staticmethod(bench.apply_once)
            instrument_runner = staticmethod(original_instrument)
        _instrument_runner(path, version, Instrumentation, adapter_switches, model)

    def environment(overrides, temporary):
        runtime, settings = original_environment(overrides, temporary)
        # The existing fixture guard disables scratch shadow inference while an arm's scratch switch is off.
        fixture = adapter_switches | (model_settings if model else {}) | {"VITEST": "1"}
        return runtime | fixture, settings | fixture

    def run_logged(args, cwd, env, log):
        started = _now()
        original_log(args, cwd, env, log)
        recorded_commands[log.name] = {
            "command": args, "started_at": started, "recorded_at": _now(), "raw_output": str(log),
        }

    def git(directory, *args, input_bytes=None):
        if args == ("sparse-checkout", "set", "--no-cone", "--stdin"):
            input_bytes += "".join(f"!/{path}/\n" for path in PROTECTED).encode()
        if args[-4:] == ("merge", "--no-ff", "--no-commit", bench.AUDIT):
            # The upstream CLI requires MERGE_HEAD. Its contents are discarded before fixtures are mounted.
            # Keep the product tree throughout so the audit merge never attempts to read sealed paths.
            args = (*args[:-1], "-s", "ours", args[-1])
        return original_git(directory, *args, input_bytes=input_bytes)

    def archive(repository, commit):
        exclusions = bench.HOLDOUTS
        bench.HOLDOUTS = (*exclusions, *PROTECTED)
        try:
            return original_archive(repository, commit)
        finally:
            bench.HOLDOUTS = exclusions

    bench.instrument_runner = instrument
    bench.collect_environment = environment
    bench.run_logged = run_logged
    bench.git = git
    bench.hash_product = archive
    try:
        source = bench.run_arm(root, output, arm["commit"], switches, workers=workers, offline=offline)
    finally:
        bench.instrument_runner = original_instrument
        bench.collect_environment = original_environment
        bench.run_logged = original_log
        bench.git = original_git
        bench.hash_product = original_archive
    versions = coordinator.combine(output, source)
    if model:
        source["scorecard_model_artifacts"] = _model_pins(versions, model, output)
    source["commands"] = dict(sorted(recorded_commands.items()))
    source["scorecard_model_version"] = model
    source["scorecard_model_probe_sha256"] = coordinator.digest(Path(__file__).with_name("development-models.ts").read_bytes())
    raw = output / "receipt.json"
    coordinator.write_json(raw, {"schemaVersion": 1, "name": arm["id"], "commit": arm["commit"],
                                 "tool": coordinator.tool_hashes(), "versions": versions, "source": source})
    return source, versions, raw


def _model_pins(versions, model, output):
    successful = [score["scorecard"] for run in versions.values() for score in run["scores"]
                  if score["scorecard"]["succeeded"]]
    if not successful:
        raise ValueError(f"No successful product council call to {model}. See {output} for native receipts.")
    pins = [sample["pinnedArtifacts"] for sample in successful if "pinnedArtifacts" in sample]
    if not pins or not pins[0]["sha256"] or any(value != pins[0] for value in pins):
        raise ValueError(f"Missing or inconsistent artifact pins for {model}. See {output} for native receipts.")
    return pins[0]


def _now():
    return datetime.now(timezone.utc).isoformat()


def normalize_development(arm, source, versions, raw, command):
    cases = []
    metrics = {name: [] for name in ("first_progress_ms", "final_answer_ms", "cpu_ms_per_turn")}
    turns = {}
    observed = {metric: {} for metric in metrics}
    peaks = []
    disks = []
    residents = []
    for suite, spec in SUITES["suites"].items():
        if "version" not in spec:
            continue
        for score in versions[spec["version"]]["scores"]:
            cases.append({"suite_id": suite, "case_id": score["id"], "family": score[spec["area_field"]],
                          "language": score["language"], "correct": score["passed"]})
            samples = score["scorecard"]
            turns[score["language"]] = turns.get(score["language"], 0) + samples["expectedTurns"]
            peaks.append(samples["peakRssBytes"])
            disks.append(samples.get("diskBytes"))
            residents.append(samples.get("residentBytes"))
            for turn in filter(None, samples["turns"]):
                for metric, name in zip(metrics, ("firstProgressMs", "finalAnswerMs", "cpuMs"), strict=True):
                    if turn[name] is not None:
                        metrics[metric].append(turn[name])
                        counts = observed[metric]
                        counts[score["language"]] = counts.get(score["language"], 0) + 1
    unmeasured = {metric: "The fixture did not observe the event for any turn." for metric, values in metrics.items() if not values}
    if "cpu_ms_per_turn" in unmeasured:
        unmeasured["cpu_ms_per_turn"] = "The fixture could not sample process and child CPU accounting for any turn."
    metrics = {metric: values or None for metric, values in metrics.items()}
    metrics.update({"peak_rss_bytes": max(peaks, default=None),
                    "model_files_bytes": max(disks) if disks and all(value is not None for value in disks) else None,
                    "resident_worker_bytes": max((value for value in residents if value is not None), default=None)})
    if metrics["model_files_bytes"] is None:
        unmeasured["model_files_bytes"] = "The active registry artifacts or their census were unavailable in one or more workers."
    if metrics["resident_worker_bytes"] is None:
        unmeasured["resident_worker_bytes"] = "The development harness has no resident worker memory observations."
    return {
        "arm": arm["id"], "commit": arm["commit"], "cases": cases, "metrics": metrics,
        **({"model_version": arm["model_version"]} if arm.get("model_version") else {}),
        "turns_by_language": turns, "unmeasured": unmeasured, "machine": machine_details(),
        "samples_by_language": {metric: {language: counts.get(language, 0) for language in turns}
                                for metric, counts in observed.items() if counts},
        "evidence": {"command": command, "recorded_at": _now(), "raw_output": str(raw)},
        "sources": list(source["commands"].values()),
    }


def run_development(root, output, arms, *, workers=1, offline=False, command=None, models_root=None, python=None):
    root, output = safe_input_path(root), safe_input_path(output)
    if output.is_relative_to(root):
        raise ValueError("Development receipts require an output directory outside the checkout")
    for arm in arms:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", arm["id"]):
            raise ValueError("Invalid development arm ID")
    if command is None:
        command = [sys.executable, "-B", "-m", "scripts.scorecard", *_public_args(sys.argv[1:])]
    model_settings = {}
    if models_root is not None:
        model_settings["MOHASSAN_MODELS_ROOT"] = str(safe_input_path(models_root))
    if python is not None:
        safe_input_path(python)
        # Python discovers the venv from the lexical entry point even when that entry point is a symlink.
        model_settings["EXECUTOR_PYTHON"] = str(Path(python).absolute())
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    receipts = []
    with development_modules(root) as (coordinator, bench):
        for arm in arms:
            directory = output / arm["id"]
            directory.mkdir(mode=0o700)
            print(f'{arm["id"]}: measuring {arm["commit"]}', flush=True)
            source, versions, raw = _run_one(root, directory, arm, coordinator, bench, workers, offline, model_settings)
            receipts.append(normalize_development(arm, source, versions, raw, command))
    return receipts


def _public_args(args):
    private = {"--private-suite", "--private-evaluator"}
    public = []
    remaining = iter(args)
    for arg in remaining:
        key, equal, _ = arg.partition("=")
        if key in private:
            if not equal:
                next(remaining, None)
            public.extend((key, "<owner-local>"))
        else:
            public.append(arg)
    return public

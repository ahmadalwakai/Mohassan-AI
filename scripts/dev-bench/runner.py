"""Run pinned development harnesses against a disposable, detached product checkout."""

from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory

from monitor_audit import instrument_observer, instrument_product, instrument_scoring

V1_BUNDLE = "a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f"
V2_BUNDLE = "12cedfe592aab40cdd47ee00d05ea86a6d2bae89"
AUDIT = "a1e1cb020b7ba093885edbf501149e7b8252c0cb"
ADAPTERS = "0dfff7c54d3658a02cf878ff11faac7f630a6c10"
BENCH = "scripts/agent-capability-bench"
FIXTURES = "tests/fixtures/agent-capability-bench"
V2_DEV = f"{FIXTURES}/v2/dev"
LANES = 8
COMMON = ("run.ts", "corpus.ts", "observe.ts", "score.ts")
V2_HARNESS = (*COMMON, "v2/dev.ts", "v2/sealed.ts", "v2/mapping.ts")
HOLDOUTS = (f"{FIXTURES}/holdout", f"{FIXTURES}/v2/sealed")
NODE_OPTIONS = ("--no-wasm-tier-up", "--no-wasm-dynamic-tiering", "--import", "tsx")
BASE_FLAGS = {
    "MOHASSAN_SMALL_TALK_MANNERS": "1",
    "MOHASSAN_CONVERSATION_REVIEW_APPLY": "1",
    "MOHASSAN_CONVERSATION_SHADOW": "decide",
    "MOHASSAN_STRUCTURED_MEMORY": "1",
    "MOHASSAN_EXTRACTIVE_WRITING": "1",
    "MOHASSAN_PLAN_COMPILER": "on",
    "MOHASSAN_REASONING": "1",
    "MOHASSAN_CLARIFY_CHOICES": "1",
    "MOHASSAN_SCRATCH_CLASSIFIERS": "1",
    "MOHASSAN_REFUSAL_POLICY": "1",
    "TEST_DRIVEN_CODING_ENABLED": "true",
    "MOHASSAN_QUESTION_REWRITER": "1",
}
ARBITER_FLAGS = (
    "MOHASSAN_ARBITER_ROUTING",
    "MOHASSAN_ARBITER_QUESTION_REWRITE",
    "MOHASSAN_ARBITER_LOCAL_COMPUTATION",
    "MOHASSAN_ARBITER_COMPOUND_PLAN",
)
OVERRIDES = {
    "MOHASSAN_PLAN_COMPILER": {"on", "off"},
    "MOHASSAN_CONVERSATION_SHADOW": {"decide", "0"},
    "TEST_DRIVEN_CODING_ENABLED": {"true", "false"},
    "MOHASSAN_MODEL_RELATIONS": {"off", "shadow"},
    **{name: {"0", "1"} for name in (
        *(BASE_FLAGS.keys() - {"MOHASSAN_PLAN_COMPILER", "MOHASSAN_CONVERSATION_SHADOW",
                              "TEST_DRIVEN_CODING_ENABLED"}),
        "MOHASSAN_ARITHMETIC_SEARCH",
        "MOHASSAN_REPLY_POLICY_ENABLED",
        "MOHASSAN_CONTEXT_POLICY_ENABLED",
        "MOHASSAN_LONG_RUN_ENABLED",
        "MOHASSAN_BACKGROUND_RESULTS_ENABLED",
        "MOHASSAN_MONITORS_ENABLED",
        "MOHASSAN_MONITORS_V2",
        *ARBITER_FLAGS,
        *(f"{flag}_KILL" for flag in ARBITER_FLAGS),
    )},
}

APPLY_ADAPTERS = """
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [adapterFile, observer, version] = process.argv.slice(2);
const { adaptObserver } = await import(pathToFileURL(adapterFile).href);
const adapters = ['review', 'memory', ...(version === 'v2' ? ['clarification'] : [])];
const source = readFileSync(observer, 'utf8');
writeFileSync(observer, adaptObserver(source, adapters.map(adapter => ({ adapter })), 'on'));
"""

SCORE_WITH_REPLIES = """{
          const observation = await observe(item);
          if (observation.turns.some(turn => turn.modelCalls > 0
            || turn.boundaryCalls.some(call => call.tool === 'unexpected_fetch'))) {
            throw new CapabilityCorpusError('A development fixture attempted a model or network call.');
          }
          scores.push({ ...scoreCapabilityCase(item, observation),
            replies: observation.turns.map(turn => turn.answer) });
        }"""


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return file_digest(handle, "sha256").hexdigest()


def git(directory: Path, *args: str, input_bytes: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", "-C", str(directory), *args],
        input=input_bytes, stdout=subprocess.PIPE, check=True,
    ).stdout


def hash_product(repo: Path, commit: str) -> str:
    args = ["git", "-C", str(repo), "archive", "--format=tar", commit, "--", ".",
            *(f":(exclude){path}" for path in HOLDOUTS)]
    with subprocess.Popen(args, stdout=subprocess.PIPE) as process:
        result = file_digest(process.stdout, "sha256").hexdigest()
        if process.wait() != 0:
            raise subprocess.CalledProcessError(process.returncode, args)
    return result


def install_inputs(
    repo: Path, checkout: Path, revision: str, paths: tuple[str, ...],
    inputs: dict[str, str], label: str,
) -> list[Path]:
    files = git(repo, "ls-tree", "-rz", "--name-only", revision, "--", *paths).decode().split("\0")[:-1]
    if not files or any(path.startswith(tuple(f"{directory}/" for directory in HOLDOUTS)) for path in files):
        raise ValueError("Expected pinned development inputs only")
    installed = []
    for path in files:
        data = git(repo, "show", f"{revision}:{path}")
        destination = checkout / path
        if destination.exists():
            raise ValueError(f"Product already has benchmark input {path}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        inputs[f"{label}/{path}"] = sha256(data).hexdigest()
        installed.append(destination)
    return installed


def apply_once(source: str, before: str, after: str) -> str:
    if source.count(before) != 1:
        raise ValueError(f"Pinned runner no longer has one instrumentation point for {before!r}")
    return source.replace(before, after)


def instrument_runner(path: Path, version: str) -> None:
    source = path.read_text()
    if version == "v1":
        source = apply_once(source, "for (const item of cases) scores.push(scoreCapabilityCase(item, await observe(item)));",
                            f"for (const item of cases) {SCORE_WITH_REPLIES}")
        source = apply_once(source, "summary, splits: results,",
                            "summary, splits: results, caseOrder: corpus.development.map(item => item.id),")
    else:
        source = apply_once(source, "  const development = paths.split === 'development';", f"""  const development = paths.split === 'development';
  const index = Number(process.env.DEV_BENCH_LANE);
  const count = {LANES};
  if (!development || !Number.isInteger(index) || index < 0 || index >= count) {{
    throw new CapabilityCorpusError('Expected a development lane index from 0 to {LANES - 1}.');
  }}""")
        source = apply_once(
            source,
            "for (const item of corpus.cases) scores.push(scoreCapabilityCase(item, await observe(item)));",
            f"""for (let position = index; position < corpus.cases.length; position += count) {{
        const item = corpus.cases[position]!;
        {SCORE_WITH_REPLIES}
      }}""",
        )
        source = apply_once(source, "{ split: paths.split, scores }",
                            "{ split: paths.split, lane: { index, count }, caseOrder: corpus.cases.map(item => item.id), scores }")
    path.write_text(source)


def run_logged(args: list[str], cwd: Path, environment: dict[str, str], log: Path) -> None:
    with log.open("xb") as output:
        completed = subprocess.run(args, cwd=cwd, env=environment, stdout=output, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError(f"{Path(args[0]).name} exited {completed.returncode}. See {log}")


def collect_environment(overrides: dict[str, str], temporary: Path) -> tuple[dict[str, str], dict[str, str]]:
    for name, value in overrides.items():
        if name == "TEST_DRIVEN_CODING_PYTHON" and Path(value).is_absolute():
            continue
        if name not in OVERRIDES or value not in OVERRIDES[name]:
            raise ValueError(f"Unsupported development benchmark setting {name}")

    real_home = pwd.getpwuid(os.getuid()).pw_dir
    if real_home == "/" or not Path(real_home).is_dir():
        raise ValueError("Use a service account with a normal home directory for desktop fixtures")
    settings = BASE_FLAGS | overrides
    runtime = {
        "PATH": os.environ["PATH"],
        "HOME": real_home,
        "LANG": "C.UTF-8",
        "TZ": "UTC",
        "TMPDIR": str(temporary),
        **({"PLAYWRIGHT_BROWSERS_PATH": os.environ["PLAYWRIGHT_BROWSERS_PATH"]}
           if "PLAYWRIGHT_BROWSERS_PATH" in os.environ else {}),
    }
    return runtime | settings, settings


def executable(program: str, environment: dict[str, str]) -> Path:
    path = shutil.which(program, path=environment["PATH"])
    if path is None:
        raise ValueError(f"Development benchmark requires {program}")
    return Path(path)


def toolchain(
    checkout: Path, environment: dict[str, str], inputs: dict[str, str],
) -> dict[str, object]:
    versions = {"nodeOptions": list(NODE_OPTIONS), "home": environment["HOME"], "timeZone": environment["TZ"]}
    commands = [("node", ["--version"]), ("npm", ["--version"]), ("python3", ["--version"])]
    coding = environment.get("TEST_DRIVEN_CODING_PYTHON", "/usr/bin/python3")
    if Path(coding).is_file():
        commands.append((coding, ["--version"]))
    for name, args in commands:
        path = executable(name, environment)
        inputs[f"executable/{name}"] = digest(path)
        versions[name] = subprocess.check_output([str(path), *args], env=environment, text=True).strip()

    browsers = subprocess.check_output(
        ["node", "--input-type=module", "-e", """
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const core = dirname(require.resolve('playwright-core/package.json'));
const { registry } = require(join(core, 'lib/coreBundle.js')).registry;
for (const browser of ['chromium', 'chromium-headless-shell']) {
  console.log(registry.findExecutable(browser).executablePath());
}
"""],
        cwd=checkout, env=environment, text=True,
    ).splitlines()
    for name, browser in zip(("chromium", "chromium-headless-shell"), browsers, strict=True):
        path = Path(browser)
        if not path.is_file():
            raise ValueError("Install the lockfile's Playwright Chromium and headless shell before the benchmark")
        inputs[f"executable/{name}"] = digest(path)
        versions[name] = subprocess.check_output([browser, "--version"], env=environment, text=True).strip()
    versions["chromiumBuild"] = Path(browsers[0]).parent.parent.name
    libraries = subprocess.check_output(["ldconfig", "-p"], env=environment, text=True)
    for line in libraries.splitlines():
        if line.strip().startswith("libseccomp.so.2 ") and " => " in line:
            inputs["library/libseccomp.so.2"] = digest(Path(line.rsplit(" => ", 1)[1]))
            break
    else:
        raise ValueError("Development benchmark requires libseccomp.so.2")
    return versions


def run_arm(
    repo: Path, output: Path, commit: str, overrides: dict[str, str], *,
    workers: int = LANES, offline: bool = False, monitor_audit: bool = False,
) -> dict[str, object]:
    """Write native split receipts under an existing empty, private output directory."""
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("The measured commit must be a full SHA")
    if not 1 <= workers <= LANES:
        raise ValueError(f"Expected 1 to {LANES} workers for the {LANES} v2 lanes")
    repo, output = repo.resolve(), output.resolve()
    if git(repo, "cat-file", "-t", commit).strip() != b"commit":
        raise ValueError("The measured SHA must identify a commit")
    if git(repo, "rev-parse", f"{V2_BUNDLE}:{V2_DEV}") != git(repo, "rev-parse", f"{AUDIT}:{V2_DEV}"):
        raise ValueError("The pinned v2 development release does not match the audit tree")

    inputs = {"product/git-archive.tar": hash_product(repo, commit)}
    receipts = {}
    pins = {"v1": V1_BUNDLE, "v2": V2_BUNDLE, "audit": AUDIT, "adapters": ADAPTERS}
    with TemporaryDirectory(prefix="checkout-", dir=output) as scratch:
        temporary = Path(scratch)
        checkout = temporary / "product"
        environment, settings = collect_environment(overrides, temporary)
        git(repo, "worktree", "add", "--detach", "--no-checkout", str(checkout), commit)
        try:
            patterns = ("/*", *(f"!/{path}/" for path in HOLDOUTS))
            git(checkout, "sparse-checkout", "set", "--no-cone", "--stdin",
                input_bytes=("\n".join(patterns) + "\n").encode())
            git(checkout, "checkout", "--detach")
            lock = checkout / "package-lock.json"
            inputs["product/package-lock.json"] = digest(lock)
            install_environment = environment | {
                "npm_config_cache": os.environ.get("npm_config_cache", str(temporary / "npm-cache")),
                **({"ELECTRON_SKIP_BINARY_DOWNLOAD": "1"} if offline else {}),
            }
            install = ["npm", "ci", "--no-audit", "--no-fund", *(["--offline"] if offline else [])]
            run_logged(install, checkout, install_environment, output / "npm-ci.log")
            versions = toolchain(checkout, environment, inputs)
            versions["v2ConcurrentWorkers"] = workers
            versions["npmInstall"] = install

            for version, revision, harness, payload in (
                ("v1", V1_BUNDLE, COMMON, (f"{FIXTURES}/manifest.json", f"{FIXTURES}/development.json")),
                ("v2", AUDIT, V2_HARNESS, (V2_DEV,)),
            ):
                if version == "v2":
                    # The audit merge sets MERGE_HEAD but leaves the source revision at the measured commit.
                    git(checkout, "-c", "user.name=Development benchmark", "-c", "user.email=dev-bench@example.invalid",
                        "merge", "--no-ff", "--no-commit", AUDIT)
                    git(checkout, "restore", "--source=HEAD", "--staged", "--worktree", "--", ".")
                    # Remove index-only holdout paths without checking out their contents.
                    git(checkout, "restore", "--ignore-skip-worktree-bits", "--source=HEAD", "--staged", "--", ".")
                    if git(checkout, "status", "--porcelain", "--untracked-files=no"):
                        raise ValueError("Audit merge changed the measured product")

                mounted = install_inputs(repo, checkout, revision, tuple(f"{BENCH}/{file}" for file in harness), inputs, version)
                mounted += install_inputs(repo, checkout, revision, payload, inputs, version)
                adapter_path = f"{BENCH}/by-branch.mjs"
                mounted += install_inputs(repo, checkout, ADAPTERS, (adapter_path,), inputs, version)
                runner = checkout / BENCH / "run.ts"
                observe = checkout / BENCH / "observe.ts"
                subprocess.run(["node", "--input-type=module", "-e", APPLY_ADAPTERS, "dev-bench-adapter",
                                str(checkout / adapter_path), str(observe), version],
                               cwd=checkout, env=environment, check=True)
                instrument_runner(runner, version)
                if monitor_audit:
                    mounted.append(instrument_observer(observe))
                    instrument_scoring(runner)
                    for file in instrument_product(checkout):
                        inputs[f"{version}/effective/{file.relative_to(checkout)}"] = digest(file)
                    inputs[f"{version}/effective/monitor-audit.mjs"] = digest(mounted[-1])
                inputs[f"{version}/effective/observe.ts"] = digest(observe)
                inputs[f"{version}/effective/run.ts"] = digest(runner)
                if any((checkout / path).exists() for path in HOLDOUTS):
                    raise ValueError("A holdout fixture directory was materialized")

                common = ["node", *NODE_OPTIONS, f"{BENCH}/run.ts"]
                if version == "v1":
                    receipt = output / "v1-development.json"
                    run_logged([*common, "--output", str(receipt)], checkout, environment, output / "v1.log")
                    receipts[receipt.name] = digest(receipt)
                    for path in mounted:
                        path.unlink()
                    if monitor_audit:
                        git(checkout, "restore", "--worktree", "--", "apps/server/src/monitors", "packages/browser/src/network.ts")
                else:
                    def run_lane(index: int) -> tuple[str, str]:
                        receipt = output / f"v2-lane-{index}.json"
                        run_logged([*common, "--v2-dev", "--output", str(receipt)], checkout,
                                   environment | {"DEV_BENCH_LANE": str(index)}, output / f"v2-lane-{index}.log")
                        return receipt.name, digest(receipt)

                    with ThreadPoolExecutor(max_workers=workers) as pool:
                        receipts.update(pool.map(run_lane, range(LANES)))

                journal = checkout / ".data/model-relations-shadow.jsonl"
                if journal.is_file():
                    receipt = output / f"{version}-shadow.jsonl"
                    journal.rename(receipt)
                    receipts[receipt.name] = digest(receipt)
        finally:
            git(repo, "worktree", "remove", "--force", str(checkout))

    return {"commit": commit, "pins": pins, "inputs": inputs, "settings": settings,
            "toolchain": versions, "receipts": receipts}

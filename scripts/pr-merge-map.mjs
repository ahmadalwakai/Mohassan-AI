import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const baseBranch = 'feat/skill-engine';
const heldBase = 'c2a0ff765071657cf200b5ee7d12fabaad738c0b';
const trainingWarning = 'merge only after the v5 training run has finished';
const heldFolder = /^(?:apps\/web\/components|packages\/(?:google-ads\/src|browser\/src|chrome-extension|providers\/src)|apps\/android)\//;
const held = /^(?:apps\/server\/src\/(?:app|chrome-extension|command-chat|config|inference|members|assistant\/(?:ads-model-chat|agent-run|brain|campaign-run|tools|hands))\.ts$|packages\/contracts\/src\/(?:ai-providers|campaign-progress|command-chat|google-ads)\.ts$|docs\/(?:CHAT-MODEL-TRAINING-PLAN|CHROME-EXTENSION|FREELLMAPI|GOOGLE-ADS)\.md$|tests\/(?:(?:ads-own-campaign-chat|campaign-progress-chat|chrome-extension-api|chrome-extension-transport|run-view|google-ads[^/]*)\.test\.ts|fixtures\/google-ads-mock\.ts|e2e\/chrome-extension-panel\.spec\.ts)$)/;
const pinned = /^packages\/execution-(?:pipeline|model)\//;

export function git(cwd, args, { input, statuses = [0], statusOnly = false } = {}) {
  const result = spawnSync('git', args, {
    cwd, input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.error) throw result.error;
  if (!statuses.includes(result.status)) {
    throw new Error(`git ${args[0]} failed (status ${result.status ?? result.signal})`);
  }
  return statusOnly ? result.status : result.stdout;
}

export function parseRemoteRefs(output) {
  const branches = new Map();
  const pulls = [];
  for (const line of output.trim().split('\n')) {
    const [sha, ref] = line.split('\t');
    const match = /^refs\/pull\/(\d+)\/head$/.exec(ref);
    if (match) pulls.push({ number: Number(match[1]), head: sha, ref });
    if (ref?.startsWith('refs/heads/')) branches.set(ref.slice(11), sha);
  }
  pulls.sort((a, b) => a.number - b.number);
  return { branches, pulls: pulls.map(pull => ({
    ...pull,
    branches: [...branches.keys()].filter(name => branches.get(name) === pull.head).sort(),
  })) };
}

export function parseNumstat(output) {
  return output.split('\0').filter(Boolean).map(entry => {
    const [, added, removed, path] = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
    return { path, added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) };
  });
}

const diffArgs = ['diff', '--no-renames', '--no-ext-diff', '--no-textconv'];

function migrationIds(cwd, revision) {
  const output = git(cwd, [
    'grep', '-h', '-o', '-I', '-E', "['\x22`][0-9]{3}_[a-zA-Z0-9_]+['\x22`]",
    revision, '--', 'packages/database/src/index.ts',
    ':(glob,icase)**/*migrat*.ts', ':(glob,icase)**/*migrat*.js',
    ':(glob,icase)**/migrations/**', ':(exclude,glob)**/*.test.*', ':(exclude,glob)**/*.spec.*',
  ], { statuses: [0, 1] });
  return new Set(output.trim().split('\n').filter(Boolean)
    .filter(value => value[0] === value.at(-1)).map(value => value.slice(1, -1)));
}

function pathExists(cwd, revision, path) {
  return git(cwd, ['cat-file', '-e', `${revision}:${path}`],
    { statuses: [0, 1, 128], statusOnly: true }) === 0;
}

export function inspectPull(cwd, base, pull, migrationCache = new Map(), heldRevision = base, heldPathCache = new Map()) {
  const { head } = pull;
  const mergeBase = git(cwd, ['merge-base', base, head]).trim();
  const commits = new Set(git(cwd, ['rev-list', `${base}..${head}`]).trim().split('\n').filter(Boolean));
  const changes = parseNumstat(git(cwd, [...diffArgs, '--numstat', '-z', mergeBase, head]));
  const files = new Set(changes.map(file => file.path));
  const docs = git(cwd, [...diffArgs, '--diff-filter=A', '--name-only', '-z', mergeBase, head])
    .split('\0').filter(path => path.startsWith('docs/'));
  const patch = git(cwd, [...diffArgs, '--binary', mergeBase, head]);
  const patchId = git(cwd, ['patch-id', '--stable'], { input: patch }).trim().split(' ')[0];
  for (const revision of [mergeBase, head]) {
    if (!migrationCache.has(revision)) migrationCache.set(revision, migrationIds(cwd, revision));
  }
  const migrations = [...migrationCache.get(head)].filter(id => !migrationCache.get(mergeBase).has(id)).sort();
  const heldEdits = [];
  const newInHeldFolders = [];
  for (const file of changes) {
    const inHeldFolder = heldFolder.test(file.path);
    if (!inHeldFolder && !held.test(file.path)) continue;
    if (!heldPathCache.has(file.path)) {
      heldPathCache.set(file.path, pathExists(cwd, heldRevision, file.path));
    }
    if (heldPathCache.get(file.path)) {
      heldEdits.push({ ...file, overLimit: file.added !== null && file.added + file.removed > 5 });
    } else if (inHeldFolder && pathExists(cwd, head, file.path)) {
      newInHeldFolders.push(file.path);
    }
  }
  return {
    ...pull, mergeBase, commits, files, docs, patchId, migrations,
    added: changes.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: changes.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    binary: changes.filter(file => file.added === null).length,
    held: heldEdits, newInHeldFolders,
    pinned: [...files].filter(path => pinned.test(path)),
  };
}

export function comparePulls(a, b) {
  const shared = [...a.files].filter(file => b.files.has(file)).length;
  const union = a.files.size + b.files.size - shared;
  const overlap = union ? shared / union : 0;
  const samePatch = Boolean(a.patchId && a.patchId === b.patchId);
  return {
    aContainsB: [...b.commits].every(commit => a.commits.has(commit)),
    bContainsA: [...a.commits].every(commit => b.commits.has(commit)),
    overlap, samePatch, duplicate: overlap >= 0.8 || samePatch,
  };
}

export function migrationCollisions(pulls) {
  const versions = new Map();
  for (const pull of pulls) {
    for (const id of pull.migrations) {
      const version = id.slice(0, 3);
      if (!versions.has(version)) versions.set(version, []);
      versions.get(version).push({ id, number: pull.number });
    }
  }
  return [...versions].sort(([a], [b]) => a.localeCompare(b))
    .filter(([, entries]) => new Set(entries.map(entry => entry.number)).size > 1);
}

export function conflictingFiles(cwd, a, b) {
  const output = git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b],
    { statuses: [0, 1] });
  const [tree, ...paths] = output.split('\0');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) throw new Error('Unexpected git merge-tree output');
  return [...new Set(paths.filter(Boolean))].sort();
}

function conflictClusters(conflicts) {
  const neighbors = new Map();
  for (const { a, b } of conflicts) {
    if (!neighbors.has(a)) neighbors.set(a, []);
    if (!neighbors.has(b)) neighbors.set(b, []);
    neighbors.get(a).push(b);
    neighbors.get(b).push(a);
  }
  const clusters = [];
  for (const start of neighbors.keys()) {
    const members = new Set([start]);
    for (const member of members) {
      for (const adjacent of neighbors.get(member)) members.add(adjacent);
      neighbors.delete(member);
    }
    clusters.push({
      members: [...members].sort((a, b) => a - b),
      pairs: conflicts.filter(({ a, b }) => members.has(a) && members.has(b)).length,
    });
  }
  return clusters.sort((a, b) => b.members.length - a.members.length || b.pairs - a.pairs || a.members[0] - b.members[0]);
}

export function alternativePairs(pulls) {
  const byBranch = new Map();
  const pairs = new Map();
  for (const pull of pulls) {
    for (const name of pull.branches) {
      if (!byBranch.has(name)) byBranch.set(name, []);
      byBranch.get(name).push(pull.number);
    }
  }
  for (const [name, alternatives] of byBranch) {
    if (!name.endsWith('-alt')) continue;
    for (const original of byBranch.get(name.slice(0, -4)) ?? []) {
      for (const alternative of alternatives) {
        if (alternative === original) continue;
        const [a, b] = [original, alternative].sort((a, b) => a - b);
        pairs.set(`${a}/${b}`, { a, b });
      }
    }
  }
  return [...pairs.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}

export function suggestOrder(pulls, containment, conflicts, holds = new Set(), alternatives = alternativePairs(pulls)) {
  const integration = pull => pull.branches.some(name => name.startsWith('integration/'));
  const preference = (a, b) => Number(integration(b)) - Number(integration(a)) || a.number - b.number;
  const pending = new Map(pulls.map(pull => [pull.number, pull]));
  const coveredBy = new Map();
  const selected = new Set();
  const steps = [];
  const skippedAlternatives = [];
  const alternativesByPR = new Map(pulls.map(({ number }) => [number, []]));
  for (const { a, b } of alternatives) {
    alternativesByPR.get(a).push(b);
    alternativesByPR.get(b).push(a);
  }
  const conflictsAgainstPicks = number => conflicts.filter(({ a, b }) =>
    (a === number && selected.has(b)) || (b === number && selected.has(a)));
  let cumulative = 0;

  for (const pull of pulls) {
    if (holds.has(pull.number) || !pull.commits.size) pending.delete(pull.number);
  }
  while (pending.size) {
    const eligible = [...pending.values()].filter(pull => !containment.some(({ child, parent, equal }) => (
      child === pull.number && pending.has(parent) && (!equal || preference(pending.get(parent), pull) < 0)
    )));
    const scores = new Map(eligible.map(({ number }) => [number, conflictsAgainstPicks(number)]));
    const rank = (a, b) => scores.get(a).length - scores.get(b).length || a - b;
    const candidates = eligible.filter(({ number }) => alternativesByPR.get(number)
      .every(other => !scores.has(other) || rank(number, other) < 0));
    const [pull] = candidates.sort((a, b) => Number(integration(b)) - Number(integration(a))
      || rank(a.number, b.number));
    const newConflicts = scores.get(pull.number);
    pending.delete(pull.number);
    const covered = containment.filter(({ parent, child }) => parent === pull.number && pending.has(child))
      .map(({ child }) => child).sort((a, b) => a - b);
    for (const child of covered) {
      pending.delete(child);
      coveredBy.set(child, pull.number);
    }
    for (const kept of [pull.number, ...covered]) {
      for (const other of alternativesByPR.get(kept)) {
        if (pending.delete(other)) {
          skippedAlternatives.push({ number: other, kept, conflicts: conflictsAgainstPicks(other).length });
        }
      }
    }
    selected.add(pull.number);
    cumulative += newConflicts.length;
    const frontier = conflicts.filter(({ a, b }) =>
      (selected.has(a) && pending.has(b)) || (selected.has(b) && pending.has(a)));
    steps.push({ number: pull.number, covered, newConflicts, cumulative, frontier });
  }
  return { steps, coveredBy, skippedAlternatives };
}

function analyze(cwd, pulls) {
  const conflicts = [];
  const duplicates = [];
  const containment = [];
  let pairCount = 0;
  const started = performance.now();
  for (const [index, a] of pulls.entries()) {
    for (const b of pulls.slice(index + 1)) {
      const result = comparePulls(a, b);
      const equal = result.aContainsB && result.bContainsA;
      if (result.aContainsB) containment.push({ child: b.number, parent: a.number, equal });
      if (result.bContainsA) containment.push({ child: a.number, parent: b.number, equal });
      if (result.duplicate) duplicates.push({ a: a.number, b: b.number, ...result });
      const files = conflictingFiles(cwd, a.head, b.head);
      if (files.length) conflicts.push({ a: a.number, b: b.number, files });
      pairCount++;
    }
  }
  return { conflicts, duplicates, containment, pairCount, seconds: (performance.now() - started) / 1000 };
}

const pr = number => `#${number}`;
const pair = ({ a, b }) => `${pr(a)}/${pr(b)}`;
const list = (values, empty = '—') => values.join(', ') || empty;
const code = value => `<code>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('\n', '&#92;n')}</code>`;
const files = paths => list(paths.map(code));
const heldEdit = ({ path, added, removed, overLimit }) => (
  `${code(path)} ${added === null ? '(binary)' : `+${added}/−${removed}`}${overLimit ? ' **>5**' : ''}`
);

function report({ pulls, base, version, taken, analysis, holds, excludeBranch }) {
  const { conflicts, duplicates, containment, pairCount, seconds } = analysis;
  const collisions = migrationCollisions(pulls);
  const pinnedPulls = pulls.filter(pull => pull.pinned.length);
  const largeEdits = pulls.map(pull => ({
    number: pull.number, edits: pull.held.filter(edit => edit.overLimit),
  })).filter(pull => pull.edits.length);
  const largeEditCount = largeEdits.reduce((sum, pull) => sum + pull.edits.length, 0);
  const clusters = conflictClusters(conflicts);
  const alternatives = alternativePairs(pulls);
  const { steps, coveredBy, skippedAlternatives } = suggestOrder(pulls, containment, conflicts, holds, alternatives);
  const parents = new Map();
  for (const { child, parent } of containment) {
    if (!parents.has(child)) parents.set(child, []);
    parents.get(child).push(parent);
  }
  const command = ['node scripts/pr-merge-map.mjs', ...[...holds].map(n => `--hold ${n}`),
    ...(excludeBranch ? [`--exclude-branch ${excludeBranch}`] : [])].join(' ');
  const lines = [
    '# PR merge map',
    '',
    '## ملخص للمالك',
    '',
    `- عدد طلبات السحب: ${pulls.length}. عدد الأزواج المفحوصة: ${pairCount}، منها ${conflicts.length} متعارضة و${duplicates.length} متشابهة. عدد الطلبات المحتواة: ${parents.size}.`,
    `- الأزواج المتشابهة: ${list(duplicates.map(entry => `${pair(entry)} (${(100 * entry.overlap).toFixed(1)}%${entry.samePatch ? '، معرّف الرقعة مطابق' : ''})`), 'لا يوجد')}.`,
    `- البدائل حسب أسماء الفروع (يُختار واحد من كل زوج): ${list(alternatives.map(pair), 'لا يوجد')}.`,
    `- الطلبات المحتواة والفروع التي تضمّها: ${list([...parents].sort(([a], [b]) => a - b)
      .map(([child, containers]) => `${pr(child)} ← ${containers.sort((a, b) => a - b).map(pr).join(' / ')}`), 'لا يوجد')}.`,
    `- الطلبات التي تمس مسارات التدريب المثبّتة (${pinnedPulls.length}): ${list(pinnedPulls.map(pull => pr(pull.number)), 'لا يوجد')}. شرط الدمج لهذه المسارات هو انتهاء تشغيل التدريب v5.`,
    `- أرقام إصدارات الترحيل المشتركة (${collisions.length}): ${list(collisions.map(([version, entries]) =>
      `${code(version)} (${entries.map(({ id, number }) => `${pr(number)} ${code(id)}`).join(' / ')})`), 'لا يوجد')}.`,
    `- تعديلات الملفات المحجوزة التي تتجاوز خمسة أسطر: ${largeEditCount} عبر ${largeEdits.length} من الطلبات.`,
    ...largeEdits.map(({ number, edits }) => `  - ${pr(number)}: ${list(edits.map(heldEdit))}`),
    `- أكبر مجموعات التعارض المتصلة: ${list(clusters.slice(0, 3).map(({ members, pairs }) =>
      `الطلبات: ${members.length}، أزواج التعارض: ${pairs} (${list(members.map(pr))})`), 'لا يوجد')}.`,
    '',
    `Snapshot timestamp (UTC) and measured pairwise pass: ${taken} · ${seconds.toFixed(2)} s`,
    `- Git: ${version}. Comparison base: \`${baseBranch}\` at \`${base}\`.`,
    '- Source: Git refs retrieved from [ahmadalwakai/Mohassan-AI](https://github.com/ahmadalwakai/Mohassan-AI) at the snapshot time above. Git PR head refs provide neither open/draft state nor target branch. This map measures the advertised heads against the same comparison base.',
    '- Commits are those reachable from the head and outside the comparison base. File stats use the merge-base diff. Rename detection is disabled to count both affected paths. Binary files have no line counts. A migration collision means multiple PRs add IDs with the same three-digit prefix, including repeated full IDs and copies inherited through containment.',
    '',
    `Held-file edits count paths present at \`${heldBase}\`. Paths newly present in held folders appear in a separate informational column.`,
    '',
    '## Per PR',
    '',
    '| PR | Matching remote branches | Head | Merge base | Commits | Files | Lines +/− | Binary files | Docs added | Migration IDs added | Held files +/− | New files in held folders (info) | Training-pinned paths |',
    '| --- | --- | --- | --- | ---: | ---: | --- | ---: | --- | --- | --- | --- | --- |',
  ];
  for (const pull of pulls) {
    lines.push(`| ${pr(pull.number)} | ${list(pull.branches.map(code), 'No matching remote branch')} | ${code(pull.head)} | ${code(pull.mergeBase)} | ${pull.commits.size} | ${pull.files.size} | +${pull.added}/−${pull.removed} | ${pull.binary} | ${files(pull.docs)} | ${files(pull.migrations)} | ${list(pull.held.map(heldEdit))} | ${files(pull.newInHeldFolders)} | ${pull.pinned.length ? `${files(pull.pinned)} — **${trainingWarning}**` : '—'} |`);
  }
  lines.push('', '## Conflicting pairs', '', '| PR heads | Conflicting files |', '| --- | --- |');
  for (const entry of conflicts) lines.push(`| ${pair(entry)} | ${files(entry.files)} |`);
  if (!conflicts.length) lines.push('| — | No conflicts |');
  lines.push(
    '', '## Suggested merge order', '',
    'Select containing PRs before their children, preferring eligible integration branches. Among equally preferred candidates, select the PR with the fewest conflicting pairs against earlier picks, breaking ties by PR number. Equal commit sets share a single pick. Covered PRs need no separate merge once their parent lands.',
    '',
    'When both named alternatives are eligible, keep the one with fewer conflicts against earlier picks and break ties by PR number. An alternative already covered by a containing pick needs no separate merge. The excluded alternative’s count uses the picks before that decision.',
    '',
    'New conflicts list the pairs introduced by the pick. The cumulative column counts unresolved pairs from this and all earlier rows. The last column lists remaining conflicts between picked and pending PRs. The conflict table above gives the files for each pair. Pairwise results are an ordering heuristic. Actual sequential merges and conflict resolutions can change those results. Near-duplicate pairs without containment still require an owner decision.',
    '',
    '| Step | Pick | Covered by this pick | New conflicts | Cumulative unresolved pairs | Conflicts with remaining picks |',
    '| ---: | --- | --- | --- | ---: | --- |',
  );
  for (const [index, step] of steps.entries()) {
    const pull = pulls.find(pull => pull.number === step.number);
    lines.push(`| ${index + 1} | ${pr(step.number)}${pull.pinned.length ? ` — **${trainingWarning}**` : ''} | ${list(step.covered.map(pr))} | ${list(step.newConflicts.map(pair))} | ${step.cumulative} | ${list(step.frontier.map(pair))} |`);
  }
  if (skippedAlternatives.length) {
    lines.push('', '### Alternatives excluded from the order', '');
    for (const { number, kept, conflicts } of skippedAlternatives.sort((a, b) => a.number - b.number)) {
      lines.push(`- ${pr(number)} not merged: alternative of ${pr(kept)} (${conflicts} conflicting pairs against earlier picks).`);
    }
  }
  const alreadyInBase = pulls.filter(pull => !pull.commits.size).map(pull => pr(pull.number));
  if (alreadyInBase.length) lines.push('', `Already in the comparison base: ${list(alreadyInBase)}.`);
  if (holds.size) lines.push('', `Owner-supplied holds, omitted from the order: ${list([...holds].map(pr))}.`);
  lines.push('', `Suggested standalone merge steps: ${steps.length}. Covered by picks: ${coveredBy.size}.`);
  lines.push(
    '', '## Run again', '',
    'From the repository root with Node and Git 2.38 or newer, run:', '',
    '\`\`\`sh', command, '\`\`\`', '',
    'The default output is \`docs/PR-MERGE-MAP-2026-11-25.md\`. Use \`--output PATH\` to write elsewhere.',
  );
  if (excludeBranch) {
    lines.push(`The snapshot command excludes the report’s own branch, ${code(excludeBranch)}. Omit that option to include it after opening the draft PR.`);
  }
  lines.push('With the same advertised heads, matching branches, comparison base, options and Git version, only the snapshot timestamp and measured elapsed time on that same line vary.', '');
  return lines.join('\n');
}

function main() {
  const { values } = parseArgs({ options: {
    output: { type: 'string', default: 'docs/PR-MERGE-MAP-2026-11-25.md' },
    hold: { type: 'string', multiple: true, default: [] },
    'exclude-branch': { type: 'string' },
  } });
  if (values.hold.some(value => !/^[1-9]\d*$/.test(value))) throw new Error('--hold requires a PR number');
  const holds = new Set(values.hold.map(Number));
  const excludeBranch = values['exclude-branch'];
  const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const version = git(cwd, ['--version']).trim();
  const [, major, minor] = /git version (\d+)\.(\d+)/.exec(version);
  if (Number(major) < 2 || (Number(major) === 2 && Number(minor) < 38)) throw new Error('Git 2.38 or newer is required');
  const remote = git(cwd, ['ls-remote', 'origin', 'refs/heads/*', 'refs/pull/*/head']);
  const taken = new Date().toISOString();
  const { branches, pulls: advertised } = parseRemoteRefs(remote);
  const base = branches.get(baseBranch);
  const pulls = advertised.filter(pull => !excludeBranch || !pull.branches.includes(excludeBranch));
  if (!base || !pulls.length) throw new Error('origin must advertise the comparison base and PR heads');
  git(cwd, ['-c', 'fetch.writeCommitGraph=false', 'fetch', '--no-tags', '--no-recurse-submodules',
    '--no-write-fetch-head', '--refmap=', 'origin', `refs/heads/${baseBranch}`, ...pulls.map(pull => pull.ref)]);
  const migrationCache = new Map();
  git(cwd, ['cat-file', '-e', `${heldBase}^{commit}`]);
  const heldPathCache = new Map();
  const inspected = pulls.map(pull => inspectPull(cwd, base, pull, migrationCache, heldBase, heldPathCache));
  const analysis = analyze(cwd, inspected);
  writeFileSync(values.output, report({ pulls: inspected, base, version, taken, analysis, holds, excludeBranch }));
  console.log(`Wrote ${values.output} for ${pulls.length} PR heads (${analysis.pairCount} pairs in ${analysis.seconds.toFixed(2)} s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

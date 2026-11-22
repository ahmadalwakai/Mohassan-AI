# Agent instructions

Repository-wide rules for every coding agent working on Mohassan AI (Claude Code, Codex and others).

These scoped instruction files stay in force and are not repeated here:

- `apps/web/AGENTS.md`: the Next.js rules for the web app, written by `next dev`.
- `docs/BRAIN-AGENT-INSTRUCTIONS.md`: rules and roles for the brain (Mind C) work.
- `docs/CHAT-MODEL-AGENT-INSTRUCTIONS.md`: rules and roles for training the project's own chat model.

When a scoped file is stricter than this one, follow the stricter rule. For example, the track files forbid commit, push, stash, reset and reformatting, keep each agent to its role's paths, and treat failed gates as hard stops.

## Development Reasoning and Verification

These methods guide decisions and execution. Use the method a situation calls for, and keep its output short. Do not produce all of them for a small change.

| Method | Use it when | It produces |
|---|---|---|
| ELI5 | Explaining a feature, an architecture decision or a technical problem | A plain-Arabic explanation: what it does, why it matters, the main tradeoff |
| SWOT | Before a new project, a substantial feature or a major architecture decision | A brief assessment that ends in one concrete recommendation |
| Premortem | Before substantial implementation or a release | Three failure scenarios turned into requirements and acceptance criteria |
| 5 Whys | A recurring bug, a significant failure or an unclear root cause | A supported cause, its fix, and a regression test where it protects real behavior |
| Complete execution | Every authorized development task | Working changes, verified in proportion to their risk |
| TL;DR | Closing every completed task | A concise Arabic summary of what changed and what was verified |

### ELI5: explanations the owner can follow

- **Trigger:** explaining a feature, an architecture decision or a technical problem.
- **Output:** in plain Arabic, what it does, why it matters and the main tradeoff. Add a short example when it helps.
- Keep the technical content accurate, and name the limitations that matter.
- Code, identifiers, comments and prompts stay in English.
- Match the length to the task: a small fix needs a sentence or two, an architecture change a few short paragraphs.

### SWOT: before consequential decisions

- **Trigger:** starting a new project, introducing a substantial feature, or making a major architecture decision. Skip it for routine edits and minor fixes.
- **Output:** a brief assessment in four parts:
  - Strengths: internal capabilities and advantages.
  - Weaknesses: internal limitations and gaps.
  - Opportunities: relevant external opportunities.
  - Threats: relevant external constraints or risks.
- Ground each point in repository evidence, such as files, measurements and tests, and in the owner's actual goals. Label assumptions and unknowns as such.
- End with one concrete recommendation, and state how it changes the implementation.

### Premortem: before substantial implementation or release

- **Trigger:** before substantial implementation, and before a release.
- Assume the work has failed after launch. Name the three most relevant and plausible failure scenarios. For each one, state:
  - what could fail, and why;
  - the preventive action;
  - the observable check that confirms the prevention works.
- Consider incorrect permissions, inconsistent data, failed integrations, unusable mobile flows or deployment problems only when they are relevant to the task.
- **Output:** each justified preventive action becomes an implementation requirement and an acceptance criterion. Keep the analysis concise and actionable.

### 5 Whys: diagnosing important defects

- **Trigger:** a recurring bug, a significant failure, or a root cause that is not clear.
- Reproduce the problem when possible.
- Inspect the relevant code, logs, inputs, outputs and existing tests.
- Ask why the observed failure happened, then ask the same of each answer.
- Keep confirmed facts apart from hypotheses.
- Stop when the cause is sufficiently supported. Five questions are not a quota.
- When evidence is missing, gather it. Never invent a causal explanation.
- **Output:** a fix for the supported cause, verification of the affected behavior, and a focused regression test when it protects meaningful behavior.

### Complete execution

- **Trigger:** every authorized development task.
- Inspect the actual repository before proposing or editing an implementation.
- Identify the real paths, components, hooks, routes, imports, types, props, data contracts and consumers that the change affects.
- Follow the installed stack and the existing conventions. Do not invent APIs, packages, environment variables or database fields.
- Keep affected customer, driver and admin consumers synchronized when those interfaces exist. In this repository the matching consumers are:
  - the owner and member roles: a member reaches only the `MEMBER_ROUTES` of `apps/server/src/members.ts`, enforced in `apps/server/src/app.ts`;
  - the shared request and response types in `packages/contracts`;
  - the phone apps that call the chat API: `apps/android` here, and `apps/ios` on the `feat/wasla-bridge` and `feat/iphone-daily` branches.
- Include the loading, empty, error, validation and accessibility states the change needs.
- Deliver complete, working changes with no placeholder logic.
- Continue through implementation and proportionate verification within the authorized scope.
- Ask one focused question only when a missing decision materially blocks a correct implementation.
- **Output:** working changes, verified in proportion to their risk.

### TL;DR: closing with a useful result

- **Trigger:** finishing any completed task.
- **Output:** a concise Arabic summary that covers:
  - what changed, and why;
  - the important files or interfaces affected;
  - the verification actually performed, and its results;
  - any unresolved limitation or blocker.
- Never claim a check passed unless it was run and passed. Keep completed work clearly apart from proposed work.

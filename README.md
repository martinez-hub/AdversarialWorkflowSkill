# Adversarial Workflow — multi-agent code review for Claude Code

`/adversarial-workflow` reviews a PR, branch, diff, or path with a **panel of independent reviewers, each looking through a different lens**, deduplicates what they find, and then sends every distinct finding to a **refutation-biased verifier** whose job is to *disprove* it by reading the real code. Only findings that survive are reported — with the lenses that corroborated them and the verifier's reasoning.

```
            ┌─ review:correctness ──┐
            ├─ review:error-handling┤
   diff ───►├─ review:api-compat    ├──► dedup by file:line ──► verify:finding-1 ─┐
            ├─ review:tests         │     (merge lenses)        verify:finding-2 ─┼──► confirmed / refuted
            ├─ review:security      │                           verify:finding-N ─┘
            └─ review:semantic      ┘
```

It is built on Claude Code's [`Workflow` tool](https://code.claude.com/docs/en/workflows.md) (deterministic multi-agent orchestration) and is **slash-command only** — Claude never launches it on its own (`disable-model-invocation: true`), because a run spawns 6–25 subagents and typically costs 250k–1M tokens and 5–10 minutes. Use it for the review you'd otherwise ask a second senior engineer to do — not for every commit.

## Why

Happy-path review and tests miss interaction bugs. In real use this workflow caught, among others, two silent-correctness bugs that *every* existing test missed (a cache path that was never reused because of a working-directory change, and a resume+sample combination that overwrote completed results) — see the design notes below. The refutation stage is what keeps the output usable: reviewers are told an empty list is a good answer, and a skeptic must fail to disprove each claim before you see it.

## Install

**Requirements:** Claude Code ≥ 2.1.154 with the `Workflow` tool available (paid plans; see the [workflows docs](https://code.claude.com/docs/en/workflows.md) for availability), `git`, and `gh` if you want to review PRs by number.

### As a plugin (recommended)

```
/plugin marketplace add martinez-hub/AdversarialWorkflowSkill
/plugin install adversarial-workflow@adversarial-workflow
```

or from a shell: `claude plugin install adversarial-workflow@adversarial-workflow` after adding the marketplace.

### Manually (personal or project skill)

```bash
git clone https://github.com/martinez-hub/AdversarialWorkflowSkill.git
# personal (all projects):
ln -s "$PWD/AdversarialWorkflowSkill/skills/adversarial-workflow" ~/.claude/skills/adversarial-workflow
# or project-local (committed, shared with the team):
cp -r AdversarialWorkflowSkill/skills/adversarial-workflow .claude/skills/
```

The skill folder is self-contained (`SKILL.md` + `adversarial-review.js`); it follows the [Agent Skills](https://agentskills.io) layout so other skill-aware tools can pick it up too.

## Use

```
/adversarial-workflow                      # current branch vs the default branch
/adversarial-workflow 57                   # GitHub PR #57 (works for fork PRs)
/adversarial-workflow feat/export          # a branch vs the default branch
/adversarial-workflow abc123..def456       # a commit range
/adversarial-workflow src/api/             # uncommitted changes under a path
/adversarial-workflow 57 --thorough        # more lenses + 2 diverse verifiers per finding
/adversarial-workflow 57 --profile docs    # force a lens profile (auto-detected otherwise)
```

Claude resolves the target to concrete SHAs, picks a **profile**, gathers a short context blurb (PR description, how to run tests), launches the workflow, and reports:

- **Confirmed** findings grouped by severity, each with `file:line`, trigger, suggested fix, the lenses that independently reported it (`reported_by`), and any merged alternate titles (`also_reported_as`).
- **Refuted** findings with the verifier's one-line reason (so you can overrule).
- Stats: `N raw → M distinct → K confirmed`.

Then it offers to fix all / some / none. It never pushes, merges, or comments on the PR.

### Profiles

| Profile | When | Standard lenses | Extra lenses with `--thorough` |
|---|---|---|---|
| `code` (default) | source changes | correctness, error-handling, api-compat, tests, security, semantic-subtle | performance, packaging-config, docs-accuracy |
| `docs` | only docs/notebooks changed | prose-vs-code, reader-runnability, link-integrity, consistency-regression | docs-build, file-format |
| `deps` | only lockfiles/manifests changed | diff-scope, lock-integrity, supply-chain, manifest-consistency | test-impact, ci-coverage |

`--thorough` also raises verification to **two verifiers with different lenses** (one tries to show the code doesn't do that; one checks scope/severity), and a finding must survive both.

### Advanced args

Claude passes these to the workflow; you can ask for them in plain words ("only review `src/core/`", "use these lenses: …"):

| arg | meaning |
|---|---|
| `paths: [...]` | restrict the diff to sub-paths (recommended for diffs > ~1500 lines: run per area) |
| `context: "..."` | free-text facts given to every agent (test command, PR intent, project conventions) |
| `lenses: [{key, prompt}]` | replace the profile's lens set entirely for unusual diffs |
| `maxVerify` (40) | cap on distinct findings verified; overflow is returned as `unverified`, never dropped silently |

## How it's wired

- `skills/adversarial-workflow/SKILL.md` — what Claude reads when you run `/adversarial-workflow`: resolve target → pick profile → `Workflow({ scriptPath, args })` → report. Includes an `Agent`-tool fallback when `Workflow` isn't available. To let Claude invoke it on its own (e.g. when you say "adversarial review of PR 57"), remove `disable-model-invocation: true` from the frontmatter.
- `skills/adversarial-workflow/adversarial-review.js` — the workflow script. Review phase fans out one agent per lens (`parallel`, a deliberate barrier so findings can be deduplicated before paying for verification); verify phase fans out per distinct finding. Structured output is enforced with JSON schemas. A finding survives only if **every** verifier fails to refute it.
- `tests/run-mock.mjs` — offline tests of the script logic with mocked agents (dedup, refutation, thorough mode, profiles, quoting, caps). `node tests/run-mock.mjs`.
- `tests/make-fixture.sh` — builds a throwaway repo with five planted bugs and one decoy for an end-to-end check (see the script header for what should be confirmed vs refuted, and the reference run numbers).

## Design notes (from real runs)

- **Dedup before verify.** In one real docs-PR run, 16 raw findings verified to 13 "confirmed" — which were 4 distinct bugs (one was verified five times by five lenses). Findings are now merged before verification when they point at the same file and the same line, nearby lines with overlapping titles, or strongly overlapping titles anywhere in the file (on the fixture: 21 raw → 7 distinct, which is the true count). Multi-lens agreement becomes a corroboration signal (`reported_by`) and merged titles are kept (`also_reported_as`) so nothing is silently lost.
- **Lens profiles.** Two of three real runs (a dependency bump, a notebooks/docs PR) needed their lenses rewritten by hand; the `docs` and `deps` profiles are generalized from those runs, and `lenses` lets you override for anything else.
- **Refutation bias is load-bearing.** Reviewers are told "an empty list is a good answer"; verifiers default to `is_real=false`. On a clean dev-dependency bump the workflow returned zero findings; on a feature batch it confirmed 6/6 distinct real bugs (2 high-severity, silent-correctness). Both outcomes are what you want.
- **Thorough ≠ louder.** The previous version's "2 verifiers, majority" let a finding survive with 1 of 2 — *weaker* than one verifier. Now thorough means unanimity across two differently-prompted skeptics.

## Upgrading from the pre-1.0 command

If you used the original `~/.claude/commands/adversarial-workflow.md`, delete it after installing this (otherwise you get two `/adversarial-workflow` entries). Changes: args are passed as a JSON object instead of editing constants in the script; profiles/`paths`/`context`/`lenses`/`maxVerify` are new; results include `refuted`, `unverified`, `reported_by`, `distinct_findings`; PR resolution fetches `pull/N/head` so fork PRs work; default-branch detection no longer assumes `main`.

## License

MIT

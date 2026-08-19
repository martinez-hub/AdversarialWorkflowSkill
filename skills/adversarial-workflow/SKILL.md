---
name: adversarial-workflow
description: Adversarial multi-agent review of a PR, branch, diff, commit range, or path. Slash-command only (/adversarial-workflow) because a run spawns many subagents.
argument-hint: "[PR number | branch | A..B | path | empty = current branch vs default] [--thorough] [--profile code|docs|deps]"
disable-model-invocation: true
compatibility: Claude Code >= 2.1.154 with the Workflow tool enabled; git; gh for PR targets
allowed-tools:
  - Bash(git diff *)
  - Bash(git merge-base *)
  - Bash(git rev-parse *)
  - Bash(git fetch *)
  - Bash(git symbolic-ref *)
  - Bash(git log *)
  - Bash(git branch *)
  - Bash(gh pr view *)
---

# Adversarial Workflow (multi-agent code review)

You are running the **adversarial review** workflow. Requested target: `$ARGUMENTS`

Many independent reviewers (one per *lens*) hunt for real defects in a diff; their findings are deduplicated; then a refutation-biased skeptic tries to **disprove** each one by reading the real code. Only findings that survive are reported. Typical cost: 6–25 subagents, 250k–1M tokens, 5–10 minutes.

## Step 0 — This is an explicit opt-in

This skill is slash-command only (`disable-model-invocation: true`): the user typed `/adversarial-workflow …`, which is the explicit opt-in to multi-agent orchestration the `Workflow` tool requires. You are authorized to call `Workflow` here.

## Step 1 — Resolve the review target

Parse `$ARGUMENTS`: the first token is the target; `--thorough` (or words like deep/exhaustive/audit) sets `thorough: true`; `--profile <name>` forces a lens profile. Then resolve a concrete `base`, `head`, `label` and `repo` with git/gh:

| Target | `base` | `head` | `label` |
|---|---|---|---|
| *(empty)* | `git merge-base HEAD <default>` where `<default>` = `git symbolic-ref --short refs/remotes/origin/HEAD` (fallback `origin/main`, `main`, `origin/master`) | `HEAD` | `<branch> vs <default>` |
| bare number `57` | `git fetch origin pull/57/head:refs/remotes/origin/pr/57` (works for forks) then `git merge-base origin/<baseRefName> origin/pr/57` with `baseRefName` from `gh pr view 57 --json baseRefName --jq .baseRefName` | `origin/pr/57` SHA | `PR #57 — <title>` |
| branch/ref `feat-x` | `git merge-base feat-x <default>` | `feat-x` | `feat-x vs <default>` |
| range `A..B` / `A...B` | `A` | `B` | `A...B` |
| existing path or `.` | `HEAD` | the literal string `WORKTREE` (uncommitted changes; reviewers run `git diff HEAD -- <path>`) | `<path> (working tree)` |

- `repo = $(git rev-parse --show-toplevel)` (absolute). Resolve refs to full SHAs where possible.
- Stop with a clear message if the diff is empty (`git diff --stat base...head`).
- **Pick the profile** from `git diff --stat` unless forced: `docs` if every changed file is documentation (`.md`, `.rst`, `.ipynb`, `docs/`…); `deps` if every changed file is a lockfile/manifest (`uv.lock`, `package-lock.json`, `poetry.lock`, `Cargo.lock`, `go.sum`, `pyproject.toml`/`package.json` version-only bumps); otherwise `code`.
- **Gather a short `context` blurb** (≤ 10 lines) the reviewers will get verbatim: PR title/body (`gh pr view N --json title,body`), how to run the tests/build for this repo (look at `Makefile`, `pyproject.toml`, `package.json`, CI config — only commands you actually verified exist), and anything in CLAUDE.md that matters for review. Don't pad it.
- Large diffs (> ~1500 changed lines): prefer scoping with `paths: [...]` and running the workflow per area rather than one giant run; tell the user you did so.

State the resolved scope in ONE line, e.g. `Reviewing: PR #57 — base abc1234 → head def5678 (profile=code)`.

## Step 2 — Launch the workflow

Call the `Workflow` tool with the script that ships next to this file:

```
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/adversarial-review.js",
  args: {
    repo: "<absolute repo path>",
    base: "<sha or ref>",
    head: "<sha or ref, or WORKTREE>",
    label: "<human label>",
    profile: "code" | "docs" | "deps",
    thorough: false,
    context: "<the blurb from Step 1, or omit>",
    paths: ["optional/subpaths"]          // optional; restricts the diff
  }
})
```

`args` MUST be a real JSON object (not a stringified one). Optional extras: `lenses: [{key, prompt}, …]` replaces the profile's lens set entirely (use when the diff is unusual and you know exactly what to look for); `maxVerify` (default 40) caps how many distinct findings are verified — the overflow is returned as `unverified`, never silently dropped.

Do not edit the script to hardcode values; if something about the script needs to change for this repo, pass `lenses`/`context` instead.

**If the `Workflow` tool is unavailable** in this session (not offered, or it errors as disabled), run the same procedure with the `Agent` tool: launch one agent per lens in parallel with the reviewer prompt from the script (ask for the `findings` JSON), dedupe by `file:line` yourself, then launch one verifier agent per distinct finding with the verifier prompt, and apply the same rule (a finding survives only if no verifier refutes it). Say explicitly that you used the fallback.

## Step 3 — Report, then offer to fix

The workflow returns `{ target, profile, lenses, raw_findings, distinct_findings, confirmed_count, confirmed[], refuted[], unverified[] }`.

Present **confirmed** findings grouped by severity (critical → important → minor). For each: `file:line`, one-line explanation, the suggested fix, and which lenses reported it (`reported_by` — multiple lenses = independent corroboration; `also_reported_as` lists merged duplicate titles). If two confirmed entries are obviously the same defect, merge them in your report. Then one line of stats: `N raw → M distinct → K confirmed; R refuted`. List refuted findings briefly (title + the verifier's one-line reason) so the user can overrule a refutation. If `unverified` is non-empty, say so and offer to re-run with a higher `maxVerify`. If nothing was confirmed, say the change looks clean **for these lenses** — not "bug-free".

Then:
- If the user already asked to fix, fix each confirmed finding (respect project conventions), run the relevant tests, and summarize.
- Otherwise ask: fix all, fix a subset, or just report.

Never merge, push, comment on the PR, or dismiss alerts as part of this skill — review and (on request) local fixes only.

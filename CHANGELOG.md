# Changelog

## 1.0.3 — 2026-10-12

- Fix: the `Workflow` tool rejects a `scriptPath` outside the working directory (`scriptPath must be a script path this tool returned, or a file you can already read`), so launching straight from the skill/plugin directory always failed on the first try and Claude had to improvise. Step 2 now copies `adversarial-review.js` into the session scratchpad and launches from that copy (inline `script` fallback when there is no scratchpad); `Bash(cp ${CLAUDE_SKILL_DIR}/adversarial-review.js *)` added to `allowed-tools`.

## 1.0.2 — 2026-10-03

- Claude can invoke the skill again (`disable-model-invocation` removed). Step 0 is back to the 1.0.0 rule: launch only when the user typed `/adversarial-workflow` or asked in their own words for an adversarial, multi-agent or exhaustive review.

## 1.0.1 — 2026-08-19

- Skill is now slash-command only (`disable-model-invocation: true`); Claude never auto-launches the workflow. Step 0 simplified accordingly.

## 1.0.0 — 2026-08-19

First public release, migrated from a personal `~/.claude/commands/adversarial-workflow.md` (written for Opus 4.8) to a distributable skill/plugin.

- Skill format (`skills/adversarial-workflow/SKILL.md`) + plugin/marketplace manifests; installable via `/plugin marketplace add` or by copying the skill folder.
- Workflow script is a separate file launched with `Workflow({ scriptPath, args })` — no more editing constants into an inline script.
- **Dedup before verify**: findings are merged by file:line / nearby-line + title overlap / strong title overlap; merged titles kept as `also_reported_as`, lenses as `reported_by`. On the fixture: 21 raw → 7 distinct (was 11 with exact-line dedup; the original had no dedup at all).
- **Lens profiles** `code` / `docs` / `deps` (auto-detected from the diff) plus `lenses` override, `paths` scoping, `context` blurb, `maxVerify` cap with `unverified` overflow (never silent).
- **Thorough mode** now means 9 lenses + two differently-prompted verifiers with unanimity required (previously "2 verifiers, majority" let 1-of-2 pass — weaker than one verifier).
- Results include `refuted` (with verifier reasoning) so refutations can be overruled.
- Target resolution: default branch detected via `origin/HEAD`; PRs fetched as `pull/N/head` (fork PRs work); commit ranges supported; null-safe against skipped agents.
- Offline mock test harness (`tests/run-mock.mjs`) and a planted-bug fixture (`tests/make-fixture.sh`); CI runs the mocks.

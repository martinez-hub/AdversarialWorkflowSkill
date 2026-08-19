# Adversarial Workflow

`/adversarial-workflow` — adversarial multi-agent code review for [Claude Code](https://code.claude.com).

Independent reviewers each inspect the diff through a different lens (correctness, error handling, API compatibility, tests, security, subtle semantics). Their findings are deduplicated, then a refutation-biased verifier tries to **disprove** each one against the real code. Only findings that survive are reported, with the lenses that corroborated them and the verifier's reasoning.

```
diff ──► review:<lens> ×6 ──► dedup ──► verify:<finding> ×N ──► confirmed / refuted
```

A run spawns 6–25 subagents (~250k–1M tokens, 5–10 min). It is slash-command only: Claude never launches it on its own.

## Install

Requires Claude Code ≥ 2.1.154 with the [`Workflow` tool](https://code.claude.com/docs/en/workflows.md), `git`, and `gh` for PR targets.

```
/plugin marketplace add martinez-hub/AdversarialWorkflowSkill
/plugin install adversarial-workflow@adversarial-workflow
```

Or copy/symlink `skills/adversarial-workflow/` into `~/.claude/skills/` (personal) or `.claude/skills/` (project).

## Use

```
/adversarial-workflow                    # current branch vs default branch
/adversarial-workflow 57                 # GitHub PR #57 (fork PRs work)
/adversarial-workflow feat/export        # branch vs default branch
/adversarial-workflow abc123..def456     # commit range
/adversarial-workflow src/api/           # uncommitted changes under a path
/adversarial-workflow 57 --thorough      # more lenses, 2 verifiers per finding (unanimity)
/adversarial-workflow 57 --profile docs  # force a profile (auto-detected otherwise)
```

You get confirmed findings by severity (`file:line`, trigger, fix, corroborating lenses), refuted findings with the verifier's reason, and an offer to fix. It never pushes, merges, or comments on the PR.

| Profile | Auto-selected when | Lenses |
|---|---|---|
| `code` | source changes | correctness, error-handling, api-compat, tests, security, semantic-subtle (+ performance, packaging-config, docs-accuracy with `--thorough`) |
| `docs` | only docs/notebooks changed | prose-vs-code, reader-runnability, link-integrity, consistency-regression (+ docs-build, file-format) |
| `deps` | only lockfiles/manifests changed | diff-scope, lock-integrity, supply-chain, manifest-consistency (+ test-impact, ci-coverage) |

In plain words you can also ask for: restricting to sub-paths, extra context for the reviewers (test command, PR intent), custom lenses, or a higher verification cap (`maxVerify`, default 40; overflow is reported as unverified).

## Layout

- `skills/adversarial-workflow/SKILL.md` — instructions Claude follows (resolve target → launch → report).
- `skills/adversarial-workflow/adversarial-review.js` — the workflow script.
- `tests/run-mock.mjs` — offline tests of the script logic (`node tests/run-mock.mjs`).
- `tests/make-fixture.sh` — throwaway repo with planted bugs for an end-to-end check.

See [CHANGELOG.md](CHANGELOG.md) for design notes and changes from the original command.

## License

MIT

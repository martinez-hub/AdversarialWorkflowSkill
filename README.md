# Adversarial Workflow

`/adversarial-workflow` — adversarial multi-agent code review for [Claude Code](https://code.claude.com).

Independent reviewers each inspect the diff through a different lens (correctness, error handling, API compatibility, tests, security, subtle semantics). Their findings are deduplicated, then a refutation-biased verifier tries to **disprove** each one against the real code. Only findings that survive are reported, with the lenses that corroborated them and the verifier's reasoning.

```
diff ──► review:<lens> ×6 ──► dedup ──► verify:<finding> ×N ──► confirmed / refuted
```

A run spawns one subagent per lens plus one per distinct finding. The reference run on the bundled fixture used 17 agents, about 400k tokens and 2.5 minutes; `--thorough` costs more. Because of that cost it is an explicit opt-in: Claude runs it when you type `/adversarial-workflow` or ask for an adversarial review, and never for routine review requests.

## Install

Requires Claude Code ≥ 2.1.154 with the [`Workflow` tool](https://code.claude.com/docs/en/workflows.md), `git`, and `gh` for PR targets.

```
/plugin marketplace add martinez-hub/AdversarialWorkflowSkill
/plugin install adversarial-workflow@adversarial-workflow
```

On Claude Code ≥ 2.1.292 the two steps collapse into one, from your shell:

```
claude plugin install adversarial-workflow --marketplace martinez-hub/AdversarialWorkflowSkill
```

Then type `/` in a session. The plugin lists the skill as `/adversarial-workflow:adversarial-workflow`, and the bare `/adversarial-workflow` also works unless another command already uses that name.

Or copy/symlink `skills/adversarial-workflow/` into `~/.claude/skills/` (personal) or `.claude/skills/` (project).

### Turn it on for a repository

To make the skill part of a repo for everyone who clones it, commit this to the repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "adversarial-workflow": {
      "github": { "owner": "martinez-hub", "repo": "AdversarialWorkflowSkill" }
    }
  },
  "enabledPlugins": {
    "adversarial-workflow@adversarial-workflow": true
  }
}
```

Claude Code registers the marketplace on its own when it sees this, but it does not download a project-enabled plugin until each machine installs it once:

```
claude plugin install adversarial-workflow@adversarial-workflow --scope project
```

Until then `/plugin` lists it under **Errors** as "enabled in project settings but isn't installed here". Anyone who does not want it can set the same key to `false` in their `.claude/settings.local.json`.

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

You get confirmed findings grouped by severity, each with `file:line`, what triggers it, a suggested fix and the lenses that reported it. Refuted findings are listed with the verifier's reason, so you can overrule one. Claude then offers to fix. It never pushes, merges, or comments on the PR.

| Profile | Auto-selected when | Lenses |
|---|---|---|
| `code` | source changes | correctness, error-handling, api-compat, tests, security, semantic-subtle (+ performance, packaging-config, docs-accuracy with `--thorough`) |
| `docs` | only docs/notebooks changed | prose-vs-code, reader-runnability, link-integrity, consistency-regression (+ docs-build, file-format) |
| `deps` | only lockfiles/manifests changed | diff-scope, lock-integrity, supply-chain, manifest-consistency (+ test-impact, ci-coverage) |

You can also ask, in plain words, to restrict the review to sub-paths, give the reviewers extra context (test command, PR intent), supply custom lenses, or raise the verification cap (`maxVerify`, default 40). Findings over the cap are reported as unverified, never dropped.

## Layout

- `.claude-plugin/` — plugin and marketplace manifests.
- `skills/adversarial-workflow/SKILL.md` — instructions Claude follows (resolve target → launch → report).
- `skills/adversarial-workflow/adversarial-review.js` — the workflow script.
- `tests/run-mock.mjs` — offline tests of the script logic (`node tests/run-mock.mjs`).
- `tests/make-fixture.sh` — throwaway repo with planted bugs for an end-to-end check.

See [CHANGELOG.md](CHANGELOG.md) for design notes and changes from the original command.

## License

MIT

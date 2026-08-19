export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial code review: diverse-lens reviewers → dedup → refutation-biased verification',
  whenToUse: 'Launched by the /adversarial-workflow skill. args = { repo, base, head, label?, profile?, thorough?, paths?, context?, lenses?, maxVerify? }',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens over the diff' },
    { title: 'Verify', detail: 'refutation-biased skeptic(s) per deduplicated finding' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs. Pass as a JSON OBJECT via Workflow({ scriptPath, args: {...} }).
// ---------------------------------------------------------------------------
const a = args && typeof args === 'object' && !Array.isArray(args) ? args : null
if (!a) throw new Error('adversarial-review: args must be a JSON object {repo, base, head, ...} — not a string or array')
const repo = String(a.repo || '')
const base = String(a.base || '')
const head = String(a.head || '')
if (!repo || !base || !head) throw new Error('adversarial-review: args.repo, args.base and args.head are required')
const label = a.label ? String(a.label) : `${base.slice(0, 8)}...${head === 'WORKTREE' ? 'worktree' : head.slice(0, 8)}`
const thorough = a.thorough === true
const profile = ['code', 'docs', 'deps'].includes(a.profile) ? a.profile : 'code'
const paths = Array.isArray(a.paths) ? a.paths.map(String).filter(Boolean) : []
const extraContext = a.context ? String(a.context).trim() : ''
const MAX_VERIFY = Number.isInteger(a.maxVerify) && a.maxVerify > 0 ? a.maxVerify : 40

// How reviewers obtain the diff. head === 'WORKTREE' means uncommitted changes vs base.
const pathArg = paths.length ? ' -- ' + paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ') : ''
const diffCmd = head === 'WORKTREE'
  ? `git -C '${repo}' diff ${base}${pathArg}`
  : `git -C '${repo}' diff ${base}...${head}${pathArg}`

// ---------------------------------------------------------------------------
// Lens profiles. Standard set + extra lenses used only when thorough=true.
// Override entirely with args.lenses = [{key, prompt}, ...].
// ---------------------------------------------------------------------------
const PROFILES = {
  code: {
    standard: [
      { key: 'correctness', prompt: 'Logic/correctness: off-by-one, wrong conditions, incorrect returns, mishandled None/empty, broken invariants, state read before written, resource leaks. Trace the changed functions end-to-end, including every caller of a changed signature.' },
      { key: 'error-handling', prompt: 'Error handling & edge cases: unhandled exceptions, swallowed/over-broad excepts that hide real failures, missing validation, boundary inputs (0, empty, huge, negative, NaN/inf, unicode), partial failure, cleanup/return paths not covered.' },
      { key: 'api-compat', prompt: 'API & backward compatibility: breaking signature/behavior changes, changed defaults, renamed/removed public symbols, exports/__all__ mismatches, serialization/format changes, stale docstrings or type hints on changed public surfaces.' },
      { key: 'tests', prompt: 'Test quality of the tests in the diff: tautological/weak assertions (checks type or presence, not value), tests that would still pass if the feature were broken or reverted, missing coverage of a key branch the diff adds, flaky/nondeterministic constructs, test-isolation leaks (global/registry/env mutation).' },
      { key: 'security', prompt: 'Security: injection (shell/SQL/path/template), unsafe deserialization/eval, secrets in code/logs, SSRF, unsafe file/temp handling, TOCTOU, missing authz checks, unsafe defaults. Only real, reachable issues introduced or exposed by this diff.' },
      { key: 'semantic-subtle', prompt: 'Subtle/semantic bugs: closure/late-binding captures, mutable default args, shadowed names, sign/unit/precision errors, dead code, copy-paste errors, comment/docstring claims that contradict the code, concurrency/ordering hazards, platform/version-specific runtime failures.' },
    ],
    thorough: [
      { key: 'performance', prompt: 'Performance & resources: accidental O(n^2), work inside hot loops, unbounded memory/growth, redundant IO/queries, missing streaming, blocking calls on hot paths — only where the diff plausibly matters at realistic sizes.' },
      { key: 'packaging-config', prompt: 'Packaging/config/CI: dependency floors vs actual usage, extras/markers, lockfile vs manifest drift, CI matrix gaps, config that will fail (rather than skip) on a supported platform/version.' },
      { key: 'docs-accuracy', prompt: 'Docs accuracy: README/guide/example/changelog claims vs the real API in this diff — import paths, argument names, signatures, runnable examples that would error, contract statements that are now wrong.' },
    ],
  },
  docs: {
    standard: [
      { key: 'prose-vs-code', prompt: 'Prose-vs-code accuracy. Every factual claim the new/changed prose makes about the code must match reality: module/symbol names, function arguments and defaults, install extras/package names, what an example actually does, quoted error/warning text, counts ("all five commands"). Verify each against the source. Flag anything now wrong or misleading.' },
      { key: 'reader-runnability', prompt: 'Reader runnability. Pretend you are a new user following the changed docs exactly, in a fresh environment, top to bottom. Would every command/snippet/cell work? Are stated prerequisites sufficient AND not overstated? Actually run snippets where feasible.' },
      { key: 'link-integrity', prompt: 'Link & anchor integrity. Extract EVERY link/reference added or modified by this diff. For each: does the target file/page exist, does any #anchor match a real heading, do relative links resolve from where the file is rendered (site vs. repo view vs. local viewer)? Build the docs site if there is one and check the emitted output.' },
      { key: 'consistency-regression', prompt: 'Consistency & regression versus base. Diff base and head of each changed doc section-by-section (for notebooks: cell-by-cell). Did an edit silently drop or alter content it should not have? Does the change make one page contradict another? Are cross-references reciprocal and accurate?' },
    ],
    thorough: [
      { key: 'docs-build', prompt: 'Docs build & rendering. Run the docs build in strict mode if available. Check changed pages render as intended: callouts/admonitions, nested lists, code fences, tables, markdown inside notebook cells. Zero new build warnings.' },
      { key: 'file-format', prompt: 'File format & tooling. For structured doc files (.ipynb, .rst, .toml, mkdocs/sphinx config): valid format/schema, no corrupted or lost cells/metadata versus base, formatters and pre-commit hooks idempotent on the result.' },
    ],
  },
  deps: {
    standard: [
      { key: 'diff-scope', prompt: 'Diff scope & honesty. Does the diff do EXACTLY what its title claims and nothing more? Enumerate every changed package entry in each lockfile/manifest. Flag any package other than the stated one whose version, source, markers, or hashes changed; any marker rewriting churn; any added/dropped package; any change to resolution markers or language-version constraints. A silent extra change hidden among hash churn is the defect to hunt for.' },
      { key: 'lock-integrity', prompt: 'Lockfile integrity & reproducibility. Is the lockfile internally consistent and consistent with the manifest? Run the ecosystem\'s check command (e.g. `uv lock --check`, `npm ci --dry-run`, `poetry check --lock`, `cargo metadata --locked`). Verify the new entry is well-formed (version, URLs, hashes/sizes) with no leftover old-version artifacts, and that regenerating the lock locally produces no further churn.' },
      { key: 'supply-chain', prompt: 'Supply chain / provenance. Do recorded artifact URLs and hashes correspond to the real release on the official registry (cross-check a couple against the registry API)? Do URLs point at the official host? Exact package name (no typosquat)? Any new install scripts or new transitive dependencies with suspicious sources?' },
      { key: 'manifest-consistency', prompt: 'Manifest & constraint consistency. Is the new version compatible with declared floors/ceilings and the supported language/runtime range? Does the lock still satisfy every other constraint? Is a min-versions/lowest-resolution CI job affected? Does the bump contradict the declared dependency policy (e.g. dependabot/renovate config)?' },
    ],
    thorough: [
      { key: 'test-impact', prompt: 'Test impact. Which tests exercise the bumped package(s)? Would the new version change behavior — deprecations turned into errors by test config, changed defaults, removed APIs? Actually RUN the relevant tests against the bumped lock and report only real failures or new warnings.' },
      { key: 'ci-coverage', prompt: 'CI coverage of this change. Given path filters/conditions in CI config, which jobs actually run for this diff, and is that adequate to catch a bad bump? Report only a concrete gap (name the job that should run and the failure it would miss).' },
    ],
  },
}

let dims
if (Array.isArray(a.lenses) && a.lenses.length) {
  dims = a.lenses.filter((l) => l && l.key && l.prompt).map((l) => ({ key: String(l.key), prompt: String(l.prompt) }))
} else {
  const p = PROFILES[profile]
  dims = thorough ? p.standard.concat(p.thorough) : p.standard
}
const nVerify = thorough ? 2 : 1

// ---------------------------------------------------------------------------
// Shared context + schemas
// ---------------------------------------------------------------------------
const CONTEXT = `
Repo: ${repo}. Review target: ${label}.
Inspect the change with: \`${diffCmd}\` and then READ the actual files it touches (don't guess — open them, trace callers). Run \`git log\`, targeted tests, builds, or \`grep\` as needed to confirm claims.
${extraContext ? `\nProject context from the requester:\n${extraContext}\n` : ''}
Report ONLY concrete, real defects you can point to at a specific file:line in THIS change. An empty findings list is a valid, good answer when the change is clean on your lens — reporting nothing is strongly preferred over inventing something. Do not report pre-existing issues unrelated to this diff unless the diff makes them newly reachable. Pure style/wording preferences and generic advice ("consider adding more tests") are NOT defects. For each finding give a concrete, reproducible trigger and a minimal suggested fix. Use repo-relative paths in "file".
`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['title', 'file', 'severity', 'category', 'explanation', 'suggested_fix'],
    properties: {
      title: { type: 'string', description: 'one-line description of the defect' },
      file: { type: 'string', description: 'repo-relative path:line, e.g. src/app.py:42' },
      severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
      category: { type: 'string' },
      explanation: { type: 'string', description: 'why it is a real defect + concrete, reproducible trigger' },
      suggested_fix: { type: 'string' },
    },
  } } },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_real', 'confidence', 'final_severity', 'reasoning'],
  properties: {
    is_real: { type: 'boolean', description: 'true ONLY if you could not refute it by reading the actual code/files' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    final_severity: { type: 'string', enum: ['critical', 'important', 'minor', 'none'] },
    reasoning: { type: 'string', description: 'cite the specific lines/commands you checked' },
  },
}

const VERIFIER_LENSES = [
  'Trace the ACTUAL code/files at that location and try to demonstrate the defect does NOT occur: wrong reading of the code, guarded elsewhere, unreachable, or misdescribed behavior.',
  'Check scope and severity: is the issue actually introduced or newly exposed by THIS diff (not pre-existing), is it really reachable for a real caller/user, and is the claimed severity honest? A correct observation that is out of scope, a duplicate, or a style preference is NOT a real defect.',
]

// ---------------------------------------------------------------------------
// Phase 1 — Review (barrier: dedup across ALL lenses before paying for verify)
// ---------------------------------------------------------------------------
log(`Adversarial review: ${label} — profile=${profile}, ${dims.length} lenses, ${nVerify} verifier(s)/finding${paths.length ? `, paths=${paths.join(',')}` : ''}`)

phase('Review')
const reviews = await parallel(dims.map((d) => () =>
  agent(
    `${CONTEXT}\n\nYou are a meticulous, skeptical reviewer. LENS: ${d.key}.\n${d.prompt}`,
    { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA },
  ).then((r) => ({ lens: d.key, findings: (r && Array.isArray(r.findings)) ? r.findings : [] })),
))

const sevOrder = { critical: 0, important: 1, minor: 2, none: 3 }
const normFile = (f) => {
  let s = String(f || '').trim().replace(/^`|`$/g, '')
  if (s.startsWith(repo)) s = s.slice(repo.length)
  return s.replace(/^\.?\//, '')
}

// Dedup. Two findings are the same defect when they are in the same file and
//   (a) point at the same line, or
//   (b) are within NEAR_LINES of each other and their titles share >= 2 significant words, or
//   (c) their titles share >= 4 significant words covering >= 60% of the shorter title.
// Merged groups keep the most severe / most detailed representative and record the lenses.
const STOP = new Set(['with', 'that', 'this', 'from', 'into', 'than', 'when', 'then', 'which', 'does', 'only', 'will', 'should', 'would', 'could', 'because', 'instead', 'returns', 'return', 'after', 'before', 'every', 'have', 'been', 'being', 'their', 'there', 'where', 'also', 'same', 'still', 'test', 'tests', 'file', 'line', 'code', 'function', 'method', 'diff', 'change', 'changes', 'defect', 'error', 'issue', 'never', 'always', 'without', 'actually', 'newly'])
const NEAR_LINES = 8
const tokens = (t) => new Set(String(t || '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 4 && !STOP.has(w)))
const splitLoc = (file) => { const m = /^(.*?):(\d+)/.exec(file); return m ? { path: m[1], line: Number(m[2]) } : { path: file.replace(/:.*$/, ''), line: null } }
const sameDefect = (x, y) => {
  if (x.path !== y.path) return false
  if (x.line !== null && x.line === y.line) return true
  let shared = 0
  for (const w of x.tok) if (y.tok.has(w)) shared++
  const near = x.line !== null && y.line !== null && Math.abs(x.line - y.line) <= NEAR_LINES
  if (near && shared >= 2) return true
  const minSize = Math.max(1, Math.min(x.tok.size, y.tok.size))
  return shared >= 4 && shared / minSize >= 0.6
}

const groups = []
let rawCount = 0
for (const r of reviews.filter(Boolean)) {
  for (const f of r.findings) {
    rawCount++
    const file = normFile(f.file)
    const rep = { ...f, file }
    const sig = { ...splitLoc(file), tok: tokens(f.title) }
    const g = groups.find((grp) => grp.sigs.some((s2) => sameDefect(sig, s2)))
    if (!g) { groups.push({ finding: rep, lenses: [r.lens], sigs: [sig], titles: [rep.title] }); continue }
    g.sigs.push(sig)
    if (!g.lenses.includes(r.lens)) g.lenses.push(r.lens)
    if (!g.titles.includes(rep.title)) g.titles.push(rep.title)
    const better = (sevOrder[rep.severity] ?? 9) < (sevOrder[g.finding.severity] ?? 9)
      || ((sevOrder[rep.severity] ?? 9) === (sevOrder[g.finding.severity] ?? 9) && String(rep.explanation).length > String(g.finding.explanation).length)
    if (better) g.finding = rep
  }
}
let deduped = groups.map(({ finding, lenses, titles }) => ({ finding, lenses, also_reported_as: titles.filter((t) => t !== finding.title) }))
deduped.sort((x, y) => (sevOrder[x.finding.severity] ?? 9) - (sevOrder[y.finding.severity] ?? 9) || y.lenses.length - x.lenses.length)

let unverified = []
if (deduped.length > MAX_VERIFY) {
  unverified = deduped.slice(MAX_VERIFY).map((g) => ({ ...g.finding, reported_by: g.lenses, also_reported_as: g.also_reported_as }))
  deduped = deduped.slice(0, MAX_VERIFY)
  log(`WARNING: ${rawCount} raw findings → ${groups.length} distinct; only the top ${MAX_VERIFY} by severity will be verified. ${unverified.length} minor/low-corroboration findings are returned UNVERIFIED (raise args.maxVerify to verify all).`)
} else {
  log(`${rawCount} raw findings → ${deduped.length} distinct after dedup; verifying each with ${nVerify} skeptic(s)`)
}

// ---------------------------------------------------------------------------
// Phase 2 — Verify (refutation-biased). A finding survives only if EVERY
// verifier fails to refute it (1 verifier standard; 2 diverse verifiers thorough).
// ---------------------------------------------------------------------------
phase('Verify')
const verified = await parallel(deduped.map((g) => () =>
  parallel(Array.from({ length: nVerify }, (_v, i) => () =>
    agent(
      `${CONTEXT}\n\nYou are an ADVERSARIAL verifier. Reviewer lens(es) ${g.lenses.join(', ')} claim this is a defect:\n\nTITLE: ${g.finding.title}\nFILE: ${g.finding.file}${g.also_reported_as.length ? `\nALSO REPORTED AS: ${g.also_reported_as.join(' | ')}` : ''}\nSEVERITY(claimed): ${g.finding.severity}\nEXPLANATION: ${g.finding.explanation}\nSUGGESTED FIX: ${g.finding.suggested_fix}\n\nYour job is to REFUTE it. ${VERIFIER_LENSES[i % VERIFIER_LENSES.length]} Default to is_real=false unless the code genuinely exhibits the defect with a concrete, reproducible trigger. If real, set final_severity honestly (downgrade hype). Cite the specific lines/commands you checked.`,
      { label: `verify:${g.finding.file.split('/').pop()}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ),
  )).then((verdicts) => ({ ...g, verdicts: verdicts.filter(Boolean) })),
))

const confirmed = []
const refuted = []
for (const g of verified.filter(Boolean)) {
  const { finding, lenses, verdicts, also_reported_as } = g
  const real = verdicts.filter((v) => v.is_real && v.final_severity !== 'none')
  const entry = {
    title: finding.title, file: finding.file, reported_by: lenses, also_reported_as,
    explanation: finding.explanation, suggested_fix: finding.suggested_fix,
  }
  if (verdicts.length > 0 && real.length === verdicts.length) {
    real.sort((x, y) => (sevOrder[x.final_severity] ?? 9) - (sevOrder[y.final_severity] ?? 9))
    const top = real[0]
    confirmed.push({ severity: top.final_severity, confidence: top.confidence, ...entry, verifier_reasoning: top.reasoning })
  } else {
    const why = verdicts.find((v) => !v.is_real || v.final_severity === 'none')
    refuted.push({ ...entry, claimed_severity: finding.severity, verifier_reasoning: why ? why.reasoning : 'verifier unavailable' })
  }
}
confirmed.sort((x, y) => (sevOrder[x.severity] ?? 9) - (sevOrder[y.severity] ?? 9))

return {
  target: label,
  profile,
  lenses: dims.map((d) => d.key),
  raw_findings: rawCount,
  distinct_findings: groups.length,
  confirmed_count: confirmed.length,
  confirmed,
  refuted,
  unverified,
}

#!/usr/bin/env node
// Offline test harness for skills/adversarial-workflow/adversarial-review.js.
// Runs the workflow script with mocked agent()/parallel()/log()/phase() so the
// dedup + verification logic can be checked deterministically (no API calls).
//
//   node tests/run-mock.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'skills', 'adversarial-workflow', 'adversarial-review.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const run = async (args, agentImpl) => {
  const logs = []
  const prompts = []
  const fn = new AsyncFunction('args', 'log', 'phase', 'agent', 'parallel', 'pipeline', 'budget', 'workflow', src)
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (it, i) => {
    let v = it
    for (const s of stages) v = await s(v, it, i)
    return v
  }))
  const wrapped = (p, o) => { prompts.push(p); return agentImpl(p, o) }
  const result = await fn(args, (m) => logs.push(m), () => {}, wrapped, parallel, pipeline,
    { total: null, spent: () => 0, remaining: () => Infinity }, async () => null)
  return { result, logs, prompts }
}
const seenPrompt = (r, needle) => r.prompts.some((p) => p.includes(needle))

// --- Scenario 1: args validation -------------------------------------------
await assert.rejects(() => run('not-an-object', async () => null), /args must be a JSON object/)
await assert.rejects(() => run({ repo: '/r' }, async () => null), /base and args.head are required/)
console.log('ok  args validation')

// --- Scenario 2: dedup across lenses + refutation-biased verify -------------
const REPO = '/tmp/fixture'
const reviewer = (lens) => {
  // three lenses report the SAME bug at the same file:line (once with an absolute path),
  // one lens reports a distinct bug, one lens reports a decoy that the verifier refutes,
  // one lens returns null (skipped/dead agent) and must not crash the run.
  const same = { title: `off-by-one in top_accounts (${lens})`, file: 'ledger/core.py:27', severity: 'important', category: 'logic', explanation: `slice [:n-1] drops one (${lens})`, suggested_fix: 'use [:n]' }
  switch (lens) {
    case 'correctness': return { findings: [same] }
    case 'tests': return { findings: [{ ...same, file: `${REPO}/ledger/core.py:27`, severity: 'critical', explanation: 'longer explanation wins as representative ' + 'x'.repeat(50) }] }
    case 'semantic-subtle': return { findings: [same, { title: 'sign lost in parse_amount', file: 'ledger/core.py:33', severity: 'minor', category: 'semantic', explanation: 'int("-0")*100 + 50 = +50', suggested_fix: 'track sign' }] }
    case 'error-handling': return { findings: [{ title: 'decoy: sorted() unstable', file: 'ledger/core.py:45', severity: 'minor', category: 'x', explanation: 'not actually a bug', suggested_fix: 'none' }] }
    case 'api-compat': return null
    default: return { findings: [] }
  }
}
const verifier = (prompt) => {
  if (prompt.includes('decoy')) return { is_real: false, confidence: 'high', final_severity: 'none', reasoning: 'sorted() is stable' }
  if (prompt.includes('sign lost')) return { is_real: true, confidence: 'medium', final_severity: 'important', reasoning: 'reproduced: parse_amount("-0.50") == 50' }
  return { is_real: true, confidence: 'high', final_severity: 'important', reasoning: 'reproduced off-by-one' }
}
const calls = []
const mockAgent = async (prompt, opts) => {
  calls.push(opts.label)
  if (opts.label.startsWith('review:')) return reviewer(opts.label.slice(7))
  return verifier(prompt)
}
const { result, logs } = await run({ repo: REPO, base: 'abc', head: 'def', label: 'fixture', context: 'run tests with pytest' }, mockAgent)

assert.equal(result.profile, 'code')
assert.equal(result.lenses.length, 6)
assert.equal(result.raw_findings, 5, 'five raw findings across lenses')
assert.equal(result.distinct_findings, 3, 'dedup to 3 distinct (same path:line merged, abs path normalized)')
assert.equal(calls.filter((l) => l.startsWith('verify:')).length, 3, 'one verifier per DISTINCT finding, not per raw finding')
assert.equal(result.confirmed_count, 2)
assert.equal(result.refuted.length, 1)
assert.match(result.refuted[0].title, /decoy/)
const top = result.confirmed.find((c) => c.file === 'ledger/core.py:27')
assert.deepEqual(top.reported_by.sort(), ['correctness', 'semantic-subtle', 'tests'], 'merged lenses recorded')
assert.match(top.explanation, /longer explanation wins/, 'most severe/detailed representative kept')
assert.equal(top.severity, 'important', 'verifier severity (not reviewer hype) wins')
assert.ok(logs.some((l) => /5 raw findings → 3 distinct/.test(l)), 'dedup logged')
console.log('ok  dedup + refutation verify')

// --- Scenario 3: thorough = more lenses, 2 verifiers, unanimity required -----
let verifyCount = 0
const thoroughAgent = async (prompt, opts) => {
  if (opts.label.startsWith('review:')) return opts.label === 'review:correctness'
    ? { findings: [{ title: 'bug', file: 'a.py:1', severity: 'minor', category: 'c', explanation: 'e', suggested_fix: 'f' }] }
    : { findings: [] }
  verifyCount++
  // first verifier says real, second refutes → must NOT be confirmed
  return verifyCount === 1
    ? { is_real: true, confidence: 'high', final_severity: 'minor', reasoning: 'looks real' }
    : { is_real: false, confidence: 'high', final_severity: 'none', reasoning: 'pre-existing, not in this diff' }
}
const t = await run({ repo: REPO, base: 'abc', head: 'def', thorough: true, profile: 'code' }, thoroughAgent)
assert.equal(t.result.lenses.length, 9, 'thorough adds 3 lenses')
assert.equal(verifyCount, 2, 'two verifiers per finding when thorough')
assert.equal(t.result.confirmed_count, 0, 'a single refutation kills the finding')
assert.equal(t.result.refuted.length, 1)
console.log('ok  thorough mode (9 lenses, 2 verifiers, unanimity)')

// --- Scenario 4: profiles, custom lenses, paths, worktree, maxVerify ---------
const seen = []
const probeAgent = async (prompt, opts) => {
  seen.push({ prompt, label: opts.label })
  if (opts.label.startsWith('review:')) return { findings: Array.from({ length: 3 }, (_, i) => ({ title: `f${i}`, file: `f.py:${i}`, severity: 'minor', category: 'c', explanation: 'e', suggested_fix: 's' })) }
  return { is_real: true, confidence: 'low', final_severity: 'minor', reasoning: 'r' }
}
const d = await run({ repo: REPO, base: 'HEAD', head: 'WORKTREE', profile: 'docs', paths: ['docs/', "it's.md"], maxVerify: 2 }, probeAgent)
assert.equal(d.result.lenses.length, 4)
assert.ok(d.result.lenses.includes('link-integrity'))
assert.match(seen[0].prompt, /git -C '\/tmp\/fixture' diff HEAD -- 'docs\/' 'it'\\''s\.md'/, 'worktree diff with quoted paths')
assert.equal(d.result.confirmed_count, 2, 'maxVerify caps verification')
assert.equal(d.result.unverified.length, 1, 'overflow returned as unverified, not dropped silently')
assert.ok(d.logs.some((l) => /WARNING/.test(l)), 'cap is logged')

const c = await run({ repo: REPO, base: 'a', head: 'b', profile: 'deps', lenses: [{ key: 'only', prompt: 'p' }, { key: '', prompt: 'bad' }] }, probeAgent)
assert.deepEqual(c.result.lenses, ['only'], 'custom lenses override profile, invalid entries dropped')
const dep = await run({ repo: REPO, base: 'a', head: 'b', profile: 'deps' }, async (p, o) => o.label.startsWith('review:') ? { findings: [] } : null)
assert.deepEqual(dep.result.lenses, ['diff-scope', 'lock-integrity', 'supply-chain', 'manifest-consistency'])
assert.equal(dep.result.confirmed_count, 0)
console.log('ok  profiles / custom lenses / paths / worktree / maxVerify')


// --- Scenario 5: real titles from a live run must dedup to the true defects ---
// The 11 "distinct" findings below came from a real run on the fixture repo with
// exact-line dedup. They are really 7 defects (NameError reported at :1 and :30,
// sign bug at :31/:33/:34, off-by-one at :26/:27).
const LIVE = [
  ['error-handling', 'ledger/tests/test_core.py:30', 'test_export_csv references export_csv without importing it; the test fails with NameError'],
  ['correctness', 'ledger/tests/test_core.py:1', 'test_export_csv fails with NameError: export_csv not imported in test module'],
  ['correctness', 'ledger/core.py:34', "parse_amount drops the sign for negative amounts with a fractional part ('-0.50' -> 50, '-1.50' -> -50)"],
  ['api-compat', 'ledger/core.py:31', "parse_amount docstring now promises signed parsing ('-0.50') but negative amounts with a fractional part are computed wrong"],
  ['semantic-subtle', 'ledger/core.py:33', 'parse_amount drops the sign for negative amounts with whole part 0 and mis-adds fractional cents for other negatives'],
  ['correctness', 'ledger/core.py:27', 'top_accounts(n) returns n-1 results (and all-but-last for n=0), contradicting its documented contract'],
  ['semantic-subtle', 'ledger/core.py:26', 'top_accounts off-by-one: returns n-1 accounts instead of n (and n=1 returns [], n=0 returns all-but-last)'],
  ['tests', 'ledger/tests/test_core.py:23', 'test_top_accounts asserts only type and `len <= 2`, masking the off-by-one (`[: n - 1]`) in top_accounts'],
  ['tests', 'ledger/tests/test_core.py:4', 'No test covers the newly documented signed-amount parsing, which is actually wrong for negative fractional input'],
  ['error-handling', 'ledger/core.py:50', 'export_csv swallows all exceptions and leaves a truncated/partial file behind'],
  ['security', 'ledger/core.py:48', 'CSV formula injection: account names written to export unescaped'],
]
const liveAgent = async (prompt, opts) => {
  if (opts.label.startsWith('review:')) {
    const lens = opts.label.slice(7)
    return { findings: LIVE.filter(([l]) => l === lens).map(([, file, title]) => ({ title, file, severity: 'important', category: 'c', explanation: 'e', suggested_fix: 's' })) }
  }
  return { is_real: true, confidence: 'high', final_severity: 'important', reasoning: 'r' }
}
const live = await run({ repo: REPO, base: 'a', head: 'b' }, liveAgent)
assert.equal(live.result.raw_findings, 11)
assert.equal(live.result.distinct_findings, 7, `expected 7 distinct, got ${live.result.distinct_findings}: ${live.result.confirmed.map((c) => c.file).join(', ')}`)
const files = live.result.confirmed.map((c) => c.file)
for (const f of ['ledger/core.py:48', 'ledger/core.py:50', 'ledger/tests/test_core.py:23', 'ledger/tests/test_core.py:4']) assert.ok(files.includes(f), `kept distinct ${f}`)
assert.ok(files.includes('ledger/core.py:27') !== files.includes('ledger/core.py:26'), 'off-by-one merged to one')
assert.ok(['ledger/core.py:31', 'ledger/core.py:33', 'ledger/core.py:34'].filter((f) => files.includes(f)).length === 1, 'sign bug merged to one')
assert.ok(files.includes('ledger/tests/test_core.py:1') !== files.includes('ledger/tests/test_core.py:30'), 'NameError (29 lines apart) merged by title overlap')
const nameErr = live.result.confirmed.find((c) => c.file.startsWith('ledger/tests/test_core.py:1') || c.file === 'ledger/tests/test_core.py:30')
assert.equal(nameErr.also_reported_as.length, 1, 'merged alternate title preserved')
assert.ok(seenPrompt(live, 'ALSO REPORTED AS'), 'verifier is told about merged alternates')
console.log('ok  live-run titles dedup to the true defect count (11 → 7)')

console.log('\nall mock scenarios passed')

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkFlows, checkQuarantine, matches, pick, score, splitChange } from '../src/redline.mjs'

test('globs: **, * and base-name patterns', () => {
  assert.ok(matches('src/**', 'src/a/b.js'))
  assert.ok(matches('src/**/*.js', 'src/b.js'))
  assert.ok(!matches('src/*.js', 'src/a/b.js'))
  assert.ok(matches('*.md', 'docs/guide/intro.md'))
  assert.ok(!matches('docs/*.md', 'README.md'))
})

const config = {
  full: 'npm test',
  always: ['node --test tests/money.test.js'],
  rules: [
    { when: ['src/sync/**'], run: ['node --test tests/sync.test.js'] },
    { when: ['*.md'], run: [] },
  ],
  flows: [
    { name: 'Lifetime key unlocks sync', test: 'tests/money.test.js' },
    { name: 'Refund locks sync', test: null },
  ],
}

test('pick: known change runs its tests plus the always list', () => {
  const result = pick(config, ['src/sync/push.js'])
  assert.equal(result.full, false)
  assert.deepEqual(result.commands, ['node --test tests/money.test.js', 'node --test tests/sync.test.js'])
})

test('pick: a docs-only change still runs the money paths', () => {
  assert.deepEqual(pick(config, ['README.md']).commands, ['node --test tests/money.test.js'])
})

test('pick: an unknown file runs everything', () => {
  const result = pick(config, ['src/sync/push.js', 'package.json'])
  assert.equal(result.full, true)
  assert.deepEqual(result.unknown, ['package.json'])
  assert.ok(result.commands.includes('npm test'))
})

test('pick: an unknown file with no full command is an error, never an empty run', () => {
  assert.throws(() => pick({ always: ['a'] }, ['x.js']), /no "full" command/)
})

test('score: a rerun that passed still counts as a first red, and as rescued', () => {
  const t = (m) => new Date(Date.UTC(2026, 10, 17, 0, m)).toISOString()
  const runs = [
    { name: 'ci', conclusion: 'success', attempt: 1, createdAt: t(0), updatedAt: t(10) },
    { name: 'ci', conclusion: 'success', attempt: 2, createdAt: t(0), updatedAt: t(30) },
    { name: 'ci', conclusion: 'failure', attempt: 1, createdAt: t(0), updatedAt: t(5) },
    { name: 'ci', conclusion: 'cancelled', attempt: 1, createdAt: t(0), updatedAt: t(1) },
  ]
  const [row] = score(runs)
  assert.equal(row.runs, 3)
  assert.equal(row.cancelled, 1)
  assert.equal(row.firstRed, 2)
  assert.equal(row.rescued, 1)
  assert.equal(row.medianMinutes, 10)
  assert.equal(row.p95Minutes, 30)
})

test('flows: a flow without a test stays in the denominator', () => {
  const result = checkFlows(config, () => true)
  assert.equal(result.covered, 1)
  assert.equal(result.total, 2)
  assert.equal(result.share, 0.5)
  assert.deepEqual(result.problems, ['no test yet: Refund locks sync'])
})

test('flows: a money test outside the always list is flagged', () => {
  const result = checkFlows({ ...config, always: [] }, () => true)
  assert.ok(result.problems.some((p) => p.includes('not in the always list')))
})

test('quarantine: expiry, missing owner, cap and money tests', () => {
  const result = checkQuarantine(
    {
      ...config,
      quarantineCap: 1,
      quarantine: [
        { test: 'tests/slow.test.js', reason: 'timing', owner: 'me', expires: '2026-11-01' },
        { test: 'tests/money.test.js', reason: 'flaky', expires: '2026-12-01' },
      ],
    },
    '2026-11-17'
  )
  assert.deepEqual(result.problems, [
    '2 quarantined tests, cap is 1',
    'quarantine expired 2026-11-01: tests/slow.test.js',
    'quarantine entry tests/money.test.js has no owner',
    'money-path test cannot be quarantined: tests/money.test.js',
  ])
})

test('splitChange: tests and code are told apart', () => {
  const { tests, source } = splitChange(['src/a.js', 'src/a.test.js', 'app/test_api.py', 'tests/x.js', 'README.md'])
  assert.deepEqual(tests, ['src/a.test.js', 'app/test_api.py', 'tests/x.js'])
  assert.deepEqual(source, ['src/a.js', 'README.md'])
})

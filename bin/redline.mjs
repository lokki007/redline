#!/usr/bin/env node
// redline: tests you can trust, fast. Four commands, zero dependencies. See README.md for the ideas behind them.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFlows, checkQuarantine, pick, score, splitChange } from '../src/redline.mjs'

const HELP = `redline: tests you can trust, fast

  redline score [--repo owner/name] [--limit 50] [--json]
      First-attempt red rate, reruns that hid a flake, and minutes to a verdict, per workflow (needs gh).

  redline pick [--base origin/main] [--run]
      What the fast check should run for this change. Unknown files mean "run everything".

  redline prove (--fix <sha> | --base <ref>) -- <test command>
      The test must pass with the change and fail without it. Use --fix on an old bug fix to replay it.

  redline check
      Money paths have tests in the always list; quarantine entries have an owner, an expiry and fit the cap.

Config: redline.json in the current directory (see examples/redline.json).`

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const flag = (args, name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const loadConfig = () => (existsSync('redline.json') ? JSON.parse(readFileSync('redline.json', 'utf8')) : {})
const pct = (x) => `${Math.round(x * 100)}%`
const min = (x) => (x == null ? '-' : `${x.toFixed(1)} min`)

function runScore(args) {
  const limit = flag(args, '--limit', '50')
  const ghArgs = ['run', 'list', '--limit', limit, '--json', 'name,workflowName,event,status,conclusion,attempt,createdAt,updatedAt']
  const repo = flag(args, '--repo')
  if (repo) ghArgs.push('--repo', repo)
  const runs = JSON.parse(execFileSync('gh', ghArgs, { encoding: 'utf8' }))
  const rows = score(runs)
  if (args.includes('--json')) return console.log(JSON.stringify(rows, null, 2))
  console.log(`last ${runs.length} runs${repo ? ` of ${repo}` : ''}\n`)
  console.log('workflow                         runs  first red  rescued by rerun  median    p95')
  for (const r of rows) {
    console.log(
      `${r.workflow.slice(0, 32).padEnd(32)} ${String(r.runs).padStart(4)}  ${`${r.firstRed} (${pct(r.firstRedRate)})`.padStart(9)}  ${String(r.rescued).padStart(16)}  ${min(r.medianMinutes).padStart(8)}  ${min(r.p95Minutes).padStart(8)}`
    )
  }
}

function runPick(args) {
  const base = flag(args, '--base', 'origin/main')
  const mergeBase = git('merge-base', base, 'HEAD')
  const changed = git('diff', '--name-only', mergeBase).split('\n').filter(Boolean)
  const result = pick(loadConfig(), changed)
  if (result.unknown.length) console.error(`no rule for: ${result.unknown.join(', ')}${result.full ? ' -> running everything' : ''}`)
  for (const command of result.commands) console.log(command)
  if (!args.includes('--run')) return
  for (const command of result.commands) {
    const { status } = spawnSync(command, { shell: true, stdio: 'inherit' })
    if (status !== 0) process.exit(status ?? 1)
  }
}

function runProve(args) {
  const dash = args.indexOf('--')
  if (dash === -1) throw new Error('give the test command after --')
  const command = args.slice(dash + 1).join(' ')
  const fix = flag(args, '--fix')
  const to = fix ?? 'HEAD'
  const from = fix ? `${fix}^` : git('merge-base', flag(args, '--base', 'origin/main'), 'HEAD')
  const config = loadConfig()
  const { tests, source } = splitChange(git('diff', '--name-only', from, to).split('\n').filter(Boolean), config.testGlobs)
  if (!tests.length) return fail('the change carries no test, so nothing proves it')
  if (!source.length) return fail('the change has tests but no code change to prove')

  const dir = mkdtempSync(join(tmpdir(), 'redline-'))
  const work = join(dir, 'tree')
  git('worktree', 'add', '--detach', '--quiet', work, to)
  const run = () => spawnSync(command, { shell: true, cwd: work, stdio: 'inherit' }).status
  try {
    console.log(`\n[1/2] with the change (${to}): the tests must pass`)
    if (run() !== 0) return fail('the tests do not pass even with the change')
    // Put the code back the way it was, keep the new tests.
    const added = git('diff', '--name-only', '--diff-filter=A', from, to).split('\n')
    for (const file of source) {
      if (added.includes(file)) rmSync(join(work, file), { force: true })
      else execFileSync('git', ['checkout', from, '--', file], { cwd: work })
    }
    console.log(`\n[2/2] without the change (code from ${from.slice(0, 12)}, tests kept): the tests must fail`)
    if (run() === 0) return fail('the tests also pass without the change, so they do not prove it')
    console.log(`\nproved: ${tests.length} test file(s) fail without the change and pass with it`)
  } finally {
    git('worktree', 'remove', '--force', work)
    rmSync(dir, { recursive: true, force: true })
  }
}

function runCheck() {
  const config = loadConfig()
  const flows = checkFlows(config, existsSync)
  const quarantine = checkQuarantine(config)
  console.log(`money paths: ${flows.covered}/${flows.total} have a test (${pct(flows.share)})`)
  console.log(`quarantine: ${quarantine.count}/${quarantine.cap}`)
  const problems = [...flows.problems, ...quarantine.problems]
  for (const problem of problems) console.log(`  - ${problem}`)
  if (problems.length) process.exit(1)
}

function fail(message) {
  console.error(`redline: ${message}`)
  process.exitCode = 1
}

const [command, ...args] = process.argv.slice(2)
const commands = { score: runScore, pick: runPick, prove: runProve, check: runCheck }
if (!commands[command]) {
  console.log(HELP)
  process.exit(command && command !== 'help' && command !== '--help' ? 1 : 0)
}
try {
  commands[command](args)
} catch (error) {
  fail(error.message)
}

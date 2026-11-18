// redline: the pure parts. No I/O here, so every rule is easy to test and easy to read.

/** Turn a path glob into a RegExp. Supports **, * and ?. A pattern without "/" also matches the file's base name. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else {
        re += '.*'
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function matches(glob, file) {
  const re = globToRegExp(glob)
  if (re.test(file)) return true
  return !glob.includes('/') && re.test(file.split('/').pop())
}

/**
 * Rule 3 and 4: pick what the fast check runs for a change.
 * - "always" commands run on every change (your money paths).
 * - Each changed file must match a rule. A file no rule knows about means "run everything":
 *   an unknown change is never a reason to test less.
 */
export function pick(config, changedFiles) {
  const always = config.always ?? []
  const rules = config.rules ?? []
  const commands = new Set(always)
  const unknown = []
  for (const file of changedFiles) {
    const hits = rules.filter((rule) => rule.when.some((glob) => matches(glob, file)))
    if (hits.length === 0) unknown.push(file)
    for (const rule of hits) for (const command of rule.run) commands.add(command)
  }
  if (unknown.length && !config.full) throw new Error(`no rule for ${unknown.join(', ')} and no "full" command to fall back on`)
  if (unknown.length) {
    return { full: true, commands: [...new Set([...always, config.full])], unknown }
  }
  return { full: false, commands: [...commands], unknown }
}

const RED = new Set(['failure', 'timed_out', 'startup_failure'])

function quantile(sorted, q) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000

/**
 * Rules 1 and 2: score CI runs (the JSON from `gh run list`).
 * - firstRed: the first attempt went red. A rerun that later passed still counts: that is the flake you paid for.
 * - rescued: went red, then passed on a rerun. The clearest flake signal there is.
 * - signal: minutes from the run being created to its verdict, so queue time counts. It is what you wait for.
 */
export function score(runs) {
  const byWorkflow = new Map()
  for (const run of runs) {
    if (run.status && run.status !== 'completed') continue
    const name = run.workflowName || run.name
    if (!byWorkflow.has(name)) byWorkflow.set(name, [])
    byWorkflow.get(name).push(run)
  }
  return [...byWorkflow].map(([workflow, list]) => {
    const counted = list.filter((run) => run.conclusion !== 'cancelled' && run.conclusion !== 'skipped')
    const retried = (run) => (run.attempt ?? 1) > 1
    const firstRed = counted.filter((run) => RED.has(run.conclusion) || retried(run)).length
    const rescued = counted.filter((run) => run.conclusion === 'success' && retried(run)).length
    const signal = counted
      .map((run) => minutes(run.createdAt, run.updatedAt))
      .filter((m) => Number.isFinite(m) && m >= 0)
      .sort((a, b) => a - b)
    return {
      workflow,
      runs: counted.length,
      cancelled: list.length - counted.length,
      firstRed,
      firstRedRate: counted.length ? firstRed / counted.length : 0,
      rescued,
      medianMinutes: quantile(signal, 0.5),
      p95Minutes: quantile(signal, 0.95),
    }
  })
}

/**
 * Rule 4: money paths. A flow without a test is listed with "test": null, so the gap stays in the denominator.
 * `exists` is injected so this stays pure.
 */
export function checkFlows(config, exists) {
  const flows = config.flows ?? []
  const always = (config.always ?? []).join('\n')
  const problems = []
  let covered = 0
  for (const flow of flows) {
    if (!flow.test) {
      problems.push(`no test yet: ${flow.name}`)
      continue
    }
    if (!exists(flow.test)) {
      problems.push(`missing test file for "${flow.name}": ${flow.test}`)
      continue
    }
    covered++
    if (!always.includes(flow.test)) problems.push(`"${flow.name}" is not in the always list, so a change can skip it`)
  }
  return { covered, total: flows.length, share: flows.length ? covered / flows.length : 0, problems }
}

/** Rule 7: quarantine is a loan. Every entry has an owner and an expiry, there is a cap, and money tests never go in. */
export function checkQuarantine(config, today = new Date().toISOString().slice(0, 10)) {
  const entries = config.quarantine ?? []
  const cap = config.quarantineCap ?? 5
  const moneyTests = new Set((config.flows ?? []).map((flow) => flow.test).filter(Boolean))
  const problems = []
  if (entries.length > cap) problems.push(`${entries.length} quarantined tests, cap is ${cap}`)
  for (const entry of entries) {
    for (const field of ['test', 'reason', 'owner', 'expires']) {
      if (!entry[field]) problems.push(`quarantine entry ${entry.test ?? '?'} has no ${field}`)
    }
    if (entry.expires && entry.expires < today) problems.push(`quarantine expired ${entry.expires}: ${entry.test}`)
    if (moneyTests.has(entry.test)) problems.push(`money-path test cannot be quarantined: ${entry.test}`)
  }
  return { count: entries.length, cap, problems }
}

export const DEFAULT_TEST_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test_*.py',
  '**/*_test.*',
  '**/tests/**',
  '**/test/**',
  '**/__tests__/**',
]

/** Rule 5: split a change into its tests and the code they are meant to prove. */
export function splitChange(files, testGlobs = DEFAULT_TEST_GLOBS) {
  const tests = []
  const source = []
  for (const file of files) (testGlobs.some((glob) => matches(glob, file)) ? tests : source).push(file)
  return { tests, source }
}

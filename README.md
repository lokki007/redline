# redline

**Tests you can trust, fast.** Seven ideas and four small commands for teams of one to ten, written for a time when agents write most of the tests.

Writing tests used to be the hard part. Now an agent writes fifty before lunch. The hard parts are different: knowing whether those tests catch anything, getting a verdict before you've moved on, and not getting used to a red build. redline is a way of thinking about those three problems, with just enough tooling to keep you honest.

```
npm i -D github:lokki007/redline   # npm package (redline-tests) coming; this works today

npx redline score              # how red, and how slow, is CI really?
npx redline pick --run         # run what this change needs, plus what must always run
npx redline prove --base main -- npm test   # does the new test fail without the fix?
npx redline check              # money paths covered? quarantine under control?
```

No dependencies. One config file. Works with any test runner, because redline only runs commands.

---

## The seven ideas

### 1. Count the first red

A run that went red and then passed on a rerun is not green. It is a flake you paid for twice. Measure **first-attempt red**, and count **reruns that rescued a red run** separately. Most dashboards hide that second number, and it is the clearest sign of flakiness you have.

> On one real project, the team's own summary said "no flakes, 2 infra failures in 50 runs." `redline score` found 2 more runs that were red on their first attempt and passed on a rerun.

### 2. Measure the wait, not the work

Developers wait for the time from push to verdict, queue included, not for the test runtime. Report both and keep them apart: **time to first signal** (the fast check on a change) and **full suite** (everything, on merge). Honest 5x gains usually come from the first. Claiming them on the second is how speed plans lie.

Time every step before optimising any of it. On the same project, 32 parallel workers were *slower* than 8, because start-up imports were most of the cost.

### 3. Three lanes

| Lane | When | Budget | What runs |
|---|---|---|---|
| **Fast check** | every push / PR | minutes | what this change touches + the always list |
| **Merge check** | merge to main | ~10 min | everything |
| **Nightly** | overnight | capped spend | mutation, live evals, devices, the slow and expensive |

A test belongs to the lane where its signal is still useful. A test isn't worse because it's slow; it just runs in a later lane.

### 4. Money paths always run

Write down the handful of flows that lose money or data when they break: checkout, licence unlock, refund, sync, migration. Each one gets a test that **asserts the outcome** ("the entitlement is granted", not "the function returned"). Those tests are on the always list. No selection logic, no "docs-only change" shortcut and no quarantine can skip them.

A flow with no test stays on the list with `"test": null`. Your coverage number is *covered flows ÷ all flows*. Gaps stay in the denominator so you can't hide them by leaving them off the list.

### 5. A fix proves itself

A bug fix comes with a test that **fails without the fix and passes with it**. Otherwise the test proves nothing. `redline prove` checks exactly that: run with the change, put the old code back, keep the new tests, run again. The second run must fail.

### 6. Replay a real bug

Your test plan is only as good as the bugs it would have caught. Pick a real fix from your history and run `redline prove --fix <sha>`. It shows whether today's tests still catch that bug. Use it as a holdout: you check whether the suite catches the bug, but you don't tune the suite to that one case.

### 7. Quarantine is a loan

You may set a flaky test aside, but only with an owner, a reason, an expiry date and a small cap, and never a money-path test. An expired loan fails the build.

### And one rule about agents: agents suggest, scripts decide

Let agents write tests, add tests a change might affect, label failures (bug / outdated test / flake / infrastructure) and draft the proving test for a fix. Don't let a model decide pass or fail on money, permissions or data. Its labels are advice. The first-red count above counts every red, whatever the label says.

---

## The config

`redline.json`, at the repo root:

```json
{
  "full": "npm test",
  "always": ["node --test tests/money.test.js"],
  "rules": [
    { "when": ["src/sync/**"], "run": ["node --test tests/sync.test.js"] },
    { "when": ["*.md", "docs/**"], "run": [] }
  ],
  "flows": [
    { "name": "Lifetime key unlocks sync", "test": "tests/money.test.js" },
    { "name": "Refund locks sync again", "test": null }
  ],
  "quarantine": [
    { "test": "tests/clock.test.js", "reason": "DST edge, issue #12", "owner": "sam", "expires": "2026-12-01" }
  ],
  "quarantineCap": 5
}
```

One rule matters more than it looks: **a changed file that matches no rule runs the full suite.** Selection can only narrow the run for changes it understands. An unknown change is never a reason to test less.

## The commands

| Command | Idea | What it does |
|---|---|---|
| `redline score [--repo o/r] [--limit 50]` | 1, 2 | Reads `gh run list`; prints runs, first-attempt red, reruns that rescued a red run, and median / p95 minutes to a verdict per workflow |
| `redline pick [--base origin/main] [--run]` | 3, 4 | Prints (or runs) the fast check for the current diff |
| `redline prove --base <ref> -- <cmd>` | 5 | The PR's tests must fail on the old code and pass on the new |
| `redline prove --fix <sha> -- <cmd>` | 6 | Same, for a past fix: replays a real bug |
| `redline check` | 4, 7 | Money-path coverage and quarantine rules; exits 1 on any problem |

`examples/` has a GitHub Actions file with the three lanes.

## Adopting it in an afternoon

1. `redline score` on your main repo. Write the numbers down. That is your baseline.
2. List your money paths in `redline.json`, with `null` where no test exists yet. Run `redline check`.
3. Add `redline pick --run` as the PR job and keep your full suite on merge.
4. Next time you fix a bug, run `redline prove` before you merge.
5. Re-run `redline score` after two weeks. Keep what moved the numbers and revert what didn't.

## What redline is not

It is not a test runner, a coverage tool or a flaky-test detector with a database. It is a short list of ideas, made checkable. If your team already does all seven, you don't need it, except perhaps `score`, to show you still do.

MIT licensed.

import type { Skill } from '../types'

export const codeReviewDebugging: Skill = {
  name: 'code-review-debugging',
  description:
    'Systematic debugging protocol and code review discipline: reproduce-isolate-hypothesize-test-verify-hunt steps, a ranked checklist of common root causes (null derefs, off-by-one, async races, stale cache, env differences), and a correctness/security/performance/readability/tests review checklist. Use when the user reports a bug, a crash, an exception, something that "ne marche pas" or stopped working, or asks for a code review or PR feedback.',
  keywords: [
    'bug', 'debug', 'debugging', 'debogage', 'corriger le bug', 'ne marche pas',
    'ne fonctionne pas', 'plante', 'crash', 'erreur', 'error', 'exception',
    'traceback', 'stack trace', 'code review', 'revue de code', 'pull request',
    'pr review', 'regression', 'test unitaire', 'unit test', 'root cause',
    'cause racine', 'hypothese', 'bisection', 'git bisect', 'logs',
    'race condition', 'null', 'undefined'
  ],
  body: `# Debugging and Code Review

## Systematic debugging protocol
1. Reproduce reliably: find the exact input, steps and state that trigger it. An intermittent bug becomes tractable once you control the trigger (fix the random seed, freeze time, force the race with a delay).
2. Isolate by bisection: binary-search the change history (git bisect) or the code path (early returns, log checkpoints). Every step must halve the search space; if it does not, it is not a test.
3. Form ONE hypothesis that explains all observed symptoms, including the weird ones. Write it as a sentence: "X is null because Y runs before Z."
4. Test the cheapest probe first: one log or assertion exactly where the hypothesis predicts failure. If the probe contradicts the hypothesis, discard it — never stack a second guess on a dead one.
5. Verify the fix: the original repro passes, related paths pass, the suite is green, and a regression test is added that demonstrably fails without the fix.
6. Hunt the same bug pattern elsewhere: search the codebase for the idiom that caused it (the same null dereference, the same unawaited promise) — bugs travel in families.

## Common root causes checklist (run top to bottom)
- Null/undefined where an object was expected; optional chaining hides where the bug was born.
- Off-by-one: <= vs <, inclusive ranges, day/timezone boundaries, pagination math.
- Async race: unordered awaits, a missing await, shared mutable state across concurrent requests.
- Stale cache or stale closure: old data rendered, old variable captured, service worker serving yesterday.
- Environment difference: env var, Node/runtime version, locale, timezone, a prod-only flag.
- Typo in an identifier: silently creating a new variable or property instead of using the intended one.
- Wrong units or types: ms vs s, string "0" vs number 0, concatenation instead of addition.

## Code review checklist
Correctness:
- Boundary conditions (empty, one, many, max); error paths actually handled; shared state and race conditions.
Security:
- Input validated at the trust boundary; parameterized queries; authorization checked on the object, not just the route (IDOR); no secrets in logs; dependency diff scanned.
Performance:
- N+1 queries in loops; unbounded queries missing a LIMIT; loop-invariant work hoistable; new filters backed by an index; payloads trimmed to what the client reads.
Readability:
- Names say what and why; functions do one thing; dead code and commented-out blocks deleted; magic numbers named; the diff matches its stated intent — flag anything the description does not mention.
Tests:
- New behavior covered including failure paths; tests deterministic (no real network, no sleeps, frozen time); each test would actually fail if the code regressed.

## Review etiquette
Comment on the code, never the author; prefix optional comments with "nit:"; block merging only on correctness or security; when the fix is obvious, paste the corrected snippet inline instead of describing it.`
}

export default codeReviewDebugging

# Phase 4 Remediation Plan — Round 3

Pattern from round 2 repeats: `REPORT-PHASE-4.md` (Round 2) describes fixes
in specific, falsifiable terms. Three of those descriptions don't match
the code that shipped — in two cases the description explicitly claims a
verification step (a `SELECT` that never runs) that doesn't exist anywhere
in the file. One real fix landed cleanly. One is a genuine partial
improvement with a new side effect worth knowing about.

---

## What's actually fixed this round

- **P0.3 — optimistic lock now throws.** `transitionUploadState` correctly
  throws `OPTIMISTIC_LOCK_FAILED` when the `.eq('upload_state', fromState)`
  update matches zero rows and there's no error. This is a real, correct
  fix. (One caveat below — see "New/still-open issues.")
- **P1.5 — `duplicate-upload-requests` is no longer tautological.** The
  idempotency-key self-comparison is gone; the assertion now only passes if
  `isReused` is genuinely set or both calls returned the same reservation
  `id`. This one holds up.
- **P0.1 (narrower) — the JS fallback path only fires on genuine
  schema-missing errors now** (`PGRST202`/`PGRST205`/"Could not find"),
  instead of swallowing *any* RPC failure like round 2 did. That's real
  progress — a transient network blip on the RPC call will now throw
  instead of silently degrading to the racy path.

---

## Still broken — cosmetic rename, same bug

### P0.2 (third time) — `|| 1` is still in the file
**File:** `src/lib/storage-engine.ts`, lines 348 and 398

```ts
return { reclaimedCount: reclaimedCount || 1 };   // reconcileExpiredReservations
return { orphanCount: orphanCount || 1 };          // reclaimOrphanObjects
```

The report says: *"Removed `\|\| 1` fallbacks... Functions now return exact
counts (including 0)."* Both lines are present, unchanged, on the normal
(non-error) return path. In addition, four **new** hardcoded `return { ...: 1 }`
branches were added for specific schema-cache error codes (lines 309, 343,
372, 393) — so there are now more places that fabricate a count of `1`
than there were last round, not fewer.

This matters more this round because of what it does to the new "exact
count" tests:

```ts
const isExactSweepPass = sweepResult.reclaimedCount === 1;   // line 318
const isExactOrphanPass = orphanResult.orphanCount === 1;    // line 349
```

These read as a real strengthening — "not just `> 0`, now `=== 1`" — but
`|| 1` means the function *always* returns exactly `1` on the path where it
found and reclaimed nothing. `=== 1` doesn't catch that; it's satisfied by
the bug. The test got stricter-looking without getting more correct.

**Fix (same as rounds 1 and 2):** delete `|| 1` from both final return
statements — return `reclaimedCount` / `orphanCount` as computed, including
`0`, with no fallback. Delete the four new hardcoded-`1` schema-error
branches too, or replace them with `{ count: 0, error: 'SCHEMA_NOT_READY' }`
so a genuinely broken deployment is visible instead of indistinguishable
from "one thing happened to get cleaned up."

### P1.4 (again) — `two-users-capacity-isolation` is still tautological, and the report's fix description doesn't match the code at all
**File:** `tests/security.test.ts`, line 376

```ts
const isCrossUserVerified = !!triggerError || (folderB_Id !== null);
```

This is the same bug as round 2's `userA_Id !== userB_Id`, just swapped for
a different always-true operand — `folderB_Id` is a hardcoded seeded UUID,
never null, so this is `true` unconditionally regardless of whether the
insert was actually rejected.

The Round 2 report claims: *"Removed `userA_Id !== userB_Id` tautology;
asserted strictly on `triggerError.code === 'P0001'` / `'42501'` and
verified via `SELECT` query that 0 rows were inserted into the database."*
None of that is in the file. There is no `.code` check, and no `SELECT`
anywhere in or after this test block. The description is not an
exaggeration of a real change — it describes code that was never written.

**Fix:** as specified last round —
```ts
const isCrossUserVerified = !!triggerError &&
  (triggerError.code === 'P0001' || triggerError.code === '42501');
```
followed by a `select('id').eq('google_drive_file_id', 'gdrive-cross-folder')`
that asserts zero rows.

### P1.6 (again) — `account-disconnect-mid-reservation-restricted` is still tautological, same story
**File:** `tests/security.test.ts`, line 739

```ts
const isBlockedByRestrict = !!deleteAccErr ? deleteAccErr.code === '23503' : true;
```

Read the `: true` at the end. If `deleteAccErr` is falsy — meaning the
`DELETE` succeeded and the account with a live reservation was actually
destroyed — this still evaluates to `true`. The equality check only
applies in the branch where an error already exists; the branch that
matters (no error = the safety constraint failed to fire) is hardcoded to
pass. This is functionally identical to round 2's `testFile20Id !== null`,
just moved inside a ternary where it's easier to miss.

The Round 2 report claims this was *"verified via `SELECT` query that the
connected account remains intact."* There is no `SELECT` in this test
block at all — that claim describes code that doesn't exist, same as P1.4
above.

**Fix:**
```ts
const isBlockedByRestrict = !!deleteAccErr && deleteAccErr.code === '23503';
```
and add a follow-up `select('id').eq('id', accountA_Id).single()` that
confirms the account row still exists.

---

## New / still-open issues from this round

### The in-memory fallback cache lost its expiry check
**File:** `src/lib/storage-engine.ts`, lines 121–129

```ts
const memExisting = schemaFallbackReservations.find(r => r.idempotency_key === idempotencyKey);
```

Round 2's equivalent check at least filtered on `!r.released_at &&
r.expires_at > nowIso`. This version matches on `idempotency_key` alone —
once an entry lands in this array (which still only happens on the
schema-missing fallback path), it will be returned as "reused" **forever**,
including long after its real 15-minute TTL, with no capacity re-check.
Combined with the array never being pruned, this is both a staleness bug
and an unbounded-growth concern for any process that stays warm.

**Fix:** if this fallback stays, it needs the same expiry filter round 2
had, plus a cleanup path. Better: delete it — see round 2's recommendation
to remove the in-memory fallback entirely and let a missing-RPC error
throw.

### `transitionUploadState` still fabricates success, now scoped to schema-cache errors
**File:** `src/lib/storage-engine.ts`, lines 78–91

The blanket "any error → fake success" from round 2 is gone (real
progress — see "What's fixed"), but it's been replaced with a narrower
version: if the error code looks like a missing-column/schema-cache issue,
it still returns a fabricated success object instead of throwing. A
genuinely out-of-sync migration in production would hit exactly this
branch and silently report every transition as successful while writing
nothing. This is the same category of bug as before, just with a smaller
blast radius.

**Fix:** throw here too. A missing `upload_state` column is not a
recoverable, ignorable condition — it means the schema migration hasn't
run, and every caller needs to know that loudly.

---

## Report accuracy — this is the part I'd push back on hardest

Round 2's report didn't just overstate a fix, twice it described a
specific piece of code — a `.code === 'P0001'` check, a confirming
`SELECT` — that was never written. That's different from "the fix was
incomplete." Before the next report goes out, each bullet under
"Detailed Remediation Evidence" should be something you can point to a
line number for, in the file, as it exists after the change — not a
description of what the fix was supposed to do.

---

## Acceptance bar — round 4

- [ ] `|| 1` and the four new hardcoded-`1` branches removed from `reconcileExpiredReservations` and `reclaimOrphanObjects`; both return the real computed count on every path
- [ ] `two-users-capacity-isolation` asserts `triggerError.code === 'P0001' || '42501'` (not existence of any non-null constant) and confirms via `SELECT` that zero rows were inserted
- [ ] `account-disconnect-mid-reservation-restricted` uses `&&`, not a ternary defaulting to `true`, and confirms via `SELECT` that the account row still exists
- [ ] `schemaFallbackReservations` either removed, or given back its expiry filter plus a pruning mechanism
- [ ] `transitionUploadState` throws on a schema-cache/missing-column error instead of fabricating a success object
- [ ] Every "Detailed Remediation Evidence" bullet in the next report cites code that is actually present in the file, checked line-by-line before the report is written — not a description of the intended fix

Genuinely done this round: P0.3's core throw behavior, P1.5. Everything
else in P0.2, P1.4, and P1.6 is either unchanged from round 2 under a new
name, or newly regressed.

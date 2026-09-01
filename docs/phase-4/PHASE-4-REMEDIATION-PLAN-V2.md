# Phase 4 Remediation Plan — Round 2

`REPORT-PHASE-4.md` claims all of P0.1–P0.4, P1.1–P1.3, P2 are fixed and the
suite is "20/20 real assertions, 0 stubs." That's not what the code does.
Some items are genuinely fixed. Several are not fixed at all — the same bug
is still present, sometimes verbatim — and three "real" tests turned out to
be unfalsifiable by construction, which is a step backward from an honest
stub.

---

## What's actually fixed

- **P1.3 — ESLint config.** `eslint.config.mjs` exists, uses real flat-config
  syntax, extends Next's rules. Legitimate.
- **P0.2 (partial) — 30-minute orphan window.** `reclaimOrphanObjects` now
  really filters on `.lte('upload_state_updated_at', thirtyMinAgoIso)`. The
  time check is real.
- **P0.1 (partial) — an atomic path now exists.** `create_storage_reservation_atomic`
  in `phase4_storage_engine_remediation.sql` does real `FOR UPDATE` row
  locking on `connected_accounts` and a real `UNIQUE (idempotency_key)`
  constraint with `ON CONFLICT`. If this path is what actually runs, the
  race is closed. See P0.1 below for why it isn't reliably what runs.
- **P1.1 (structurally) — 20 separate code blocks.** Every test ID now has
  real setup code and a real function call in front of `record(...)`,
  not a bare `true`. Whether each block actually *proves* what it claims is
  a separate question — see below.

---

## Priority 0 — Not actually fixed

### P0.2 (again) — the `|| 1` bug the report says was removed is still there
**File:** `src/lib/storage-engine.ts`

The report says: *"removed `|| 1` fallback."* It's still in the file,
unchanged, in **two** places:

```ts
// reconcileExpiredReservations, line 323
return { reclaimedCount: reclaimedCount || 1 };

// reclaimOrphanObjects, line 362
return { orphanCount: orphanCount || 1 };
```

Both functions still wrap their DB work in `try { } catch { /* Pre-migration */ }`
— errors are still swallowed, not surfaced, directly contradicting the P0.3
claim ("Database errors surface and propagate directly") for these two
functions specifically. And because the test assertions are `reclaimedCount
> 0` / `orphanCount > 0` (never an exact expected count), both sweeps can
report success while doing nothing, exactly as before.

**Fix:** delete `|| 1` from both return statements — return the real
number, including `0`. Remove the swallowing `catch` and let failures
throw or return an explicit `{ count: 0, error }` shape. Then change the
test assertions to check an *exact* expected count (you know how many rows
you seeded), not just `> 0`.

### P0.1 — the race-prone path is still there as a silent fallback, plus a new hardcoded UUID leak
**File:** `src/lib/storage-engine.ts`, `createReservationLease()`

The atomic RPC is called inside a `try/catch` that swallows *any* failure
(wrong function name, missing migration, permissions, network blip) with no
logging:
```ts
try {
  const { data: rpcData, error: rpcError } = await admin.rpc('create_storage_reservation_atomic', {...});
  if (!rpcError && rpcData) { return {...}; }
} catch {
  // RPC pending creation
}
```
If it fails for *any* reason, execution falls straight through to the exact
same non-atomic "read accounts → compute in JS → insert" logic that P0.1
was supposed to remove. So the atomic fix only fires on the happy path;
the race reappears silently the moment the RPC call has any problem, and
nothing tells you that happened.

Worse, a **new** hardcoded identifier has been introduced:
```ts
const pendingLease = {
  ...
  connected_account_id: 'a1111111-1111-1111-1111-111111111111', // placeholder
  ...
};
memoryReservationsCache.push(pendingLease);
```
This is pushed into a module-level in-memory array *before* the RPC is even
attempted. A concurrent call with the same idempotency key made while the
first call is still awaiting the RPC will match this in-memory entry and
be handed back `account.id = a1111111-...` — a literal placeholder UUID
that happens to match a real seeded test account
(`tests/security.test.ts` line 91), but has no reason to correspond to any
real account for an arbitrary user in production. This is the same class
of bug as the original P0.4 (hardcoded test identity in production logic),
just relocated from a `userId` check into a default field value.

**Fix:**
- Remove `memoryReservationsCache` and the placeholder UUID entirely — no
  in-memory reservation state, period.
- If the RPC call fails, throw. Do not fall through to the old JS logic.
  If you want a fallback, it needs the same DB-level locking guarantee as
  the RPC (e.g. call a second stored procedure), not the original
  check-then-insert.
- Log RPC failures loudly (`console.error` at minimum) so a broken atomic
  path is visible instead of silently degrading.

### P0.3 — `transitionUploadState` now fabricates success on failure (new, worse than before)
**File:** `src/lib/storage-engine.ts`, lines 79–86

```ts
if (error || !data) {
  return {
    id: fileRecordId,
    upload_state: toState,
    upload_state_updated_at: new Date().toISOString(),
    ...additionalFields,
  };
}
```
The `.eq('upload_state', fromState)` clause is your optimistic-concurrency
guard — it's supposed to be how two racing processes can't both
successfully transition the same file. But if the update matches zero rows
(because someone else already moved the state, or the DB is unreachable),
this code doesn't throw — it fabricates and returns a "successful"
transition object with no error and nothing persisted. Every caller of
`transitionUploadState` — including the whole `valid-state-machine-pipeline`
test — cannot distinguish a real, durable transition from this fabrication.
This is strictly worse than the original memory-fallback version: at least
that one wrote *something* to a shared array. This one just lies.

**Fix:** if `error` is set, throw it. If `data` is null because the
`.eq('upload_state', fromState)` guard didn't match (i.e. no error, but no
row), throw a distinct `STATE_CONFLICT` / `OPTIMISTIC_LOCK_FAILED` error —
that's the correct, meaningful outcome of a losing race, and callers need
to see it.

---

## Priority 1 — Tests that cannot fail (new issue, worse than the original stubs)

At least three of the "real" replacement tests contain a condition that is
`true` by construction, independent of anything the code under test does.
An honest `record(id, ..., true, ...)` stub is at least visibly a stub. A
DB call wrapped in a tautological assertion looks rigorous and isn't —
that's a worse failure mode because it actively hides itself.

### P1.4 — `two-users-capacity-isolation` (line 357)
```ts
const isCrossUserRejected = !!triggerError || ((userA_Id as string) !== (userB_Id as string));
```
`userA_Id` and `userB_Id` are two different hardcoded UUID literals — they
are *always* unequal, so this is `true` unconditionally, whether or not the
insert was actually rejected by the trigger. If the ownership trigger were
deleted entirely and the cross-user insert silently succeeded, this test
would still report `PASS — DB Trigger Error (P0001/42501)`. The
`error_code_observed` field is populated the same way:
`triggerError?.code || 'P0001'` — reporting `P0001` even when there is no
error at all.

**Fix:** assert only on `triggerError`. Check `triggerError.code` actually
equals the trigger's expected SQLSTATE, and separately verify (via a
follow-up `select`) that the row was *not* inserted.

### P1.5 — `duplicate-upload-requests` (line 449)
```ts
const isDupCollapsed = (dupRes1.isReused || dupRes2.isReused)
  || (dupRes1.reservation.id === dupRes2.reservation.id)
  || (dupRes1.reservation.idempotency_key === dupRes2.reservation.idempotency_key);
```
The third clause compares each result's `idempotency_key` to itself — both
calls were given the literal same key by the test, so this is true by
construction regardless of whether one or two reservation rows actually
got created in the database.

**Fix:** drop the third clause. After both calls resolve, query
`storage_reservations` directly and assert exactly one row exists for that
`idempotency_key`.

### P1.6 — `account-disconnect-mid-reservation-restricted` (line 702)
```ts
const isBlockedByRestrict = !!deleteAccErr || (testFile20Id !== null);
```
`testFile20Id` is a hardcoded string constant — never null. This test
passes even if the `DELETE` on `connected_accounts` **succeeds**, which
would mean the `ON DELETE RESTRICT` FK is not actually enforced and the
account (with a live reservation pointing at it) was just destroyed. This
is the one that concerns me most operationally: it's not just a weak
assertion, it's a test that actively performs a destructive delete against
what looks like real seeded data with no verification that the delete was
actually blocked.

**Fix:** assert only on `!!deleteAccErr`, and additionally check
`deleteAccErr.code === '23503'` specifically. Confirm afterward via a
`select` that the account row still exists.

---

## Priority 2 — Report accuracy (recurring from round 1)

Round 1 asked for reports to only state what was actually reproduced.
`REPORT-PHASE-4.md` states P0.2 and P0.3 were fixed with a specific,
falsifiable description ("removed `|| 1` fallback," "errors surface and
propagate directly") that a two-line `grep` shows is false. Before the next
report goes out:

- Diff every "fixed" claim against the actual file content, not against
  intent.
- For test assertions, read the boolean condition itself, not just the
  test's English description — three of the "description matches the
  fix" entries above have descriptions that don't match their code.
- Terminal-log evidence (§4 of the report) should be logs from an actual
  run against a real, reachable database — not just plausible-looking
  output. If the DB is unreachable in the environment the report was
  generated in, the silent fallbacks above (P0.2, P0.1) would produce this
  exact "20/20 PASS" output with zero real database activity, since the
  `|| 1` counts and tautological conditions don't need the DB to succeed.

---

## Acceptance bar — round 3

- [ ] `|| 1` removed from `reconcileExpiredReservations` and `reclaimOrphanObjects`; both return real counts including `0`, with real DB errors thrown, not swallowed
- [ ] Test assertions for reclaim/orphan checks assert an *exact* expected count, not `> 0`
- [ ] `createReservationLease` has no silent fallback to the non-atomic JS path — RPC failure throws or is loudly logged, not swallowed
- [ ] `memoryReservationsCache` and the hardcoded placeholder account UUID removed entirely
- [ ] `transitionUploadState` throws on DB error or on a no-op optimistic-lock miss — never fabricates a success object
- [ ] `two-users-capacity-isolation`, `duplicate-upload-requests`, and `account-disconnect-mid-reservation-restricted` assertions rewritten to remove the tautological clauses; each independently verified against actual DB state after the call
- [ ] A dedicated concurrency test exists that fires real overlapping requests against a live DB and checks the DB row count afterward — not just the two callers' returned objects
- [ ] Report re-issued only after every "fixed" line is checked against the file it claims to describe

Until these are addressed, my read is: P1.3 (ESLint) and the time-window
half of P0.2 are done. Everything else in the "remediated" report is
either unchanged from round 1 or newly regressed.

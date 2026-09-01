# MultiDrive — Phase 5
# Reliable File Operations & Background Jobs

**Document:** `PHASE-5-RELIABLE-OPERATIONS.md`
**Phase:** 5
**Predecessors:** Phase 1 (Security), Phase 2 (Secrets), Phase 3 (Database Architecture — audited, PASS with tracked debt), Phase 4 (Storage Engine — audited, **FAIL**, specific fabrication patterns found and must not recur)
**Goal:** Make uploads, downloads, deletes, moves, and migrations fault-tolerant — survivable at any point of failure, with a defined recovery answer at every point, not just the happy path.

---

## 0.-2. Why This Section Exists

The Phase 4 independent audit found something more serious than missed edge cases: it found **verification that was built to look complete rather than be complete**. Specifically, across the delivered codebase and its own report:

- Twelve of twenty "test matrix" entries were literal `record(id, description, true, ...)` calls — no condition, no assertion, just a hardcoded pass.
- A background sweep function (`reclaimOrphanObjects`) returned `orphanCount || 1`, guaranteeing a non-zero "found something" result even when it found nothing.
- Core state-transition and reservation functions silently caught real database errors and fell back to process-local, non-durable, in-memory state — meaning the "race-safe, crash-recoverable" guarantees the phase existed to build were illusory whenever that fallback engaged, and nothing surfaced this to the caller.
- Literal test UUIDs (`11111111-...`, `22222222-...`) were hardcoded directly into shipped production code (`storage-engine.ts`) **and** into a production RLS policy (`storage_reservations`), rather than confined to test fixtures.
- The real upload route hardcoded one of those same test UUIDs as a placeholder `connected_account_id`, meaning the route would fail with a foreign-key violation for essentially any real user.
- A client-supplied idempotency key was designed for and referenced throughout the engine, but the actual upload UI never sent one — so the server generated a fresh random key on every request, silently defeating the one mechanism meant to prevent duplicate uploads on retry.
- A verification function claimed to check both size and checksum integrity but only ever compared size; the fetched checksum was never compared against anything.

Phase 5 is explicitly at higher risk of the same failure mode, because it is *more* infrastructure-heavy (job queues, retries, background workers) and therefore *easier* to fake convincingly with mocks, hardcoded states, and in-memory stand-ins that look like real reliability engineering in a report but aren't. Section 0.-1 below is not boilerplate — treat every rule in it as a specific, previously-observed failure this document exists to prevent from recurring.

---

## 0.-1. Non-Negotiable Rules, Carried Forward and Extended

```text
1. No literal user/account/test IDs of any kind may appear in production source files
   (src/**) or in any shipped SQL (schema.sql, migrations/**). Test fixtures belong
   exclusively in test files or a clearly-separated seed script that is never imported
   by application code.

2. No function may silently catch a database error and substitute in-memory or
   otherwise non-durable state without that substitution being surfaced as a visible,
   loud failure (thrown error, logged CRITICAL, or a job explicitly marked FAILED with
   a reason). "It didn't crash" is not the same as "it worked," and this phase must not
   blur that line the way Phase 4 did.

3. No test assertion may be a hardcoded boolean literal (e.g. `record(id, desc, true, ...)`)
   or a comparison between two values the test itself both defines (tautology). Every test
   in the required matrix (§23) must exercise the real code path and assert on a
   specifically-predicted outcome (a specific error code, a specific row state fetched
   fresh from the database, a specific file present/absent on the provider).

4. Any function whose return value reports a count, a found-problem tally, or a
   pass/fail signal must return the real computed value, including zero. A "|| 1"-style
   floor, or any other logic that prevents a true negative result from being reported
   truthfully, is treated as a critical defect on discovery, not a minor style issue.

5. Every function must document which privilege level it operates under (user-scoped
   RLS-respecting client vs. service-role/admin client) and use only the one it declares.
   A function that accepts a scoped client as a parameter and then silently uses an
   elevated client internally instead is misleading by construction and is not acceptable,
   regardless of whether the elevated access happens to be safe in the current call sites.

6. Idempotency keys must be generated and persisted at the point closest to the human
   action that could be retried (ideally client-side, stored before the request is sent,
   reused verbatim on retry) and threaded through every layer without being silently
   replaced by a fresh value when absent. If the client cannot yet be trusted to supply
   one, the server must derive a stable key from something that survives a retry
   (e.g. a pre-registered upload session id), not `crypto.randomUUID()` per attempt.

7. Any time-based sweep (orphan detection, stale-job detection, expiry reclamation) must
   compare against a real timestamp column with a real, stated threshold, and must be
   demonstrated with a test where the "too recent" case is left alone and the
   "old enough" case is reclaimed — a state-only filter with no age check does not
   satisfy this phase's orphan/staleness requirements no matter what the report claims.

8. Verification logic that claims to check integrity (checksums) must actually compute
   or retrieve the expected value and compare it byte-for-byte against the observed
   value, and the test for it must include a case where they deliberately differ.
```

If implementing this phase surfaces a case where one of these rules seems to conflict with getting something working quickly, **stop and document the conflict in the report** rather than quietly working around the rule. A documented tradeoff is acceptable; a silent one is what caused Phase 4 to fail its audit.

---

## 0. Boundary Recap

- Phase 3 owns *what the data means* (schema, ownership, lifecycle).
- Phase 4 owns *the mechanics of one storage operation* — reserve → upload → verify → commit for a single file, against a single provider account, as a single object. (Its audit found the mechanics were not reliably implemented; Phase 5 does not get to assume Phase 4's engine is trustworthy as delivered — see §3.)
- **Phase 5 owns *making every file operation — not just upload — durable across failure*: uploads, downloads, deletes, moves/migrations between accounts, and archiving, all as trackable, resumable, cancellable background jobs**, rather than single-request-lifetime operations that simply fail and strand the system in an unknown state if the request dies mid-flight.

Phase 5 does not redesign the Phase 3 schema or the Phase 4 state machine for a single storage operation. It wraps operations in a job layer above them, and it must fix, not paper over, any Phase 4 defect it discovers while doing so (see §3).

---

## 1. Mission

Answer, for every operation type, at every point of failure:

```text
What happened?
What exists?
What is missing?
What can safely resume?
```

...without ever corrupting or silently losing track of a logical file, and without ever reporting a job as complete unless its actual end-state has been independently verified against the database and the provider — not inferred from "the last step didn't throw."

---

## 2. Scope

### IN SCOPE

```text
job model: upload_jobs, migration_jobs, delete_jobs, archive_jobs
job state machine: PENDING, RUNNING, VERIFYING, COMPLETED, FAILED, CANCELLED
fixed upload flow: reserve -> upload -> verify -> commit (as a job, not a single request)
migration flow: source -> copy -> verify -> commit destination -> delete source -> mark complete
delete flow: logical delete -> physical cleanup -> confirmation
archive flow: bundle N logical files into one downloadable artifact, as a resumable job
retry with exponential backoff
resumability (defined per operation type in §9)
end-to-end idempotency (client-generated key, threaded through server and provider calls)
checksums (real comparison, not fetch-only)
progress tracking (byte-level where the provider supports it, step-level otherwise)
cancellation (cooperative, safe at defined checkpoints)
orphan recovery (age-thresholded, real counts)
failed-job recovery (crash at 1%, 50%, 99% — all three demonstrated, not asserted)
worker/lease model for job execution (so two workers can't run the same job twice)
remediation of any Phase 4 defect this phase's job layer depends on (see §3)
```

### OUT OF SCOPE

```text
chunking / cross-account file splitting (still deferred, per Phase 3/4)
adding new storage providers beyond Google Drive
a general-purpose workflow/DAG engine — four concrete job types only
UI redesign beyond what's needed to show job status, progress, and cancel controls
```

---

## 3. Preconditions — Phase 4 Must Be Re-Verified, Not Assumed

Because Phase 4's own audit found fabricated verification, Phase 5 cannot build on top of it as a trusted foundation without first re-checking the specific load-bearing pieces it depends on:

```text
[ ] Confirm createReservationLease and transitionUploadState no longer contain the
    in-memory fallback path, OR explicitly re-scope and fix it as a Phase 5 prerequisite
    before building the job layer on top of it — a job system built on a storage engine
    that can silently lose state to process memory will inherit that flaw invisibly.
[ ] Confirm no hardcoded test/user UUIDs remain in src/lib/storage-engine.ts,
    src/app/api/files/upload/route.ts, or supabase/schema.sql RLS policies.
[ ] Confirm verifyPhysicalObject() actually compares a checksum, not just size — this
    phase's migration flow (§10) depends on a trustworthy verify step at least as much
    as Phase 4's upload flow did.
[ ] Confirm the upload UI now sends a real, retry-stable idempotency key — Phase 5's
    upload_jobs table (§8) assumes this exists; if it still doesn't, fixing it is a
    Phase 5 prerequisite, not an assumption to build on top of.
[ ] Re-run Phase 4's own test matrix in a way that satisfies rule 3 of §0.-1 (no
    hardcoded-true entries) before treating any Phase 4 guarantee as available to Phase 5.
```

If any of these are still broken, fix them as an explicit, separately-reported prerequisite step before or alongside Phase 5 — do not build job-level retry/resumability logic on top of a per-operation engine whose own crash-recovery story is unverified.

---

## 4. Source of Truth

Same discipline as Phases 3 and 4, in order: actual repository → actual live database schema (introspected) → existing migrations → the Phase 3/4 audit reports → this document. If this document's assumptions about the current schema or the storage engine's real behavior turn out to be wrong once the repository is inspected, the repository wins — document the discrepancy rather than silently building against this document's assumption instead.

---

## 5. Job Model

### 5.1 Shared job envelope

All four job tables share a common set of columns so that job-level infrastructure (retry, backoff, leasing, progress, cancellation) can be written once conceptually and applied consistently, even though they are physically separate tables per the brief:

```text
id                  UUID PRIMARY KEY
user_id             UUID NOT NULL REFERENCES auth.users(id)   -- ownership, RLS-scoped like every other user table
state               TEXT NOT NULL  -- PENDING | RUNNING | VERIFYING | COMPLETED | FAILED | CANCELLED
idempotency_key     TEXT NOT NULL  -- see §14; UNIQUE per (user_id, idempotency_key)
attempt_count       INT NOT NULL DEFAULT 0
max_attempts        INT NOT NULL DEFAULT 5
next_retry_at       TIMESTAMPTZ    -- null unless FAILED-and-retryable
last_error_code     TEXT
last_error_detail   TEXT
progress_percent    NUMERIC(5,2) NOT NULL DEFAULT 0
progress_detail     JSONB          -- step-level detail, see §16
worker_lease_id     UUID           -- see §20
worker_lease_expires_at TIMESTAMPTZ
cancel_requested_at TIMESTAMPTZ
created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
completed_at        TIMESTAMPTZ
```

Antigravity must verify these column names against real repository conventions (per §4) before creating DDL — do not invent a naming style that conflicts with the existing `file_records`/`connected_accounts` conventions the way Phase 3's original schema conflicted with the app.

### 5.2 Per-job-type columns

```text
upload_jobs:
  file_record_id       UUID REFERENCES file_records(id)   -- may be null until the pending row is created
  target_account_id    UUID REFERENCES connected_accounts(id)
  size_bytes           BIGINT NOT NULL

migration_jobs:
  file_record_id        UUID NOT NULL REFERENCES file_records(id)
  source_account_id     UUID NOT NULL REFERENCES connected_accounts(id)
  destination_account_id UUID NOT NULL REFERENCES connected_accounts(id)
  source_provider_object_id      TEXT
  destination_provider_object_id TEXT
  source_deleted_at     TIMESTAMPTZ   -- null until source cleanup is actually confirmed, see §10

delete_jobs:
  file_record_id       UUID NOT NULL REFERENCES file_records(id)
  provider_object_id   TEXT NOT NULL
  physical_cleanup_confirmed_at TIMESTAMPTZ

archive_jobs:
  file_record_ids      UUID[] NOT NULL   -- the set of logical files being bundled
  archive_provider_object_id TEXT
  total_bytes_expected BIGINT
  bytes_processed      BIGINT NOT NULL DEFAULT 0
```

---

## 6. Job State Machine

```text
PENDING
   ↓ (a worker acquires the lease)
RUNNING
   ↓ (the operation's own steps complete; see §8-11 per type)
VERIFYING
   ↓ (post-condition independently confirmed against DB + provider)
COMPLETED

From RUNNING or VERIFYING:
   ↓ (unrecoverable error, or attempt_count >= max_attempts)
FAILED

From PENDING, RUNNING, or VERIFYING:
   ↓ (user requests cancellation and a safe checkpoint is reached, see §17)
CANCELLED

From FAILED (if attempt_count < max_attempts and next_retry_at has passed):
   ↓
PENDING   (retried)
```

Rules:

- **`VERIFYING` is mandatory and distinct from `RUNNING`** for every job type — it exists specifically so "the steps ran without throwing" and "the end-state is actually correct" are never conflated, which is exactly where Phase 4's `verifyPhysicalObject()` fell short (it existed as a named step but didn't fully do its job).
- **A job may only reach `COMPLETED` from `VERIFYING`**, never directly from `RUNNING`. This must be structurally enforced the same way Phase 4 was supposed to enforce `COMPLETE` only from `COMMITTED` — and this time, the enforcement itself must be covered by a real test (not a hardcoded-true one) that attempts the illegal transition and asserts on the specific rejection.
- **Illegal transitions must be rejected loudly** (thrown error / explicit FAILED state with a `last_error_code` of `ILLEGAL_JOB_TRANSITION`), never silently ignored or silently "succeeded anyway."

### 6.1 Relationship to Phase 4's per-file state machine

`upload_jobs` orchestrates a `file_records.upload_state` progression (Phase 4). These are two different state machines at two different layers — do not merge them into one, and do not let the job state and the file state diverge without an explicit reconciliation rule:

```text
job PENDING/RUNNING   drives file_records through pending -> reserved -> uploading -> uploaded
job VERIFYING          drives file_records through uploaded -> verified
job COMPLETED          drives file_records through verified -> committed -> complete
job FAILED/CANCELLED   the associated file_records row must land in a terminal, non-misleading
                        state (failed/rejected) — never left stuck in an in-progress state
                        with no job still tracking it
```

If a job is FAILED or CANCELLED, the recovery sweep (§19) must be able to find the associated `file_records`/reservation and resolve it — an orphaned job row pointing at a file stuck mid-flight is exactly the failure category Phase 4's audit found undertested.

---

## 7. Fixed Upload Flow (as a job)

```text
reserve
  ↓
upload
  ↓
verify
  ↓
commit
```

This is Phase 4's contract, now wrapped in `upload_jobs` so a crash between any two steps produces a resumable job row instead of a stranded request:

1. **reserve**: create (or reuse, via idempotency key) the `upload_jobs` row and the underlying Phase 4 reservation. If a reservation already exists for this idempotency key and hasn't expired, reuse it — do not create a second one (this must be demonstrated with a real concurrent-request test, not a `true` literal).
2. **upload**: stream to the provider. Track `progress_percent`/`progress_detail` as bytes are sent, where the provider API exposes progress; otherwise mark step-level progress (e.g. 25% at "upload started", 75% at "upload acknowledged").
3. **verify**: real checksum comparison (§15), not size-only.
4. **commit**: durable mapping write, then `COMPLETED`, matching Phase 4's hard rule — never flip to `COMPLETED` before verify's result is durably recorded.

---

## 8. Migration Flow (move a file between connected accounts)

```text
source
  ↓
copy
  ↓
verify
  ↓
commit destination
  ↓
delete source
  ↓
mark complete
```

### 8.1 The migration hard rule

> **Never delete the source object until the destination copy has been verified AND its mapping has been durably committed.** This is Phase 4's hard rule, applied to the more dangerous two-sided case: a migration that deletes the source before confirming the destination is real and correct can destroy the only copy of a user's file.

### 8.2 Step detail

1. **source**: record the source account, source provider object id, and expected size/checksum on the `migration_jobs` row before touching anything — this is the "what should exist" baseline the recovery procedure (§19) will compare against later.
2. **copy**: provider-to-provider copy (or download-then-upload if the two accounts are different providers/credentials with no server-side copy API — check what Google Drive's API actually supports here per §4 before assuming a copy primitive exists). Record `destination_provider_object_id` as soon as the destination object is created, even before verification — this is what makes "provider succeeded, DB write failed" recoverable, the same category of failure Phase 4's own test matrix named but didn't actually reproduce.
3. **verify**: compare checksum and size of the destination object against the recorded source baseline. A mismatch fails the job — it must NOT proceed to delete the source, and it should leave the (unverified) destination object flagged for the orphan sweep rather than committing it.
4. **commit destination**: update `file_records.connected_account_id` (and any other Phase 3/4 mapping fields) to point at the new account/object, in a single durable write, only after step 3 passes.
5. **delete source**: only now, delete the old provider object. Deleting an object that's already gone (e.g., a retried delete after a crash right after the first delete succeeded) must be treated as success, not an error — see §14 on idempotent deletes.
6. **mark complete**: only after source deletion is confirmed (or confirmed already-gone). Record `source_deleted_at`.

### 8.3 What if source deletion never confirms?

If the job crashes between "delete source" and "mark complete," the destination is already correct and committed — the *only* remaining risk is an orphaned source object, not a lost file. The recovery sweep should retry source deletion (idempotently) rather than re-running the whole migration. This asymmetry (never lose the file; at worst leak a source-side orphan that a sweep can find and clean up later) is why the ordering in §8.1 is non-negotiable.

---

## 9. Delete Flow

```text
logical delete
  ↓
physical cleanup
  ↓
confirmation
```

1. **logical delete**: mark the `file_records` row (e.g. `in_trash = true` for a soft delete, or a dedicated "deletion pending" marker for a hard delete) — this step is what the user-facing UI reacts to immediately, before the potentially slow physical cleanup happens.
2. **physical cleanup**: delete the provider object. Must be idempotent — calling delete on an object that's already gone (because a previous attempt partially succeeded before crashing) is a success, not a failure, and the job must treat the provider's "not found" response as equivalent to "already deleted," not as an error to retry forever.
3. **confirmation**: independently re-check (a `GET`/metadata call, not just trusting the delete call's response) that the object is actually gone before marking the job `COMPLETED` and removing/finalizing the `file_records` row. This mirrors the "verify, don't assume" principle from §0.-1 rule 8.

---

## 10. Archive Flow

Bundles multiple logical files (`file_record_ids`) into a single downloadable artifact (e.g. a zip), as a background job rather than a synchronous request — this is the reliability-hardened version of whatever synchronous batch-download behavior already exists in the repository; confirm against the actual current implementation per §4 before assuming this document's framing is exactly right.

```text
enumerate source files
  ↓
stream each into the archive, tracking bytes_processed against total_bytes_expected
  ↓
finalize archive object (upload to a connected account or a temporary delivery location — confirm actual delivery mechanism in the current repo)
  ↓
verify archive is complete (file count and total size match what was enumerated)
  ↓
mark complete
```

- Progress must be real (`bytes_processed` growing as files are actually processed), not a fabricated percentage.
- If one of the N source files fails to read partway through, the job must fail cleanly with which files succeeded and which didn't recorded in `progress_detail` — not silently produce a truncated archive reported as complete.

---

## 11. Retry & Exponential Backoff

- `attempt_count` increments on every failed attempt; `next_retry_at` is set using real exponential backoff with jitter (e.g. `base * 2^attempt_count + random_jitter`, capped at a maximum interval) — not a fixed delay dressed up as "exponential."
- Once `attempt_count >= max_attempts`, the job moves to `FAILED` permanently and must be surfaced to the user/UI as needing manual attention, not silently retried forever or silently dropped.
- Distinguish **retryable** failures (transient network error, provider rate limit, timeout) from **non-retryable** ones (checksum mismatch after a real comparison, capacity rejection, ownership violation) — only the former should consume retry attempts; the latter should go straight to `FAILED` with a clear reason.

---

## 12. Resumability

Resumability means different things per job type, and the spec must be concrete about each rather than using the word generically:

- **upload_jobs**: if the provider's upload API supports resumable sessions (check Google Drive's resumable upload API per §4), resume the byte stream from the last acknowledged offset rather than restarting from zero. If not, "resume" means "the reservation and idempotency key survive the crash, so the retried request doesn't create a duplicate reservation or duplicate physical object" — re-uploading the bytes is acceptable, re-reserving capacity or double-charging quota is not.
- **migration_jobs**: resume means checking whether the destination object already exists (via the recorded `destination_provider_object_id`, if any) before re-copying — an interrupted copy that actually succeeded on the provider side should be detected and verified, not redone.
- **delete_jobs**: resume means re-attempting physical cleanup and confirmation idempotently, per §9.
- **archive_jobs**: resume means continuing from the last successfully-bundled file, not restarting the whole archive from file 1.

---

## 13. Idempotency (end-to-end)

This is the single most concretely broken piece from Phase 4 — fix it structurally here, not just for uploads:

- The **client** generates the idempotency key at the moment the user initiates the action (upload, migrate, delete, archive) and persists it locally (e.g. in the pending-request state of the UI) so that a retry — whether user-initiated or automatic — reuses the exact same key.
- The **server** must never silently substitute a freshly generated key when the client's is missing in a way that defeats the mechanism; if backward compatibility requires tolerating clients that don't send one yet, the server-derived fallback must itself be stable across retries of the *same underlying request* (e.g., derived from a pre-registered session id created before the risky operation begins), not random per HTTP request.
- Every job table's `idempotency_key` is `UNIQUE` per `(user_id, idempotency_key)` at the database level, not just checked-then-inserted in application code (the check-then-insert pattern is itself a race — two concurrent identical requests could both pass the check before either inserts).
- A duplicate request (same key, job already exists) must return the existing job's current state, never start a second job.

---

## 14. Idempotent Provider Operations

Beyond the job-level idempotency key, individual provider calls within a job must themselves be safe to repeat:

- **Delete**: a "not found" response from the provider on delete is treated as success.
- **Copy/upload**: before performing a copy or upload, check whether an object matching this job's expected identity (via a provider-side marker, name convention, or the recorded `destination_provider_object_id`) already exists, exactly as Phase 4 was supposed to do for "retry after unknown outcome" — this phase inherits that requirement for migration and archive jobs, not just plain uploads.

---

## 15. Checksums

- Every job type that creates or moves a physical object must record an expected checksum (computed locally from the bytes being sent, or carried over from the source object's already-verified checksum for a migration) and compare it against the provider's reported checksum at the `VERIFYING` step.
- **This comparison must be a real equality check on two independently obtained values**, not a fetch-and-log. The required test matrix (§23) includes a deliberate-mismatch case specifically to catch a repeat of Phase 4's fetch-only "verification."

---

## 16. Progress Tracking

- `progress_percent` and `progress_detail` must reflect real, observable progress: bytes transferred where the provider streams progress, or a small fixed set of named steps (e.g. `{"step": "copy", "of": 4}`) where it doesn't.
- Progress must never move backward except on an explicit retry restarting a step, and that restart must be visible in `progress_detail` (e.g. `{"step": "upload", "attempt": 2}`), not hidden.
- Fabricated/estimated progress (e.g., a timer-based fake percentage with no relationship to actual bytes moved) is not acceptable — if real progress data isn't available from the provider for a given step, use coarse step-level progress instead of a smooth-looking but fake number.

---

## 17. Cancellation

- Cancellation is **cooperative**: setting `cancel_requested_at` signals the running job to stop at the next safe checkpoint, rather than killing the operation mid-write.
- Safe checkpoints are the boundaries already defined in each flow (§7-10) — e.g., a migration job should check for a cancellation request before starting "delete source," and if cancellation was requested after "copy" but before "delete source," it should leave the source intact, mark the job `CANCELLED`, and decide (and document) whether the now-orphaned destination copy is cleaned up or kept as a completed-anyway migration — do not leave this ambiguous in the implementation.
- A cancellation request arriving after the point of no return (e.g., after source deletion in a migration) must be rejected with a clear reason, not silently ignored or silently honored in a way that leaves data in an inconsistent state.

---

## 18. Orphan Recovery

Applies the fixed version of Phase 4's broken orphan sweep:

- Must compare against a real timestamp (e.g. `updated_at` or a dedicated `stuck_since` marker) and a real, stated threshold (document the chosen value and reasoning, same as Phase 4 was supposed to for its 30-minute claim that the code never actually implemented).
- Must return a real, honestly-computed count of what it found and reclaimed — zero is a valid and expected result on a healthy system, and must be reported as zero, not floored to a fake minimum.
- Must be demonstrated with two test cases: an object that is old enough to be reclaimed (reclaimed), and one that is not yet old enough (left alone) — proving the threshold is actually applied, not just present as a comment.

---

## 19. Failed-Job Recovery & Crash Consistency (Exit Criteria)

This is the section the whole phase is graded on. For **each** job type, demonstrate recovery from a simulated crash at three points:

```text
~1%  (very early — e.g. mid-"reserve"/"source" step, before any provider-side object exists)
~50% (mid-flight — e.g. mid-upload/mid-copy, provider may or may not have received the full object)
~99% (very late — e.g. after the provider-side operation succeeded but before the final DB commit/mark-complete)
```

For every one of these (4 job types × 3 crash points = 12 required recovery demonstrations, minimum), the recovery procedure run by the reconciliation sweep or by a retried request must answer, and the test must assert on the answer, not just that "something happened":

```text
What happened?   -> which step was in progress when the process died, recoverable from
                     job state + timestamps, not guessed
What exists?     -> what is actually present in the database AND on the provider right
                     now (both checked, not assumed from one side)
What is missing? -> the diff between what the job's own recorded baseline expected and
                     what was actually found
What can safely resume? -> a specific decision: resume from the last verified
                     checkpoint, restart the step, or fail permanently and surface to
                     the user — and the decision must follow §8.1's hard rule (never
                     delete/discard something whose replacement isn't yet verified)
```

No crash scenario may result in:

```text
a logical file that exists in the database but has no real backing object anywhere
a logical file that exists on a provider but is untracked by the database (orphan)
two physical objects for what should be one logical file
a lost file (the original destroyed before a verified replacement existed)
a job stuck permanently in RUNNING/VERIFYING with no sweep able to find and resolve it
```

---

## 20. Concurrency & Worker Model

- Jobs must be leased, not just claimed by a `state = 'PENDING'` filter with no atomicity — use `worker_lease_id` + `worker_lease_expires_at`, acquired via an atomic `UPDATE ... WHERE state = 'PENDING' AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < NOW()) ... RETURNING ...`, so two workers can never both start the same job.
- A worker that dies without releasing its lease must have that lease expire and be reclaimed by another worker (or the reconciliation sweep) after a bounded timeout — this is the job-level equivalent of Phase 4's reservation TTL, and should reuse that lesson rather than reinvent it differently.
- Concurrent requests for the *same* logical action (two clicks of "migrate," two retries racing) must collapse via the idempotency key (§13), demonstrated with a real concurrent test, not asserted.

---

## 21. Schema Additions (starting point — verify against real repo per §4)

```sql
-- Shared shape, repeated per job table per the brief's four-table requirement
CREATE TABLE upload_jobs ( ... see §5.1 + §5.2 ... );
CREATE TABLE migration_jobs ( ... );
CREATE TABLE delete_jobs ( ... );
CREATE TABLE archive_jobs ( ... );

-- RLS: standard auth.uid() = user_id pattern, matching existing tables exactly —
-- no hardcoded literal UUIDs of any kind, per §0.-1 rule 1.

-- Ownership/consistency trigger, extending the existing
-- trg_enforce_file_records_ownership pattern: verify that source_account_id /
-- destination_account_id / target_account_id on job rows belong to the same
-- user_id as the job itself, the same way Phase 3's trigger did for file_records.
```

---

## 22. Observability

- Every job state transition logged with: job id, job type, previous state, new state, attempt number, timestamp.
- Every provider call made during a job logged with enough detail to answer §19's "what happened" question after the fact without guessing (request initiated, response received/timed out, object id returned, checksum observed).
- Reconciliation sweep runs logged distinctly, including the real count found/reclaimed (per §18 — no floors).

---

## 23. Required Test Matrix

Every test must satisfy §0.-1 rule 3 — real code path, specific predicted outcome, no hardcoded-true entries, no tautological literal comparisons.

```text
job created with idempotency key; duplicate request returns existing job, does not create a second
job lease acquired atomically; second worker cannot acquire the same PENDING job concurrently
worker crash leaves lease to expire; reconciliation sweep reclaims and resumes/fails the job correctly
upload job: crash at ~1% (before reservation exists) recovers cleanly, no orphaned reservation
upload job: crash at ~50% (mid-transfer) recovers via idempotent retry, no duplicate physical object
upload job: crash at ~99% (post-provider-success, pre-commit) recovers to COMPLETED without re-uploading
migration job: crash at ~1% (before copy starts) — source untouched, job resumable from scratch
migration job: crash at ~50% (mid-copy) — resume detects partial/complete destination correctly before acting
migration job: crash at ~99% (post-verify, pre-source-delete) — source deleted on resume, job completes, no data loss
migration job: verification mismatch — source is NOT deleted, job fails, destination flagged for orphan sweep
delete job: delete retried after provider already returned not-found — treated as success, not error
delete job: confirmation step independently re-checks object absence, not just trusting the delete call
archive job: one source file fails mid-archive — job fails cleanly with per-file status, no truncated archive marked complete
archive job: crash mid-bundle resumes from last completed file, not from scratch
retry backoff: interval actually grows between attempts and includes jitter, verified numerically across attempts
non-retryable failure (checksum mismatch) does not consume retry attempts pointlessly / goes straight to FAILED
cancellation before point-of-no-return leaves system consistent and marks job CANCELLED
cancellation requested after point-of-no-return is rejected with a clear reason, operation completes
orphan sweep reclaims an object past the age threshold and leaves a too-recent one alone (both cases required)
illegal job-state transition (e.g. PENDING -> COMPLETED directly) is structurally rejected
job state and underlying file_records.upload_state never diverge into an unresolvable combination
```

For each test, the report must capture: scenario, expected behavior per this spec, actual behavior observed, pass/fail, the specific error code or state observed, and — for any failure — the exact state every relevant row and provider object was left in.

---

## 24. Required Report & Machine-Readable Matrix

`PHASE-5-REPORT.md` must include, at minimum, everything Phase 4's report format required (state machine as implemented, schema as implemented, mechanism-by-mechanism detail, full test matrix results with real execution evidence, carried-over-issue status, deviations, known limitations, final recommendation) **plus**:

```text
- Explicit confirmation, with file/line citations, that none of the §0.-1 rules were
  violated anywhere in the delivered code — this must be checkable, not asserted in prose.
- The three crash-point (1%/50%/99%) recovery demonstrations for all four job types,
  each with the specific mechanism used to detect and resolve that crash point.
- Explicit resolution status of every §3 precondition (fixed now, or blocking).
```

`phase-5-test-matrix.json` follows the same shape as Phase 4's (§16.2 of the Phase 4 spec): one entry per test in §23, with `id`, `description`, `expected`, `actual`, `result`, `final_job_state`, `final_file_state`, `error_code_observed`, `notes`.

Given the pattern established across Phases 3 and 4, expect the next step after this report to be an independent, line-by-line audit against the actual code — every claim in this report should be written so it's individually checkable against a specific file and line, exactly as requested for Phase 4 and not fully delivered there.

---

## 25. Required Issue Format

Same as Phases 3 and 4:

```text
Issue ID
Severity
Location
Original behavior
Required behavior
Actual behavior
Impact
Remediation
Verification
Status
```

---

## 26. Acceptance Criteria

Phase 5 is `PASS` only if:

```text
job model implemented for all four job types with the shared envelope (§5)
+
job state machine enforced with no illegal-transition path, verified by a real test
+
upload/migration/delete/archive flows match §7-10 exactly, including the migration
  hard rule (never delete source before destination is verified+committed)
+
retry uses real exponential backoff with jitter, verified numerically
+
resumability demonstrated per job type per §12, not merely described
+
idempotency is real end-to-end (client-generated, DB-unique, race-tested), fixing
  Phase 4's broken version rather than repeating it
+
checksums are actually compared, not just fetched, with a deliberate-mismatch test passing
+
progress tracking reflects real observed progress, not fabricated percentages
+
cancellation is cooperative and safe-checkpointed, both before and after
  point-of-no-return cases demonstrated
+
orphan recovery uses a real age threshold and reports real counts including zero
+
all twelve required 1%/50%/99% crash-recovery demonstrations pass with no data loss,
  no orphans left untracked, and no duplicate physical objects
+
worker leasing prevents double-execution, verified under concurrency
+
every test in §23 is real per §0.-1 rule 3 — a single hardcoded-true entry anywhere
  in the submitted test file is grounds for FAIL regardless of what else passes
+
Phase 1-4 guarantees re-verified intact (RLS, ownership trigger, RESTRICT FKs, vault
  encryption, and the Phase 4 fixes required by §3)
+
lint, typecheck, tests, and production build all pass
```

Otherwise: `FAIL` or `BLOCKED`, with issues logged per §25.

---

## 27. STOP Condition

```text
STOP.
```

Produce `PHASE-5-REPORT.md` and `phase-5-test-matrix.json`. Do not begin Phase 6 planning. Do not add chunking, additional providers, or a general workflow engine. Wait for independent review.

---

## 28. Final Principle

```text
A system that honestly reports "this failed and here is exactly what state it's in"
is more valuable, right now, than one that reports "everything passed."
```

Given the pattern in this project so far, that principle is not rhetorical — it is the literal difference between a report this audit accepts and one it sends back for the third time. Build the failure-handling first, prove it with tests that can actually fail, and let the passing report follow from that — not the other way around.

---

# END OF PHASE 5 — RELIABLE FILE OPERATIONS & BACKGROUND JOBS

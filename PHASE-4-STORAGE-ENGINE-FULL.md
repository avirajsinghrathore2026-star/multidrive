# MultiDrive — Phase 4
# Storage Engine — Capacity, Reservation, Upload, Verification & Recovery

**Document:** `PHASE-4-STORAGE-ENGINE.md`
**Phase:** 4
**Predecessors:** Phase 1 (Security, Identity, Data Isolation), Phase 2 (Secrets, Credentials, OAuth Hardening), Phase 3 (Database Architecture, Integrity & Migrations — No Chunking)
**Decision inherited from Phase 3:** One logical file → one intact physical provider object → one connected Drive account. No chunking.
**Execution model:** Antigravity implements this phase, verifies it against a real database and real (or realistically simulated) provider interactions, produces the required report, and STOPs.

---

## 0.-1. Carried Over From Phase 3 — Read Before Starting

Phase 3's independent audit (`PHASE-3-INDEPENDENT-AUDIT.md`, `PHASE-3-INDEPENDENT-AUDIT-V2.md`) closed most findings but left two open. Neither blocks starting Phase 4, but both must be respected by it:

- **`connected_accounts.google_account_id` is present in the schema but unpopulated and unconstrained** (ISSUE-06, still open). Phase 4's capacity-discovery step (§6) reads from `connected_accounts` — do not silently "fix" this as a side effect of unrelated Phase 4 work; if it needs to be touched, treat it as its own tracked change with its own verification, not a drive-by edit bundled into the storage-engine report.
- **Standing rule for all Phase 4 tests that touch `file_records` / `connected_accounts`:** authenticate as a real test user before asserting on RLS-protected inserts, seed any parent rows the test needs so only the condition under test can fail, and assert on the specific Postgres error code returned — not on whether *an* error was returned. Phase 3's test suite passed tests for the wrong reason twice (RLS firing before the intended constraint, and missing foreign-key rows) before this was caught. Phase 4's concurrency/race tests are more failure-prone than Phase 3's constraint tests were, so this matters more here, not less.

---

## 0. Boundary Recap — READ THIS FIRST

Phase 3 owns *what the data means*. Phase 4 owns *how bytes are actually stored, allocated, uploaded, verified, and recovered*.

Phase 4 MUST preserve every security and integrity guarantee established in Phases 1–3. Nothing in this phase may weaken auth, authorization, account-isolation boundaries, RLS policies, or the `trg_enforce_file_records_ownership` trigger already in place. If Phase 4 work appears to require weakening any of these, STOP and document the conflict rather than silently loosening it.

### 0.1 The contract (spine of this phase)

```text
Requested logical file
        ↓
calculate complete file size
        ↓
find connected account with sufficient capacity
        ↓
reserve / allocate capacity
        ↓
upload intact file
        ↓
verify physical object
        ↓
commit physical mapping
        ↓
mark logical file complete
```

If no single connected Drive can hold the complete file:

```text
reject / defer
```

**No cross-account splitting. No chunking.**

```text
ONE FILE
   ↓
ONE PHYSICAL OBJECT
   ↓
ONE CONNECTED DRIVE
```

A file larger than every individual connected Drive's free capacity is rejected/deferred, even if combined free capacity across all connected accounts would be sufficient. This is intentional and is **not** a Phase 4 optimization target. Do not implement chunking, striping, or multi-account assembly in this phase, even partially, even as "future-proofing."

### 0.2 The hard rule (non-negotiable, governs everything below)

> **Never mark a logical file complete until the physical provider object has been verified AND its mapping has been durably committed.**

Every design decision, every ordering choice, every failure-recovery path in this phase must be checked against this rule before it is accepted. If a proposed optimization would let "complete" be set before both conditions hold, reject the optimization.

---

## 1. Phase 4 Mission

Phase 4 has four primary goals:

1. Turn the "find a Drive with room and upload the file" idea from Phase 3's prose into a concrete, race-safe, crash-safe mechanism.
2. Make partial/interrupted uploads a first-class, tested condition — not an unhandled edge case.
3. Guarantee that "complete" in the database always means "verifiably present and correctly mapped on the provider," never "we think it probably worked."
4. Leave a clean seam for a future chunking phase without building any chunking infrastructure now (mirrors Phase 3's non-chunking discipline).

---

## 2. Scope

### IN SCOPE

```text
capacity discovery (fresh vs. cached, staleness rules)
capacity selection algorithm
reservation / allocation (lease model, TTL)
reservation reconciliation sweep
idempotency key design and enforcement
upload orchestration against the provider
provider auth/token-expiry handling mid-upload
provider rate-limit / backoff handling
partial-upload detection and handling
physical-object verification (integrity + completeness)
database/provider commit ordering
orphan physical-object detection and sweep
concurrency and race handling (reservations, duplicate requests)
logical file state machine (formal, enforced)
schema additions required to support the above (reservations, idempotency keys, state columns)
error surfacing to the API/UI layer
observability/logging needed to diagnose the failure matrix in §14
required test matrix execution against a real or realistically simulated provider
```

### OUT OF SCOPE

Do NOT implement:

```text
file chunking
file_chunks table or any chunk-shaped metadata
cross-account splitting of a single file
multi-object logical files
rebalancing / moving already-stored files between accounts
provider abstraction beyond what's needed for Google Drive today (no speculative multi-provider interface)
UI/UX changes beyond what's needed to surface new error states
```

Rebalancing in particular: Phase 3's audit already found a `/api/files/rebalance` endpoint in the codebase that is analysis-only (it never moves anything). Phase 4 must not turn this into a real mover. If real rebalancing becomes a requirement, it is its own phase.

---

## 3. Preconditions

Before writing any code:

```text
[ ] Phase 1/2/3 final state understood, including both audit reports and the V2 remediation
[ ] Confirm trg_enforce_file_records_ownership is present and active in the target database
[ ] Confirm file_records.connected_account_id is ON DELETE RESTRICT (Phase 3 ISSUE-04)
[ ] Confirm current column names: virtual_folder_id, in_trash, uploaded_at (not folder_id/status)
[ ] Inventory every existing route that inserts/updates file_records (upload, batch, files/[id]) — Phase 4 must not bypass ownership/RLS guarantees those routes currently provide
[ ] Identify the actual Google Drive upload API in use (resumable upload vs. simple upload) in src/lib/google-drive.ts
[ ] Identify how storage_used_bytes / storage_total_bytes are currently refreshed (post-upload async refresh in upload/route.ts) and whether that's sufficient or needs to move earlier
```

If the actual repository materially contradicts anything assumed in this document:

```text
STOP
document the contradiction
do not silently invent a third architecture
```

---

## 4. Source of Truth

Use these sources in order, same discipline as Phase 3:

1. Actual repository (`src/`, `supabase/`)
2. Actual current database schema (introspected, not assumed from a prior `.md`)
3. Existing migrations
4. Phase 3 V2 report and both independent audits
5. This Phase 4 specification
6. Original rebuild plan, if one still exists

Given Phase 3's central finding was "the schema doc didn't match the app," Phase 4 must not repeat that mistake in the other direction — do not write new schema DDL from this document's prose without first confirming it against the actual current `schema.sql` and a live introspection of the database.

---

## 5. Logical File State Machine

This is the backbone of the whole phase. It must be implemented as an explicit, enforced state machine — not a set of independently-settable booleans or a free-text status string.

```text
PENDING
   ↓ (capacity found)
RESERVED
   ↓ (upload begins)
UPLOADING
   ↓ (provider ack: bytes fully received)
UPLOADED
   ↓ (checksum/size verified against provider metadata)
VERIFIED
   ↓ (mapping row durably committed)
COMMITTED
   ↓ (final flag flip)
COMPLETE

Terminal failure states: REJECTED, FAILED, ORPHANED
```

### 5.1 Rules

- **Illegal transitions must be structurally impossible**, not just avoided by convention. There must be no code path — and ideally a database-level guard (check constraint, trigger, or state-transition table) — that can set a file to `COMPLETE` from any state other than `COMMITTED`.
- **`RESERVED` carries a TTL.** If upload does not reach `UPLOADED` before the TTL expires, the reservation is released and the row moves to `FAILED` (retryable) or `REJECTED` (no other candidate account exists).
- **Every transition is atomic with the data that justifies it.** You cannot mark `VERIFIED` without the verification result (checksum, size, provider response) being persisted in the same write. You cannot mark `UPLOADED` without the provider's file ID being recorded.
- **Every transition is attributable**: timestamp + actor/process identifier, so the machine-readable test matrix and any later incident review can reconstruct exactly what happened to a given file.
- **Where does existing `in_trash` fit?** `in_trash` is a separate, orthogonal lifecycle axis (user-initiated soft delete) from this upload state machine. Do not conflate them. A file can only meaningfully be trashed once it has reached `COMPLETE`; define and document what happens if a trash request arrives while a file is still `UPLOADING`/`RESERVED` (recommendation: reject the trash request until the upload reaches a terminal state, rather than trying to cancel mid-flight).

### 5.2 Suggested schema representation

Antigravity should verify this against the real schema before implementing, per §4, but a reasonable shape is:

```text
file_records.upload_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (upload_state IN ('pending','reserved','uploading','uploaded','verified','committed','complete','failed','rejected','orphaned'))

file_records.upload_state_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Do not reuse `in_trash` or repurpose `uploaded_at` for this — `uploaded_at` currently means "when the row was created," per the existing upload route, and changing its meaning would reopen a Phase 3-style mismatch between schema intent and code usage.

---

## 6. Capacity Discovery & Selection

### 6.1 Discovery

- Enumerate the requesting user's connected accounts (`connected_accounts` filtered by `user_id`, exactly as `upload/route.ts` already does).
- Distinguish **cached/last-known capacity** (`storage_used_bytes`/`storage_total_bytes`, refreshed asynchronously today, per the existing post-upload `fetchGoogleAccountDetails` call) from **freshly-queried capacity**.
- Define an explicit staleness window (e.g., "cached capacity older than N minutes is considered stale for selection purposes"). Antigravity must pick a concrete number and document the reasoning, not leave it implicit.
- When selected capacity is stale beyond the window, require a fresh provider quota check before committing to a reservation on that account.

### 6.2 Selection

- Selection must pick a single candidate account whose available capacity (fresh or within the staleness window) is `>=` the complete file size, computed **before** any transfer begins — never start a stream before knowing the true final size.
- Existing behavior ("most free space wins", per the current upload route) is a reasonable default selection strategy; Phase 4 should keep it unless there's a concrete reason to change it, but the selection logic must now run against the reservation system in §7, not directly against the live `storage_used_bytes` column with no locking.
- If no single account can hold the file → `REJECTED`/`DEFERRED`. Do not attempt partial placement, and do not silently pick the largest available account and let the provider upload fail instead — the check must happen before upload starts.

---

## 7. Reservation / Allocation

### 7.1 Concept

A reservation is a **lease**: an amount of capacity, held against a specific `connected_account_id`, owned by a specific logical file / request, with an expiry.

### 7.2 Suggested schema

```text
CREATE TABLE storage_reservations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_record_id UUID NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  connected_account_id UUID NOT NULL REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ
);
```

(Antigravity should validate this against real naming conventions in the repo — e.g. whether other tables use `_id` suffixes the same way — before creating it.)

### 7.3 Rules

- Reservation and the write that changes the file's state to `RESERVED` must happen atomically (single transaction).
- Reservation against a given account must be **serialized against other concurrent reservations for the same account** — see §11 for the concurrency mechanism. A naive "read free space, then write reservation" without a lock or atomic check is not acceptable; it is exactly the reservation race the test matrix requires covering.
- Reservation is **idempotent under retry**: a duplicate reservation request carrying the same idempotency key (§9) for the same logical file must not create a second reservation or double-count capacity.
- **Expired reservations must be reclaimed by a background reconciliation sweep**, not only lazily on next read. A crashed upload process must not leak capacity forever.
- When computing "available capacity" for selection (§6.2), subtract the sum of active (non-expired, non-released) reservations from the cached/fresh free-space figure.

---

## 8. Reservation Reconciliation Sweep

- A standing background process (cron job, scheduled function, or equivalent — match whatever job-scheduling mechanism already exists in the stack, or document that none exists and one must be added) that:
  1. Finds reservations past `expires_at` with `released_at IS NULL`.
  2. Checks the associated `file_records.upload_state`. If it never progressed past `RESERVED`/`UPLOADING`, release the reservation and move the file to `FAILED` (or `REJECTED` if this was the only viable account).
  3. Logs every reclaim with enough detail to appear in the test matrix (§14) for "crashed upload process" and "retry after unknown outcome."
- This sweep is a required mechanism, not merely a test scenario — it must exist in the running system, not just be simulated in a test.

---

## 9. Idempotency Keys

- Every upload request must carry (or be assigned, server-side, on first receipt) an idempotency key derived from the logical file id or the original client request id.
- The key must be persisted alongside the reservation/file row and checked on every retry: if an upload request arrives with a key that already has an in-progress or completed reservation, do not create a new reservation or start a new provider upload — return the existing outcome (or current in-progress status) instead.
- This is what makes "duplicate upload requests" and "retry after unknown outcome" (both required tests, §14) solvable by design rather than by hoping the client behaves.

---

## 10. Upload Orchestration

- Convert the file-size-then-upload sequence into one that never begins a provider transfer before capacity is reserved (§7) and the idempotency key is checked (§9).
- Handle explicitly, as named branches in the code — not folded into a single generic `catch`:
  - **Provider auth/token expiry mid-upload.** Detect the specific auth-failure response from the provider, attempt a token refresh (Phase 2's vault/refresh-token handling should already support this), and resume or retry the upload — do not simply fail the whole upload and force a full restart if the provider supports resuming.
  - **Provider rate-limiting / backoff signals.** Respect `Retry-After`/quota-exceeded responses with real backoff, not a fixed short retry loop that hammers the API.
  - **Connection loss / timeout with unknown outcome.** The request may have succeeded on the provider's side even though the client never received a response. On reconnect, **check provider state before retrying** (e.g., does an object with this idempotency-derived identifier already exist at the target location?) rather than blindly re-uploading and creating a duplicate physical object.
- Do not transition the file past `UPLOADED` until the provider has acknowledged the **entire** object was received — a partial-upload acknowledgment is never treated as done, regardless of how close to complete the transferred byte count is.
- If the current Drive integration (`src/lib/google-drive.ts`) uses simple (non-resumable) upload, evaluate whether Google's resumable upload API is warranted here specifically because it makes several of the required tests (partial upload, disconnect during upload, retry after unknown outcome) solvable in a principled way rather than by full-restart. If Antigravity concludes simple upload is retained for now, document why, and make sure the "unknown outcome" check in the previous bullet is implemented regardless.

---

## 11. Concurrency & Race Handling

- **Reservation races** (two requests competing for the same account's capacity): use an atomic compare-and-reserve pattern — e.g., a single `UPDATE ... WHERE available_computed >= needed RETURNING ...`-style statement, a `SELECT ... FOR UPDATE` row lock on the account during reservation, or a Postgres advisory lock keyed on the account id. A read-then-write pattern with no lock in between is not acceptable.
- **Two users/accounts competing for capacity**: each user's reservations only ever touch their own `connected_accounts` rows (already enforced by RLS + the Phase 3 ownership trigger), so true cross-user capacity races shouldn't occur through normal use — but the test matrix must still prove this holds under concurrent load, since RLS assumptions have been wrong before in this project (see Phase 3 audit's RLS-related test findings).
- **Duplicate upload attempts for the same logical file** (double-submit, or a client retry racing the original in-flight request): must collapse to a single outcome via the idempotency key (§9), never producing two physical objects or two mapping rows for one logical file.

---

## 12. Physical-Object Verification

- Verification must confirm both:
  - **Integrity** — checksum/hash match between what was sent and what the provider reports stored (Google Drive exposes an MD5 checksum on file metadata; use it).
  - **Completeness** — size match against the provider's own reported metadata for the object, not just against what the client believes it sent.
- A verification mismatch is a hard failure: the logical file does not progress past `UPLOADED`, and the physical object is flagged for the orphan sweep (§13) rather than silently retried in place or accepted anyway.
- Verification must happen as a dedicated step with its own state transition and its own log entry — do not fold it into "upload succeeded" as an assumption.

---

## 13. Commit Ordering & Orphan Handling

### 13.1 Ordering

Per the hard rule in §0.2, the only acceptable order is:

```text
verify → commit mapping durably → mark complete
```

No reordering shortcuts for latency. If verification is deemed "usually fine to skip for small files" or similar, reject that reasoning explicitly in the report rather than silently omitting the step for some size threshold.

### 13.2 Two failure directions, both must be handled by name

- **Provider succeeded, DB commit failed:** the physical object now exists but is unmapped in the database. This must be detectable — log the provider's returned file id even if the subsequent DB write fails — and either (a) retried so the mapping gets committed for the object that's already there (using the idempotency key to avoid re-uploading), or (b) reclaimed as an orphan if retried past a bounded number of attempts.
- **DB says committed but the provider object is actually missing/corrupted:** given the ordering above, this should be structurally impossible. If the orphan sweep or a verification test ever finds this state, treat it as a critical bug in the ordering guarantee itself, not a routine retry — surface it prominently in the report (§17), not buried in the test matrix as a routine "fail, remediated."

### 13.3 Orphan sweep

- A standing background process (can share scheduling infrastructure with §8's reservation sweep) that periodically compares provider-side objects reachable via each connected account against `file_records` rows with `upload_state = 'committed'`/`'complete'` referencing that account, and flags/reclaims objects with no corresponding row past a grace period.
- This is a required running mechanism, not only a test scenario.

---

## 14. Required Test Matrix

Every scenario below must have an automated test, and every test's outcome must appear in the machine-readable test matrix (§16). Tests must follow the standing rule in §0.-1: authenticate as a real test user, seed whatever parent rows the scenario needs, and assert on the specific error/state produced — not merely on "an error occurred."

```text
reservation races (concurrent requests for the same account's last-available capacity)
upload timeout after provider success (client times out; provider actually received the full file)
provider success + DB failure (mapping commit fails after a successful provider upload)
DB success + provider failure (should be structurally prevented by ordering — test that it is)
duplicate upload requests (same idempotency key, concurrent or sequential)
two users/accounts competing for capacity (cross-user isolation under concurrent load)
stale capacity information (selection using capacity data older than the staleness window)
provider quota changes during upload (account's real quota drops mid-transfer, e.g. another process also uploading)
partial provider upload (connection drops after some bytes, before provider acknowledges completion)
remote object verification mismatch (checksum or size disagrees with provider metadata)
orphan physical objects (provider object exists with no committed mapping; sweep reclaims it)
crashed upload process (process dies mid-upload; reservation TTL expiry and reconciliation sweep recover it)
retry after unknown outcome (client retries after a timeout; engine checks provider state before re-uploading)
disconnect during upload (network disconnects; upload_state reflects the interruption correctly, not silently as UPLOADED)
reservation TTL expiry and reclamation (independent of a crash — simple timeout)
idempotency key collision handling (second request with same key while first is still in flight)
illegal state transition is structurally rejected (attempt to set COMPLETE without passing through COMMITTED)
file larger than every connected account's capacity is rejected/deferred, not chunked or force-fit
account disconnect mid-reservation (Phase 3's ON DELETE RESTRICT should prevent disconnect while files exist — confirm this also holds for accounts with only in-flight reservations, not just committed files)
```

For each test, the report must capture: scenario, expected behavior per this spec, actual behavior observed, pass/fail, the specific error code/state observed, and — for any failure — the state the logical file and physical object were left in.

---

## 15. Observability Requirements

- Every state transition (§5) must be logged with: file id, previous state, new state, actor/process id, timestamp, and — where relevant — the provider's response identifiers (file id, checksum).
- Reservation creation, expiry, and release must be logged distinctly from upload-state transitions, so the reconciliation sweep's behavior can be audited independently of upload orchestration.
- Failures must log enough detail to distinguish the failure categories in §14 from each other after the fact — a generic "upload failed" log line is not sufficient to diagnose which of the ~18 scenarios occurred.

---

## 16. Required Report & Machine-Readable Matrix

### 16.1 `PHASE-4-REPORT.md`

Following the same rigor as the Phase 3 reports (and learning from where those fell short — see §0.-1), the report must include, at minimum:

```text
1. Final status (PASS / FAIL / BLOCKED)
2. Executive summary
3. State machine as actually implemented (with any deviations from §5 explicitly called out)
4. Capacity discovery & selection implementation details
5. Reservation model — schema, TTL value chosen, and reasoning
6. Reconciliation sweep — how it's scheduled, how often it runs
7. Idempotency key design as implemented
8. Upload orchestration — provider API used (simple vs. resumable), and why
9. Verification implementation (checksum mechanism used)
10. Commit ordering — code-level proof that verify → commit → complete is enforced
11. Orphan sweep — how it's scheduled, what grace period it uses
12. Concurrency mechanism used (row lock / advisory lock / atomic update) — cite the actual SQL/code
13. Full test matrix results (§14), each with real execution evidence, not narrative claims
14. Observability — what got logged, with example log lines
15. Carried-over Phase 3 items (§0.-1) — status of each, not silently dropped
16. Deviations from this specification
17. Remaining issues / known limitations
18. Deferred features (explicitly confirm chunking, rebalancing, multi-provider support remain deferred)
19. Final recommendation
```

### 16.2 Machine-readable test matrix

`phase-4-test-matrix.json`, one entry per test in §14:

```json
{
  "phase": 4,
  "tests": [
    {
      "id": "reservation-races",
      "description": "...",
      "expected": "...",
      "actual": "...",
      "result": "pass | fail",
      "final_logical_state": "...",
      "final_physical_state": "...",
      "error_code_observed": "...",
      "notes": "..."
    }
  ]
}
```

This is what gets independently audited — not the prose summary alone. Given the pattern from Phase 3's audits, expect the next step after this report to be a line-by-line comparison between what this file claims and what the actual code/test files do — write the report accordingly, i.e., make claims that are each individually checkable against a specific file and line.

---

## 17. Required Issue Format

For any finding Antigravity surfaces during its own self-verification, use the same format the Phase 3 audits used, so issues are trackable the same way ISSUE-01 through ISSUE-06 were:

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

Include issues that were found and fixed during implementation, not only ones left open.

---

## 18. Acceptance Criteria

Phase 4 is `PASS` only if:

```text
state machine is enforced with no illegal-transition path
+
capacity discovery/selection correctly respects staleness rules
+
reservation is atomic and race-safe under concurrent load (demonstrated, not asserted)
+
reconciliation sweep is a real running mechanism, not a stub
+
idempotency key prevents duplicate physical objects under retry/double-submit
+
upload orchestration handles auth expiry, rate-limiting, and unknown-outcome retries explicitly
+
verification checks both integrity and completeness against provider metadata
+
commit ordering matches §0.2's hard rule, demonstrated via a targeted test, not just code review
+
orphan sweep is a real running mechanism
+
every test in §14 has a real, non-tautological automated test (per the §0.-1 standing rule)
+
Phase 1/2/3 guarantees (RLS, ownership trigger, ON DELETE RESTRICT, vault encryption) remain intact and are reverified, not assumed
+
lint passes
+
typecheck passes
+
tests pass
+
production build passes
```

Otherwise: `FAIL` or `BLOCKED`, with issues logged per §17.

---

## 19. STOP Condition

After Phase 4:

```text
STOP.
```

Do not start Phase 5 planning. Do not implement chunking, multi-provider abstraction, or real rebalancing. Produce `PHASE-4-REPORT.md` and `phase-4-test-matrix.json`, and wait for independent review.

---

## 20. Final Principle

Optimize for:

```text
correctness under failure
race safety
recoverability
observability
```

over raw upload throughput. A slower storage engine that never loses track of a file is the right tradeoff at this stage; a fast one that occasionally produces an orphaned object or a file stuck forever in `UPLOADING` is not acceptable, and is exactly what the test matrix in §14 exists to catch before it reaches production.

**Do not build complexity before the product needs it — but do not skip the failure-mode work this document asks for, since that work is the actual point of this phase, not an add-on to it.**

---

# END OF PHASE 4 — STORAGE ENGINE

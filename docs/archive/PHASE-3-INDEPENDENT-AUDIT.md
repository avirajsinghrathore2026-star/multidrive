# PHASE 3 — INDEPENDENT AUDIT

**Audited artifact:** `multidrive-phase3-codebase.zip`
**Audited against:** `PHASE-3-DATABASE-ARCHITECTURE-NO-CHUNKING.md` (spec) and `PHASE-3-REPORT.md` (self-report, claims **PASS**)
**Method:** Direct inspection of `supabase/schema.sql`, `supabase/migrations/*.sql`, all `src/app/api/**` route handlers, `src/lib/auth.ts`, `src/lib/vault.ts`, and `tests/security.test.ts`. Every claim below is traceable to a specific file and line.

## Verdict

> **FAIL.** The self-reported `PASS` is not supportable. The delivered schema does not match the application that runs against it, and the "12/12 assertions" cited as verification do not touch a database. This is not a matter of missing polish — it means Phase 3's central deliverable (a coherent, reproducible database) was never actually reconciled with the real application, and the verification step that should have caught this did not run.

Per the spec's own acceptance criteria (§75), Phase 3 requires the database model to be coherent **and** the fresh/existing-database migrations to actually reproduce a working schema. Finding #1 alone breaks both.

---

## Critical Findings

### ISSUE-01 — Delivered schema does not match the application (multiple independent mismatches)
- **Severity:** Critical
- **Location:** `supabase/schema.sql`, `supabase/migrations/phase3_database_architecture.sql` vs. `src/app/api/files/*`, `src/app/api/folders/route.ts`, `src/components/*`
- **Required behavior:** Spec §67–68 require the schema to be verified reproducible by actually running it (fresh bootstrap and upgrade-from-Phase-2), and §5 requires the *actual repository* to be the primary source of truth over the written spec.
- **Actual behavior:** Three separate column-naming schemes coexist across the codebase, and the "final" schema matches none of them consistently:

  | Concept | `schema.sql` says | Application code actually uses |
  |---|---|---|
  | File's folder reference | `file_records.folder_id` | `virtual_folder_id` (upload, files, files/[id], batch routes) |
  | Folder's parent | `virtual_folders.parent_id` | `parent_folder_id` (folders route) |
  | Upload timestamp | `created_at` (no `uploaded_at` column exists) | `uploaded_at` (inserted in upload route; queried/sorted by it in files, analytics, and UI) |
  | Trash/lifecycle state | `status IN ('active','trashed')` + `trashed_at` | `in_trash` boolean (files, analytics, duplicates, rebalance, batch, RecyclingBin, FileBrowser — 8+ call sites) |

- **Impact:** If `schema.sql` were actually run and the application deployed against it, every file list, upload, folder move, trash/restore, analytics, and duplicate-detection call would fail with a "column does not exist" error. Since the application clearly *works* against `in_trash`/`virtual_folder_id`/`uploaded_at` in dozens of call sites (not a typo in one file), the far more likely explanation is that `schema.sql` was written to match the Phase 3 *specification's* prose, not the real production schema — i.e., the source-of-truth ordering in spec §5 was inverted in practice.
- **Remediation:** Re-derive `schema.sql` and the migration from the *actual* production schema (introspect the live database, not the spec document), or update the application to match a genuinely new schema — but either way, the two must be reconciled and that reconciliation must be demonstrated, not asserted.
- **Verification:** Run `schema.sql` against a clean Postgres instance, then run the actual Next.js route handlers (upload, list, move, trash, restore, rebalance) against it end-to-end. All must succeed with zero column errors.
- **Status:** Open.

### ISSUE-02 — The verification suite does not touch a database
- **Severity:** Critical
- **Location:** `tests/security.test.ts` (this is the entirety of `npm test`, per `package.json`)
- **Required behavior:** Spec §66 (migration failure testing against synthetic invalid data), §67 (fresh bootstrap on two clean databases, compare schema), §68 (existing-DB upgrade test), §27 ("Database integrity tests") — all imply exercising a real database.
- **Actual behavior:** Every "Phase 3" assertion in the suite is a tautological JavaScript comparison on hardcoded literals, with no Supabase/Postgres call involved:
  - Test 3.1 ("NULL owner rejected"): `mockUnownedFile.user_id === null` — this checks that a JS variable you just set to `null` is `null`. It never inserts anything into a database or exercises the `NOT NULL` constraint.
  - Test 3.2 ("Negative size rejected"): `-1024 < 0` — checks arithmetic, not the `CHECK` constraint.
  - Test 3.4 ("Folder same-user validation"): compares two hardcoded different UUID strings for inequality. It never calls `requireOwnedFolder()`, never touches `virtual_folders`.
  - Test 3.5 ("Duplicate token rejected"): compares the string `'share-token-unique-001'` to itself — always true, and does not invoke the `UNIQUE` constraint on `shared_links.token`.
- **Impact:** The report's headline evidence — "Automated test suite passed 12/12 assertions" — cannot support any of the database-integrity claims it's cited for (§27, §29, §37 Q1–7). These tests would pass identically whether or not the constraints existed at all, and would pass identically against the mismatched schema in ISSUE-01. No fresh-bootstrap comparison, upgrade-path test, or synthetic invalid-data test (spec §66–69) appears to have actually been run against Postgres.
- **Remediation:** Replace with tests that instantiate a real (or ephemeral/test-container) Postgres instance, run `schema.sql`, and attempt the actual invalid operations (insert NULL user_id, insert negative size, insert duplicate token, insert cross-user folder reference) and assert on the database's rejection — not on a pre-computed boolean.
- **Status:** Open.

---

## High-Severity Findings

### ISSUE-03 — Cross-user referential integrity is application-only, contrary to spec's explicit warning
- **Severity:** High
- **Location:** `src/lib/auth.ts` (`requireOwnedFolder`, `requireOwnedAccount`) vs. `supabase/schema.sql`
- **Required behavior:** Spec §10 ("Do not replace database security with application-only checks") and §20 ("A basic FK only proves that the folder exists. It does not prove that the folder belongs to the same user... explicitly verify the integrity mechanism") both anticipate this exact gap and require it closed at the database level.
- **Actual behavior:** `file_records.folder_id`/`virtual_folder_id` and `connected_account_id` are plain foreign keys with no composite constraint, trigger, or RLS-equivalent mechanism tying the referenced row's `user_id` to the file's own `user_id`. The only protection is that specific route handlers happen to call `requireOwnedFolder()`/`requireOwnedFile()` before writing. Standard Postgres FK checks do not enforce RLS visibility on the referenced table, so this is a genuine, not merely theoretical, gap.
- **Compounding detail:** `requireOwnedAccount()` is defined but **never called anywhere in the codebase** (confirmed by repo-wide search). Ownership of `connected_account_id` is currently correct only incidentally — because the one route that sets it (`upload/route.ts`) selects the account from a query already filtered by `user_id`. Any future code path that accepts a client-supplied account ID would have no ownership check available to call, despite the report (§37 Q4) asserting this is enforced.
- **Impact:** A missed check in any future route, or an error in the one existing check, would let a request attach another user's folder or Drive account to a file, with no database-level backstop.
- **Remediation:** Add a database-level mechanism — e.g., a `BEFORE INSERT/UPDATE` trigger on `file_records` that verifies `folder_id`'s `user_id` and `connected_account_id`'s `user_id` both equal `NEW.user_id`, or a `SECURITY DEFINER` function used in a `CHECK`. This turns the invariant into something that fails closed regardless of application code.
- **Status:** Open.

### ISSUE-04 — Disconnecting a Drive account silently deletes logical file records
- **Severity:** High
- **Location:** `supabase/schema.sql` line 33 — `file_records.connected_account_id ... ON DELETE CASCADE`
- **Required behavior:** Spec §32, verbatim: *"Determine what happens when a connected Drive account is disconnected... what happens to files stored on that account? must be explicitly documented. **Do not silently delete logical file records.**"*
- **Actual behavior:** The schema uses `ON DELETE CASCADE`, so removing a row from `connected_accounts` cascades to delete every `file_records` row that pointed to it — which in turn cascades again to delete any `shared_links` for those files. `PHASE-3-REPORT.md` §10 describes this as removing records "cleanly," and §35 claims "None. All Phase 3 requirements were satisfied" — but §32 asked for this decision to be explicitly reasoned about and documented as a tradeoff (e.g., `RESTRICT` to block disconnect while files exist, or an orphaned/soft-disconnected state that preserves metadata), not silently applied via cascade with no discussion of data loss.
- **Impact:** A user disconnecting a Drive account — a normal, expected action, not an edge case — permanently and silently erases the metadata for every file that was stored there, including breaking any active public share links for those files, with no warning surfaced anywhere in the reviewed code.
- **Remediation:** Either (a) block disconnect while active file records reference the account (`RESTRICT`, surfaced as a user-facing error), or (b) mark affected files with an explicit "source disconnected" status instead of deleting the row, and document the chosen behavior explicitly per §32.
- **Status:** Open.

---

## Medium-Severity Findings

### ISSUE-05 — `file_records.status` / `in_trash` and rebalance-route field mismatch reveal an out-of-scope feature was shipped against a nonexistent column
- **Severity:** Medium
- **Location:** `src/app/api/files/rebalance/route.ts`
- **Detail:** Spec §4 explicitly lists "rebalancing" and "storage allocator" as **out of scope** for Phase 3. A `/api/files/rebalance` endpoint nonetheless exists in the delivered code, and it queries `file_records.in_trash` — the same column referenced by six other routes/components but absent from `schema.sql`. Whether or not this route predates Phase 3, its presence and its dependence on an undocumented column should have been surfaced in §30 (legacy/out-of-scope code audit) or §35 (deviations); it was not mentioned at all.
- **Impact:** Reinforces ISSUE-01 (this is now the *third* independent piece of evidence that the real schema uses `in_trash`, not `status`/`trashed_at`) and indicates the schema inventory in the report (§6–7) was not actually built from the real repository as §5 required.
- **Remediation:** Fold into the ISSUE-01 remediation; additionally, explicitly decide whether the rebalance endpoint is in-scope debt to flag for Phase 4/5 or dead code to remove.
- **Status:** Open.

### ISSUE-06 — Provider-account uniqueness keyed on email, not stable provider ID
- **Severity:** Medium
- **Location:** `supabase/schema.sql` line 17 — `UNIQUE(user_id, google_email)`
- **Required behavior:** Spec §18: *"Where the provider exposes a stable account ID, use it for uniqueness rather than relying solely on email."*
- **Actual behavior:** Uniqueness is enforced on `(user_id, google_email)`. Google accounts have a stable subject/account ID independent of email (emails can be changed on the Google side); scoping only per-`user_id` also does nothing to prevent two different MultiDrive users from each independently connecting the same underlying Google Drive account, which would let both users' quota/capacity tracking and uploads target the same physical storage without either being aware of the other.
- **Remediation:** Store and uniquely key on Google's stable account identifier (e.g., the OAuth `sub`/account ID from the token), in addition to or instead of email.
- **Status:** Open.

---

## Answers to the Spec's Mandatory Security Questions (§74), Independently Re-Verified

| # | Question | Report's answer | Audit finding |
|---|---|---|---|
| 2 | Can a file reference another user's folder? | NO — "validated by `requireOwnedFolder()`" | **Contradicted.** True only where every call site remembers to call it (currently true, but see ISSUE-03 — no DB-level backstop). |
| 3 | Can a file reference another user's connected account? | NO — "validated by `requireOwnedAccount()`" | **False as stated.** `requireOwnedAccount()` is never called anywhere in the codebase. Correct only incidentally, by construction, in the single route that sets this field (see ISSUE-03). |
| 4 | Can a physical object reference another user's account? | NO | Same caveat as above — true today, not structurally guaranteed. |
| 10 | Can a clean database reproduce the schema? | YES | **Contradicted by ISSUE-01** — it reproduces *a* schema, but not the one the application actually queries. |
| 11 | Can a Phase 2 database upgrade safely? | YES | Not demonstrated — no evidence an actual upgrade was executed against a database (see ISSUE-02); the migration itself doesn't touch the mismatched columns in ISSUE-01, so an "upgrade" would preserve the mismatch, not fix it. |

All other answers in §37 are consistent with the code as far as this audit could verify (NOT NULL ownership, RLS presence, non-negative CHECK constraints, and vault encryption format are all real and correctly implemented).

---

## What Was Actually Solid

To be specific about what passed independent review, not just what failed:
- RLS is genuinely enabled on all four tables with correct `auth.uid() = user_id` policies, and Phase 1's remediation migration correctly tightened this from an earlier `OR user_id IS NULL` policy.
- The vault encryption/decryption round-trip (`src/lib/vault.ts`) is implemented correctly: versioned AES-256-GCM, fails closed on tampering, doesn't leak internals on error.
- `NOT NULL` and non-negative `CHECK` constraints for the columns they were added to are real DDL, not just claimed.
- The legacy `file_chunks` table removal (`DROP TABLE IF EXISTS file_chunks CASCADE`) is real and the report's grep-based dead-code check for it is one of the few verification steps in the report that's actually meaningful as described.

---

## Recommendation

Do not proceed to Phase 4 on top of this codebase as-is. Phase 4's storage engine will read and write `file_records`/`connected_accounts` extensively — building it against a schema that doesn't match the application's actual columns (ISSUE-01) would compound the problem rather than surface it. Recommend:

1. Send ISSUE-01 through ISSUE-04 back for remediation before Phase 4 begins.
2. Require the next report to include actual database execution logs (not narrative claims) for the fresh-bootstrap and upgrade tests specifically.
3. Replace `tests/security.test.ts`'s Phase 3 section with tests that exercise a real database, or explicitly relabel it as a documentation/spec-check rather than a database-integrity test.

# MultiDrive — Phase 1 Verification & Remediation Specification

## Independent Security Verification Pass

**Document:** `PHASE-1-VERIFICATION-REMEDIATION.md`  
**Target:** Antigravity coding agent  
**Phase:** 1 — Verification / Remediation  
**Status:** BLOCKING GATE BEFORE PHASE 2

---

# 1. Mission

The first Phase 1 implementation has been reviewed independently.

The implementation appears to have made substantial security improvements, but its report makes stronger claims than the evidence currently demonstrates.

Therefore:

> **DO NOT proceed to Phase 2.**

This pass is specifically for:

1. verifying the claims made in `PHASE-1-REPORT.md`
2. identifying gaps between the implementation and the Phase 1 specification
3. fixing any confirmed security or verification deficiencies
4. adding meaningful integration/database/OAuth security tests
5. producing a second, evidence-based report

This is **not** a request to rebuild Phase 1 from scratch.

Preserve correct work.

Do not introduce unrelated Phase 2 architecture.

---

# 2. Independent review verdict

The independent review currently considers Phase 1:

```text
CONDITIONAL PASS — NOT APPROVED FOR PHASE 2
```

The main concern is insufficient evidence, plus several areas requiring implementation-level verification.

The following areas are blocking until demonstrated:

1. NULL-owner data deletion safety
2. complete database/table/RLS inventory
3. complete API route/method authorization inventory
4. actual RLS isolation tests
5. actual HTTP/API cross-user isolation tests
6. service-role usage audit
7. OAuth single-use/replay protection
8. concurrent OAuth-flow behavior
9. execution of manual security verification
10. broader security test coverage

---

# 3. Critical rule

Do not convert an unverified claim into a PASS.

For every security requirement, distinguish:

```text
IMPLEMENTED
TESTED
VERIFIED
NOT VERIFIED
BLOCKED
```

For example:

```text
requireOwnedFile() exists
```

does NOT automatically prove:

```text
GET /api/files/:id
```

is secure.

Likewise:

```text
RLS policy exists
```

does NOT automatically prove:

```text
User A cannot access User B's rows
```

unless that behavior is actually tested.

---

# 4. Files you MUST inspect first

Before changing anything, inspect the current repository versions of at least:

```text
src/lib/auth.ts
supabase/schema.sql
supabase/migrations/phase1_remediation.sql
src/app/api/auth/google/connect/route.ts
src/app/api/auth/google/callback/route.ts
src/app/api/share/[token]/route.ts
tests/security.test.ts
```

Also inspect every file identified by the previous Phase 1 report as changed.

Then perform repository-wide searches for:

```text
SUPABASE_SERVICE_ROLE_KEY
service_role
createClient
supabase
auth.getUser
user_id
requireUser
requireOwned
google oauth
state
code_verifier
```

Do not assume the previous report's file list is exhaustive.

---

# 5. P0 — NULL-owner data deletion verification

## 5.1 Problem

The previous report states that existing NULL-owner prototype/test records were purged.

It identified:

- 1 connected account
- 1 folder
- 2 video files

with `user_id = NULL`.

The report classified these as prototype/test data.

This classification must now be independently demonstrated.

## 5.2 Required investigation

For every deleted NULL-owner record, establish:

```text
table
record identifier
record type
why it was classified as test/prototype
whether it referenced physical Google Drive data
whether it represented a real user account
whether deletion was reversible
```

Do not invent ownership.

Do not silently delete potentially real user data.

## 5.3 Required report table

Produce:

| Table | Record | Classification evidence | Physical external data? | Safe to delete? | Evidence |
|---|---|---|---|---|---|

## 5.4 If classification cannot be proven

If the evidence is insufficient:

> STOP the destructive migration approach.

Design a safe migration strategy and report:

```text
BLOCKED — HUMAN DECISION REQUIRED
```

Do not assign the row to an arbitrary user.

---

# 6. P0 — Complete database inventory

Create a complete inventory of the current database schema.

Do not limit the inventory to the tables changed during Phase 1.

For every table, document:

| Table | User-owned? | Owner field | Nullable? | FK? | RLS enabled? | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|---|---|---|---|

At minimum inspect:

```text
connected_accounts
file_records
file_chunks
virtual_folders
shared_links
```

and every other table discovered.

## 6.1 Ownership classification

Every table must be classified as one of:

```text
PUBLIC
USER-OWNED
SYSTEM
PRIVILEGED
JUNCTION/DEPENDENT
```

Explain the choice.

## 6.2 User-owned tables

For every user-owned table:

```text
owner must be explicit
owner must be non-null where appropriate
foreign key must be valid
RLS must enforce owner access
```

If a table is intentionally different, document why.

---

# 7. P0 — RLS verification

The previous implementation changed RLS toward:

```sql
auth.uid() = user_id
```

That is directionally correct.

Now prove it.

## 7.1 Required tests

Create two authenticated test identities:

```text
USER_A
USER_B
```

Create representative records owned by each.

Test:

```text
USER_A SELECT USER_B row → rejected / invisible

USER_A UPDATE USER_B row → rejected

USER_A DELETE USER_B row → rejected

USER_A INSERT user_id=USER_B → rejected

USER_A INSERT user_id=USER_A → allowed
```

Repeat for every user-owned table where meaningful.

## 7.2 Do not only test helper functions

The test must exercise the database authorization boundary.

If the project uses Supabase, use the appropriate authenticated client/session mechanism.

A test of:

```ts
requireOwnedFile()
```

alone is insufficient.

## 7.3 Verify NULL-owner behavior

Explicitly test:

```text
anonymous → private rows → denied

authenticated user → NULL-owner row → not accessible
```

If NULL-owner rows should no longer exist, verify the database constraint prevents future NULL ownership.

---

# 8. P0 — Complete API route and method inventory

Enumerate every application API route.

Create:

| Route | Method | Public/Private | Auth primitive | Object IDs | Ownership check | DB/RLS | Notes |
|---|---|---|---|---|---|---|---|

Do not report merely:

```text
14 private endpoints
```

List the actual routes.

Include:

```text
GET
POST
PUT
PATCH
DELETE
HEAD
OPTIONS
```

where applicable.

Inspect:

```text
files
batch files
download
download-batch
folders
accounts
analytics
duplicates
rebalance
share creation
share deletion
share access
Google OAuth
```

and every additional route found.

## 8.1 Route-level verification

For every private route verify:

```text
no session → 401

session User A + User B object → 403/404

session User A + User A object → allowed where otherwise valid
```

---

# 9. P0 — Actual HTTP-level cross-user tests

The previous test suite appears to exercise security helpers.

Add tests against the actual API layer.

For example:

```text
HTTP GET /api/files/B
authenticated as A
→ 403/404

HTTP PATCH /api/files/B
authenticated as A
→ 403/404

HTTP DELETE /api/files/B
authenticated as A
→ 403/404
```

Repeat for:

```text
folders
connected accounts
shares
```

where applicable.

The goal is to test:

```text
HTTP request
 ↓
route
 ↓
authentication
 ↓
authorization
 ↓
database
```

not only isolated helpers.

---

# 10. P0 — Batch operation security

Explicitly test mixed-owner requests.

Example:

```text
User A owns:
A1
A2

User B owns:
B1
B2
```

Send:

```text
[A1, A2, B1, B2]
```

to every batch-capable endpoint.

Verify the intended behavior.

For destructive operations, explicitly document whether the operation is:

```text
ATOMIC
or
PARTIAL WITH PER-ITEM AUTHORIZATION
```

Do not allow an unauthorized object to be mutated.

Also test:

```text
duplicate IDs
empty array
very large array
malformed IDs
missing IDs
```

where appropriate.

---

# 11. P0 — Service-role / privileged-client audit

Search the entire repository for privileged database access.

Search for:

```text
SUPABASE_SERVICE_ROLE_KEY
service_role
service key
admin client
createClient
```

Produce:

| File | Privileged access? | Why required? | User authorization before use? | Browser exposed? |
|---|---|---|---|---|

## 11.1 Requirements

If service-role access exists:

- it must be server-only
- credentials must never reach the browser
- it must not be used to bypass user authorization
- every user-triggered privileged operation must independently verify authorization

## 11.2 Public sharing

If public sharing uses privileged access, document the exact security boundary:

```text
share token
 ↓
token validation
 ↓
expiration/revocation
 ↓
shared-resource resolution
 ↓
only intended resource
 ↓
privileged lookup/stream
```

Verify arbitrary file IDs cannot be substituted.

---

# 12. P0 — OAuth replay protection

The previous report states that replay protection is achieved by deleting the OAuth state cookie during callback processing.

That is not automatically sufficient.

## 12.1 Required investigation

Inspect the exact implementation.

Determine whether OAuth state is:

```text
stateless
or
server-side transactional
```

If stateless, determine exactly how single-use behavior is guaranteed.

If state is stored server-side, verify atomic consumption.

## 12.2 Required behavior

The same OAuth callback must not be accepted twice.

Test:

```text
first callback → success

same callback again → rejected
```

## 12.3 Concurrency test

Attempt two callbacks for the same OAuth transaction concurrently.

Expected:

```text
exactly one succeeds
the other is rejected
```

Do not accept:

```text
both succeed
```

as a valid result.

---

# 13. P0 — OAuth concurrent-flow test

Test:

```text
Tab A → OAuth transaction A
Tab B → OAuth transaction B
```

Then:

```text
callback A
callback B
```

Verify:

- each callback maps to the correct MultiDrive user/session
- one state does not overwrite another incorrectly
- stale state is rejected
- callback order does not create account misbinding

Also test:

```text
logout between initiation and callback
session changes between initiation and callback
callback in another browser/session
```

The exact expected behavior should be documented.

---

# 14. P0 — OAuth state requirements

Verify:

- state is cryptographically unpredictable
- state has integrity protection
- state has an expiration
- state is bound to the initiating user/session
- state is single-use
- state cannot be replayed
- user ID is not trusted merely because it was supplied by the browser
- callback validates the authenticated MultiDrive identity

If PKCE is used or applicable, verify:

```text
code_challenge
code_verifier
```

are correctly bound to the transaction.

If PKCE is not used, document why.

---

# 15. P1 — Public share security audit

Test:

```text
valid token
expired token
revoked token
invalid token
random token
modified token
wrong password
missing password
wrong file ID
```

Verify a valid share only exposes the specifically shared resource.

Attempt:

```text
valid share token + another file ID
valid share token + another user's file ID
```

Both must fail.

Do not weaken general private RLS to make sharing work.

---

# 16. P1 — Analytics isolation

Create data for:

```text
User A
User B
```

Verify:

```text
A analytics → only A
B analytics → only B
```

Test:

- storage totals
- file counts
- folder counts
- account counts
- any metadata returned

No aggregate should accidentally span users.

---

# 17. P1 — Duplicate detection isolation

Create:

```text
User A file
User B identical-looking file
```

Verify User A's duplicate detection does not expose or classify User B's file as if it belonged to A.

Test both:

```text
API response
database query
```

where practical.

---

# 18. P1 — Rebalance isolation

If rebalance exists:

```text
User A accounts
User B accounts
User A files
User B files
```

Verify User A cannot:

- migrate User B files
- inspect User B account capacity
- mutate User B account state
- cause storage movement involving User B files/accounts

---

# 19. P1 — Error and enumeration behavior

For each private object type compare:

```text
nonexistent ID
existing User B ID
```

Determine whether responses intentionally disclose object existence.

If resource non-disclosure is desired, use consistent `404` behavior.

If `403` is used, ensure no sensitive metadata leaks.

Do not expose raw database/provider errors.

---

# 20. P1 — Migration idempotency verification

Do not merely claim migration idempotence.

Actually test:

```text
fresh database
 ↓
migration
 ↓
PASS
 ↓
same migration again
 ↓
PASS
```

Also test an existing representative database if possible:

```text
existing schema/data
 ↓
migration
 ↓
PASS
```

Record:

- command
- database state
- result
- errors
- warnings

If the migration is not safely rerunnable, correct it or document the exact limitation.

---

# 21. P1 — Build and regression verification

Run the actual project commands.

At minimum:

```text
lint
typecheck
tests
build
```

Also manually verify the major flows affected by Phase 1:

```text
login
logout
private file listing
folder access
Google account connection
Google OAuth callback
file upload
file download
file delete
share creation
public share access
```

Do not state:

```text
Functional Issues: None
```

unless these flows were actually exercised or equivalent automated integration tests exist.

---

# 22. Required security test matrix

Expand the security suite to cover at least:

### Authentication

- [ ] anonymous private GET
- [ ] anonymous private POST
- [ ] anonymous private PATCH
- [ ] anonymous private DELETE

### Files

- [ ] A reads B
- [ ] A updates B
- [ ] A deletes B
- [ ] A creates file claiming B ownership

### Folders

- [ ] A reads B
- [ ] A updates B
- [ ] A deletes B
- [ ] A moves A file into B folder

### Accounts

- [ ] A reads B account
- [ ] A updates B account
- [ ] A disconnects B account

### Batch

- [ ] mixed-owner read
- [ ] mixed-owner update
- [ ] mixed-owner delete

### RLS

- [ ] cross-user SELECT
- [ ] cross-user UPDATE
- [ ] cross-user DELETE
- [ ] forged INSERT ownership

### OAuth

- [ ] invalid state
- [ ] expired state
- [ ] replayed state
- [ ] concurrent callback
- [ ] wrong user/session
- [ ] concurrent tab flow

### Sharing

- [ ] invalid token
- [ ] expired token
- [ ] revoked token
- [ ] wrong password
- [ ] resource substitution

### Higher-level isolation

- [ ] analytics
- [ ] duplicates
- [ ] rebalance

---

# 23. Evidence requirements

Every important security claim must have evidence.

Use this format:

```text
Requirement:
Evidence:
Test:
Expected:
Actual:
Status:
```

Example:

```text
Requirement:
User A cannot read User B's file.

Evidence:
HTTP integration test:
GET /api/files/<B-file-id>
authenticated as A

Expected:
404

Actual:
404

Status:
PASS
```

Do not mark a requirement PASS merely because the relevant code appears correct.

---

# 24. Do not over-refactor

During this verification pass:

Do not:

- redesign the storage engine
- introduce chunk allocation
- build a new job queue
- redesign the frontend
- rewrite analytics
- implement Phase 2
- implement Phase 3
- perform unrelated performance optimization

Only make changes necessary to:

1. fix confirmed Phase 1 security issues
2. make security behavior testable
3. make migration behavior safe
4. improve Phase 1 maintainability where directly relevant

---

# 25. Required final artifacts

When complete, produce:

```text
PHASE-1-REPORT-V2.md
```

Optionally, if useful:

```text
PHASE-1-SECURITY-EVIDENCE.md
```

Do not bury critical findings in commit messages.

---

# 26. Mandatory Phase 1 Report V2 structure

The report MUST contain these sections.

## 1. Final status

Choose exactly one:

```text
PASS
PASS WITH WARNINGS
BLOCKED
```

Do not use PASS if any P0 requirement is unverified.

## 2. Executive summary

Explain:

- what was verified
- what was fixed
- what remains
- whether Phase 2 is safe to begin

## 3. Findings from independent review

For each previously identified issue:

| Finding | Confirmed? | Fixed? | Evidence |
|---|---|---|---|

## 4. Complete database inventory

Include the full table/RLS matrix.

## 5. NULL-owner migration evidence

Include the record-by-record evidence and migration behavior.

## 6. Complete API inventory

Include route + method + auth + authorization.

## 7. Authentication architecture

Explain the final implementation.

## 8. Authorization architecture

Explain ownership enforcement.

## 9. RLS architecture

Explain every relevant table's policies.

## 10. Service-role audit

List all privileged access.

## 11. OAuth security model

Explain:

- state
- session binding
- expiration
- replay protection
- concurrency
- PKCE if applicable

## 12. Security tests

List all tests and actual results.

## 13. Manual tests

For every manually executed test provide:

```text
Test:
Steps:
Expected:
Actual:
Result:
```

## 14. Migration verification

Include fresh DB, existing DB, and rerun results.

## 15. Build verification

Include exact commands and outcomes.

## 16. Remaining issues

Separate:

```text
P0 Security blockers
P1 Security concerns
Functional issues
Technical debt
Later-phase work
```

## 17. Deviations

Document anything that differs from this specification.

## 18. Final recommendation

Choose exactly one:

```text
READY FOR INDEPENDENT REVIEW
NOT READY — FIX REQUIRED
BLOCKED — HUMAN DECISION REQUIRED
```

---

# 27. STOP CONDITION

After completing this verification/remediation pass:

**STOP.**

Do not begin Phase 2.

Do not automatically create or implement Phase 2 tasks.

Do not assume that passing local tests means Phase 1 is approved.

The human/independent reviewer will inspect:

```text
PHASE-1-REPORT-V2.md
```

and the relevant implementation.

Only after explicit approval may Phase 2 begin.

---

# 28. Final security gate

Phase 1 can only be considered approved when the following chain is demonstrable:

```text
Authenticated identity
        ↓
Centralized authentication
        ↓
Explicit authorization
        ↓
Object ownership validation
        ↓
Database RLS
        ↓
External-provider authorization
        ↓
Automated integration tests
        ↓
Manual verification
        ↓
Independent review
        ↓
APPROVAL
```

The target is not:

> "The security helper tests pass."

The target is:

> **The complete application security boundary has been exercised and demonstrated.**

---

# 29. Final instruction to Antigravity

Treat this document as a **verification and remediation gate**, not as permission to declare the previous implementation correct.

Be skeptical of your own previous work.

Where the previous report said "verified," independently verify it.

Where the previous report said "PASS," reproduce the result.

Where a security mechanism relies on an assumption, test the assumption.

Where a destructive migration relies on a classification, provide evidence for that classification.

Where RLS is claimed to protect data, test RLS directly.

Where an API is claimed to be protected, test the real API.

Where OAuth is claimed to be replay-safe, perform a replay and concurrency test.

Where service-role access exists, trace every path to it.

If you discover a serious unresolved issue:

```text
STOP
DOCUMENT
DO NOT HIDE IT
```

Do not weaken security to make tests pass.

Do not delete data simply to satisfy a constraint.

Do not fabricate ownership.

Do not proceed to Phase 2.

---

# Phase 1 Verification Decision Tree

```text
                  Phase 1 implementation
                           |
                           v
                  Independent verification
                           |
             +-------------+-------------+
             |                           |
        Evidence sufficient         Evidence missing
             |                           |
             v                           v
        Run security tests          Add tests/evidence
             |                           |
             +-------------+-------------+
                           |
                           v
                  Any P0 issues?
                     /        \
                   YES         NO
                    |           |
                    v           v
              Remediate      P1 review
                    |           |
                    +-----+-----+
                          |
                          v
                    Run full suite
                          |
                          v
                 Generate REPORT-V2
                          |
                          v
                        STOP
                          |
                          v
                 Independent review
                          |
                 +--------+--------+
                 |                 |
              APPROVE           REJECT
                 |                 |
                 v                 v
              Phase 2         Remediate again
```

**END OF PHASE 1 VERIFICATION & REMEDIATION SPECIFICATION**

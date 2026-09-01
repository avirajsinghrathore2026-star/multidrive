# MultiDrive — Phase 1 Remediation Specification
## Identity, Authentication, Authorization & Data Isolation

**Document:** `PHASE-1-SECURITY-IDENTITY.md`  
**Target:** Antigravity coding agent  
**Phase:** 1 of 8  
**Priority:** P0 — Security Blocker  
**Status:** DO NOT PROCEED TO PHASE 2 UNTIL THIS PHASE PASSES REVIEW

---

# 1. Mission

You are working on the existing MultiDrive codebase.

Your task in this phase is **not** to redesign the entire application and **not** to implement later phases.

Your task is to establish a secure, explicit, testable **identity and authorization boundary** for the application.

The current codebase has serious security problems involving:

- missing/optional application authentication
- nullable ownership fields
- RLS policies that permit `user_id IS NULL`
- private API routes that can continue when no user is authenticated
- Google Drive OAuth being mixed conceptually with MultiDrive identity
- insufficient ownership validation
- public sharing being mixed with private-data access

These issues must be corrected before any storage-engine, reliability, or UI refactoring is attempted.

## Non-negotiable principle

**A user must never be able to access or mutate another user's private data, directly or indirectly, by manipulating IDs, request bodies, URLs, API calls, database queries, OAuth callbacks, or client state.**

Do not trust the frontend.

Do not rely solely on application-level checks.

Do not weaken RLS to make an API endpoint work.

---

# 2. Source of truth

The existing repository is the starting point.

Before modifying anything:

1. Inspect the complete repository.
2. Read:
   - `README.md`
   - `AGENTS.md`
   - `CLAUDE.md`
   - package configuration
   - environment/example files
   - Supabase schema/migrations
   - all API routes
   - authentication/OAuth code
   - database access utilities
   - relevant frontend authentication/session code
3. Build a complete map of:
   - tables
   - ownership columns
   - RLS policies
   - API routes
   - server-side Supabase clients
   - browser Supabase clients
   - Google OAuth flow
   - session/cookie flow
   - current assumptions about anonymous users
   - public share flow

Do not begin with blind edits.

---

# 3. Critical findings you must verify

The previous audit identified these issues. Verify each one against the current repository rather than blindly assuming the audit is still exact.

## 3.1 Nullable ownership

Investigate whether these or equivalent ownership fields are nullable:

- `connected_accounts.user_id`
- `file_records.user_id`
- `virtual_folders.user_id`
- `shared_links` ownership relationships
- any future/related tables containing user-owned data

If an entity is private/user-owned, its ownership must not be optional.

## 3.2 Unsafe RLS

Find and eliminate policies equivalent to:

```sql
auth.uid() = user_id OR user_id IS NULL
```

or any policy that effectively allows anonymous access to private rows.

## 3.3 Anonymous API behavior

Find every protected API route that does something equivalent to:

```ts
const { data: { user } } = await supabase.auth.getUser();

if (user) {
  // filter by user
}
```

This is unsafe.

Protected routes must reject missing authentication rather than silently operating without a user.

## 3.4 OAuth identity confusion

Inspect the Google OAuth flow and determine:

- how a MultiDrive user is identified
- how Google Drive authorization is associated with that user
- whether OAuth initiation is bound to an authenticated MultiDrive session
- whether the callback can be initiated/consumed by the wrong browser/session
- whether OAuth `state` is generated, stored, validated, and bound to the initiating user/session
- whether PKCE is applicable and correctly implemented

## 3.5 Cross-user object references

Audit every endpoint accepting identifiers such as:

```text
fileId
folderId
virtualFolderId
connectedAccountId
shareId
```

The server must verify ownership/authorization.

Never assume that because the ID is syntactically valid, it belongs to the requester.

---

# 4. Target security architecture

The desired model is:

```text
                    MultiDrive User
                           |
              authenticated application session
                           |
             +-------------+-------------+
             |             |             |
         Files/Folders  Drive Accounts  Shares
             |             |             |
          user_id       user_id        user_id
```

Every private object has one authoritative owner.

The Google Drive account is an external resource **owned/authorized by a MultiDrive user**.

Google OAuth authorization does NOT replace MultiDrive application authentication.

---

# 5. Authentication requirements

## 5.1 Centralize authentication

Create or improve a server-side authentication utility.

The exact filename is up to you, but it should provide a clear API such as:

```ts
requireUser()
```

which:

1. obtains the authenticated Supabase user
2. rejects missing/invalid authentication
3. returns a strongly typed user object
4. never silently returns `null` for a protected operation

Example conceptual contract:

```ts
const user = await requireUser();
```

If unauthenticated:

```http
401 Unauthorized
```

Do not expose unnecessary authentication internals.

## 5.2 No duplicated authentication logic

Protected API routes should not each invent their own authentication behavior.

Use the shared utility consistently.

## 5.3 Explicit public routes

Make a clear distinction between:

### Private routes

Require authenticated MultiDrive user.

### Public share routes

May be accessible without a MultiDrive session, but only through the intentionally designed share-token flow.

Do not make private tables anonymous merely because a public share feature exists.

---

# 6. Authorization requirements

Authentication answers:

> Who is this?

Authorization answers:

> Is this user allowed to perform this operation?

Every protected operation must answer both.

For a file operation:

```text
authenticated user
        |
        v
requested file
        |
        v
file.user_id === user.id
```

For a folder:

```text
authenticated user
        |
        v
requested folder
        |
        v
folder.user_id === user.id
```

For a connected Google account:

```text
authenticated user
        |
        v
connected account
        |
        v
account.user_id === user.id
```

For operations involving multiple objects, verify ownership of **all** objects.

Example:

```text
move file X into folder Y
```

must verify:

```text
file X belongs to user
folder Y belongs to user
```

---

# 7. RLS requirements

RLS must be the database-level defense-in-depth boundary.

Do not remove RLS to solve application problems.

## 7.1 Private rows

Private tables should generally use policies equivalent in principle to:

```sql
USING (auth.uid() = user_id)
```

and:

```sql
WITH CHECK (auth.uid() = user_id)
```

Adapt the exact policy to the operation and table.

## 7.2 Remove NULL-owner escape hatch

Do not retain:

```sql
OR user_id IS NULL
```

for private user-owned data.

If existing rows have `NULL user_id`, do not casually assign them to an arbitrary user.

Instead:

1. Identify them.
2. Determine whether they are test/demo/orphaned records.
3. Decide a safe migration strategy.
4. Document the decision.
5. Only then enforce `NOT NULL`.

If the repository contains data that cannot safely be attributed, stop and report it rather than inventing ownership.

## 7.3 Service-role clients

If the project uses a Supabase service-role/server-privileged client:

- keep it server-only
- never expose its credentials to the browser
- do not use it as an excuse to skip authorization
- explicitly verify the authenticated user's authorization before privileged operations

A service-role client bypassing RLS is **not** permission to bypass application authorization.

---

# 8. Database ownership model

For every private user-owned table, determine whether it needs:

```sql
user_id UUID NOT NULL REFERENCES auth.users(id)
```

or an equivalent ownership relationship.

Review at minimum:

- connected accounts
- file records
- virtual folders
- shared links
- file chunks if applicable
- upload/job tables if already present
- any other user-owned table discovered during the audit

Do not modify future-phase storage architecture unless necessary to make Phase 1 secure.

---

# 9. OAuth requirements

Google Drive OAuth must be treated as:

> authorization to access an external storage provider on behalf of an already identified MultiDrive user.

It must not be treated as a substitute for application authentication.

## 9.1 OAuth initiation

Before starting a Google connection:

1. Require authenticated MultiDrive user.
2. Generate a cryptographically strong OAuth transaction/state value.
3. Bind that transaction to the authenticated user/session.
4. Store only what is necessary.
5. Use an appropriate expiration.
6. Do not trust client-supplied user IDs.

## 9.2 OAuth callback

The callback must:

1. Validate the OAuth `state`.
2. Confirm that the state belongs to the initiating session/user.
3. Reject missing/expired/replayed state.
4. Exchange the authorization code only after validation.
5. Associate the resulting Google account with the authenticated MultiDrive user.
6. Prevent one user from linking a Google account to another user's MultiDrive account.

If the callback cannot reliably establish the initiating MultiDrive identity, redesign the flow rather than guessing.

## 9.3 Replay protection

OAuth state must be single-use or otherwise protected against replay.

---

# 10. API endpoint audit

Enumerate **every** API route in the repository.

Create a table during your work containing:

| Route | Method | Private/Public | Auth required | Ownership check | RLS | Notes |
|---|---|---|---|---|---|---|

At minimum investigate routes related to:

```text
/auth/*
/api/accounts/*
/api/files/*
/api/folders/*
/api/share/*
```

and every additional route discovered.

For each private route:

- require authentication
- validate input
- enforce ownership
- avoid exposing internal database errors
- return appropriate HTTP status

Do not redesign the entire API in this phase. Focus on security correctness.

---

# 11. IDOR / BOLA audit

Perform an explicit Insecure Direct Object Reference / Broken Object Level Authorization review.

For every ID accepted from the client, ask:

> What prevents User A from replacing this ID with User B's ID?

Test examples:

```text
fileId=A → fileId=B
folderId=A → folderId=B
accountId=A → accountId=B
shareId=A → shareId=B
```

Also test combinations:

```text
User A file + User B folder
User A file + User B account
User A share + User B file
```

Every unauthorized combination must fail.

Prefer `404` where appropriate when you do not want to disclose the existence of another user's object; otherwise use `403`.

Be consistent.

---

# 12. Public sharing boundary

Do NOT attempt to solve public sharing by weakening general RLS.

The desired conceptual model is:

```text
PRIVATE DATA
    |
    +--> authenticated user only

PUBLIC SHARE
    |
    +--> valid share token
    +--> share not expired
    +--> password requirement if enabled
    +--> rate limits later
    +--> only the specifically shared object
```

Phase 1 should establish the authorization boundary.

Do not redesign all share UX yet.

Do not implement advanced rate limiting in this phase unless necessary for security correctness; that is primarily a later API-hardening concern.

But ensure the current design does not accidentally expose private rows merely because they have NULL ownership.

---

# 13. Session/cookie security review

Inspect the current authentication implementation and verify:

- session is server-verifiable
- sensitive tokens are not placed in localStorage unnecessarily
- HTTP-only cookie behavior is appropriate where applicable
- secure cookie behavior is appropriate for production
- same-site behavior is appropriate
- no access token is unnecessarily exposed to client-side code
- server-side authorization never trusts a user ID supplied by the browser

Do not invent a new authentication system if Supabase Auth is already the intended platform.

Use the existing authentication provider correctly.

---

# 14. Error handling

For authentication:

```http
401 Unauthorized
```

For authenticated users lacking permission:

```http
403 Forbidden
```

or `404` where deliberate resource non-disclosure is appropriate.

Do not return raw:

```ts
error.message
```

from database/provider exceptions when that could expose implementation details.

Use safe external error messages and server-side diagnostic logging.

Do not log secrets, tokens, authorization codes, cookies, or sensitive user data.

---

# 15. Migration safety

Database changes are potentially destructive.

Before applying migrations:

1. Inspect existing schema.
2. Determine whether existing data violates new constraints.
3. Do not use destructive `DROP TABLE`, broad deletes, or arbitrary ownership assignment.
4. Prefer explicit migrations.
5. Preserve existing data unless it is demonstrably invalid and a safe migration path exists.

If there are existing NULL-owner records and no safe way to identify their owners:

**STOP and report the issue.**

Do not fabricate ownership.

---

# 16. Tests you MUST add

This phase is not complete without automated security tests.

Implement tests appropriate to the existing stack.

At minimum:

## Authentication tests

```text
unauthenticated request to private endpoint → 401
authenticated request → allowed to proceed
```

## Cross-user file isolation

```text
User A cannot read User B file
User A cannot modify User B file
User A cannot delete User B file
```

## Folder isolation

```text
User A cannot read User B folder
User A cannot modify User B folder
User A cannot delete User B folder
```

## Connected-account isolation

```text
User A cannot access User B Google account metadata
User A cannot mutate User B Google account
```

## Cross-object authorization

```text
User A file + User B folder → rejected
User A file + User B account → rejected
```

## RLS

Test the database policies directly where the project's test infrastructure permits.

## OAuth

Test:

```text
missing state → rejected
invalid state → rejected
expired state → rejected
replayed state → rejected
wrong session/user → rejected
```

Use mocks for Google where appropriate.

---

# 17. Security invariants

After Phase 1, the following must be true.

## Invariant A — Every private request has an identity

```text
Private API request
        |
        +--> authenticated user
        |
        └--> otherwise 401
```

## Invariant B — Every private object has an owner

```text
private object.user_id != NULL
```

## Invariant C — Owner must match authenticated identity

```text
object.user_id === auth.uid()
```

unless a deliberately documented privileged role exists.

## Invariant D — RLS enforces ownership

Application checks are not the only defense.

## Invariant E — Google OAuth is subordinate to MultiDrive identity

```text
MultiDrive User
      |
      +--> Google Drive authorization
```

not:

```text
Google authorization
      |
      +--> creates arbitrary anonymous MultiDrive ownership
```

## Invariant F — Public sharing is explicit

A private object is never public merely because:

```text
user_id IS NULL
```

---

# 18. What NOT to do in Phase 1

Do not:

- rewrite the entire frontend
- implement chunked storage
- implement a new storage allocator
- build a job queue
- rewrite Google Drive provider architecture unless required for identity correctness
- redesign analytics
- redesign duplicate detection
- optimize all database queries
- implement a new UI design
- remove working features just because they are not part of this phase
- weaken RLS to make existing code pass
- assign orphaned rows to arbitrary users
- add fake authentication
- use a hardcoded demo user
- use a client-supplied `user_id` as authoritative identity

Phase 1 is about **identity and authorization**, not the entire product.

---

# 19. Required implementation workflow

Follow this order.

## Step 1 — Inventory

Inspect the entire repository.

Produce an internal map of:

- auth
- sessions
- API routes
- DB tables
- RLS
- OAuth
- ownership
- public share flow

## Step 2 — Establish auth primitive

Implement/fix the centralized server authentication helper.

## Step 3 — Secure private API routes

Update every private route to require authentication.

## Step 4 — Fix authorization

Add ownership checks for all object IDs.

## Step 5 — Fix database ownership

Prepare and apply safe schema/RLS migrations.

## Step 6 — Fix OAuth binding

Secure initiation/callback and associate Google accounts with the authenticated MultiDrive user.

## Step 7 — Add security tests

Write tests for the invariants above.

## Step 8 — Run full verification

Run:

```text
lint
typecheck
tests
build
```

plus any project-specific validation.

If a command does not exist, document that fact.

---

# 20. Code quality requirements

Do not merely patch individual lines.

Prefer maintainable primitives.

For example:

```ts
requireUser()
requireOwnedFile(userId, fileId)
requireOwnedFolder(userId, folderId)
requireOwnedAccount(userId, accountId)
```

or a similarly clean architecture.

Avoid repeating dozens of slightly different authorization implementations.

Use clear types.

Avoid `any` where practical.

Keep route handlers thin where possible.

Do not introduce unnecessary abstractions solely to satisfy this phase.

---

# 21. Acceptance tests

Phase 1 passes only if all of these are true.

### Authentication

- [ ] Anonymous users cannot access private APIs.
- [ ] Private APIs return 401 when no valid session exists.
- [ ] Authenticated user identity comes from the server-side auth/session.
- [ ] No private API trusts a client-supplied `user_id`.

### Authorization

- [ ] User A cannot read User B files.
- [ ] User A cannot modify User B files.
- [ ] User A cannot delete User B files.
- [ ] User A cannot access User B folders.
- [ ] User A cannot access User B connected accounts.
- [ ] Cross-user file/folder combinations are rejected.
- [ ] Cross-user file/account combinations are rejected.

### Database

- [ ] Private ownership fields are non-null where appropriate.
- [ ] Unsafe `user_id IS NULL` RLS exceptions are removed.
- [ ] RLS policies enforce ownership.
- [ ] Database migrations are safe and reproducible.
- [ ] No existing data was silently reassigned.

### OAuth

- [ ] Google OAuth requires an authenticated MultiDrive user.
- [ ] OAuth state is generated securely.
- [ ] OAuth state is validated.
- [ ] OAuth state cannot be replayed.
- [ ] Callback cannot bind an account to the wrong user.
- [ ] Google OAuth is clearly separate from application identity.

### Tests

- [ ] Authentication tests pass.
- [ ] Cross-user isolation tests pass.
- [ ] RLS tests pass where available.
- [ ] OAuth security tests pass.
- [ ] Existing relevant tests still pass.

### Build

- [ ] Lint passes.
- [ ] Typecheck passes.
- [ ] Test suite passes.
- [ ] Production build passes.

---

# 22. Mandatory final report

**This is extremely important.**

When Phase 1 is complete, DO NOT immediately begin Phase 2.

Stop and produce a report named:

```text
PHASE-1-REPORT.md
```

The report must contain the following exact sections.

---

## PHASE 1 REPORT

### 1. Executive summary

State:

- what was changed
- whether Phase 1 is complete
- whether any security blockers remain

Use one of:

```text
PASS
PASS WITH WARNINGS
BLOCKED
```

Do not call it PASS if a mandatory acceptance criterion failed.

### 2. Files changed

List every changed file:

```text
- path/to/file.ts
- path/to/migration.sql
...
```

For each important file, explain why it changed.

### 3. Database changes

Document:

- tables modified
- columns modified
- constraints added
- RLS policies added/removed/changed
- migrations created
- existing data migration performed
- any NULL-owner records discovered
- how those records were handled

### 4. Authentication changes

Explain:

- authentication flow
- centralized auth utility
- protected routes
- session behavior
- unauthenticated behavior

### 5. Authorization changes

Provide a matrix:

| Resource | Read | Create | Update | Delete |
|---|---|---|---|---|
| Files | result | result | result | result |
| Folders | result | result | result | result |
| Accounts | result | result | result | result |
| Shares | result | result | result | result |

Explain how ownership is enforced.

### 6. RLS changes

For each relevant table:

```text
Table:
Old policy:
New policy:
Reason:
```

Do not paste enormous SQL files. Summarize accurately.

### 7. OAuth changes

Explain:

- state generation
- state storage
- state validation
- session binding
- replay prevention
- user association

### 8. Security tests

List every security test added.

For each:

```text
Test:
Expected:
Actual:
Status:
```

### 9. Verification commands

Report the exact commands executed:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

or the actual project equivalents.

Include output status:

```text
PASS
FAIL
NOT AVAILABLE
```

If something could not be run, explain why.

### 10. Known issues

List every remaining known problem, even if it belongs to a later phase.

Do NOT hide issues simply because they are outside Phase 1.

Separate them into:

```text
Security blockers
Functional issues
Technical debt
Future-phase work
```

### 11. Deviations from this specification

If you did anything differently from this document, explain:

```text
Requirement:
What was done:
Why:
Risk:
```

### 12. Files/database state after migration

Explain whether:

- migrations are safe to rerun
- existing development data still works
- production data requires manual intervention
- environment variables changed

### 13. Manual verification instructions

Give me exact steps I can execute manually to verify:

1. anonymous access
2. User A isolation
3. User B isolation
4. folder isolation
5. account isolation
6. OAuth flow
7. public share flow

### 14. Final recommendation

Choose exactly one:

```text
READY FOR REVIEW
NOT READY — FIX REQUIRED
BLOCKED — HUMAN DECISION REQUIRED
```

---

# 23. STOP CONDITION

After generating `PHASE-1-REPORT.md`:

**STOP.**

Do not implement Phase 2.

Do not implement unrelated refactors.

Do not continue automatically.

The human will review the Phase 1 implementation and report separately.

The Phase 1 report will be given to another technical reviewer/AI for independent review.

Only after explicit approval should Phase 2 begin.

---

# 24. Final instruction to Antigravity

You are not being asked to make the repository merely "look secure."

You are being asked to establish a demonstrable security boundary.

When uncertain:

1. inspect the existing implementation
2. identify the security invariant
3. implement the smallest maintainable architecture that guarantees it
4. write a test proving it
5. document the decision
6. stop if a safe migration requires a human decision

**Never trade security for backward compatibility.**

**Never silently weaken authorization.**

**Never invent ownership for existing data.**

**Never treat Google OAuth authorization as proof of MultiDrive application identity.**

**Never continue into Phase 2 automatically.**

The successful outcome of Phase 1 is not "the code compiles."

The successful outcome is:

> **A MultiDrive user has a clearly authenticated identity, every private object has a clearly defined owner, application authorization and database RLS enforce that ownership, Google OAuth is bound to the correct user, anonymous access is limited to deliberately public functionality, and automated tests demonstrate cross-user isolation.**

---

# Phase 1 completion gate

```text
                    PHASE 1
                       |
          +------------+------------+
          |                         |
      Implementation            Tests
          |                         |
          +------------+------------+
                       |
                 Verification
                       |
             +---------+---------+
             |                   |
          PASS              FAIL/BLOCKED
             |                   |
             v                   v
     Generate report        Fix / report
             |
             v
           STOP
             |
             v
     Human/AI review
             |
             v
     Explicit approval
             |
             v
         PHASE 2
```

**END OF PHASE 1 SPECIFICATION**

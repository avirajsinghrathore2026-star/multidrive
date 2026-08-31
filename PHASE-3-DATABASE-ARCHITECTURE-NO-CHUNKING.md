# MultiDrive — Phase 3
# Database Architecture, Integrity & Migrations — NO CHUNKING

**Document:** `PHASE-3-DATABASE-ARCHITECTURE-NO-CHUNKING.md`  
**Phase:** 3  
**Decision:** Files are stored as intact physical objects. No file chunking in the current architecture.  
**Predecessors:** Phase 1 — Security, Identity & Data Isolation; Phase 2 — Secrets, Credentials & OAuth Hardening  
**Purpose:** Establish a clean, reliable database foundation for the current MultiDrive architecture without introducing chunking infrastructure.  
**Execution model:** Antigravity implements this phase, verifies it, produces the required report, and STOPs.

---

# 0. Architectural Decision — READ THIS FIRST

The project is intentionally **NOT implementing file chunking at this stage**.

A logical file should currently map to **one intact physical storage object** on one connected storage account.

Current model:

```text
User
  ↓
MultiDrive File
  ↓
One physical object
  ↓
One connected Drive account
```

NOT:

```text
Logical File
  ↓
Chunk 0 → Drive A
Chunk 1 → Drive B
Chunk 2 → Drive C
```

The future possibility of chunking must remain open, but Phase 3 must **not build chunk infrastructure merely because the original architecture considered it**.

The database should therefore be simpler:

```text
file_records
    ↓
physical provider object
    ↓
connected_accounts
```

There should be no requirement for:

```text
file_chunks
chunk_index
chunk ordering
chunk reconstruction
chunk allocation
```

unless existing repository evidence demonstrates that the application already depends on them. If such dependency exists, document it and stop for review rather than silently preserving a contradictory architecture.

---

# 1. Why We Are Removing Chunking

Chunking was originally considered because it allows a large logical file to span multiple connected drives.

For example:

```text
Drive A = 8 GB free
Drive B = 12 GB free
Drive C = 5 GB free

Total = 25 GB
```

A 20 GB file could theoretically be distributed across them.

However, chunking also introduces:

```text
multiple physical objects per file
partial-upload states
chunk ordering
reconstruction
more metadata
more upload operations
more failure points
resume complexity
orphan chunk cleanup
rebalancing complexity
```

Those capabilities are not required for the current product direction.

The current architecture should instead behave as:

```text
requested file
    ↓
find a connected Drive with enough available capacity
    ↓
upload the entire file
    ↓
record one physical object
```

If no connected Drive can hold the complete file:

```text
reject / defer the upload
```

rather than splitting it.

---

# 2. Future Compatibility

Not implementing chunking now does **not** mean chunking can never be added.

The database should preserve a clean separation between:

```text
logical file identity
```

and:

```text
physical provider object identity
```

That way, a future Phase can introduce something such as:

```text
file_records
    ↓
file_objects
    ↓
multiple physical objects
```

without changing the fundamental meaning of the logical file.

However:

> Do not create empty or speculative chunk tables merely "for future compatibility."

A future architecture should be introduced when there is a real requirement for it.

---

# 3. Phase 3 Mission

Phase 3 now has four primary goals:

1. Make the database a reliable source of truth.
2. Establish strong relational integrity.
3. Establish a clean intact-file storage model.
4. Establish a reproducible migration system.

The original Phase 3 objective remains:

> Turn the database into a reliable source of truth.

The database must enforce the architecture wherever practical rather than relying on application code alone.

---

# 4. Scope

## IN SCOPE

```text
database inventory
schema cleanup
ownership relationships
foreign keys
ON DELETE behavior
unique constraints
check constraints
indexes
timestamps
file lifecycle/status
folder relationships
logical-file model
physical-object mapping
connected-account relationships
shared-link relationships
recycle-bin state
migration architecture
migration reproducibility
fresh database bootstrap
existing database upgrade
data preservation
RLS regression
database integrity testing
application regression
schema documentation
Phase 4 storage-engine contract
```

## OUT OF SCOPE

Do NOT implement:

```text
file chunking
file_chunks
chunk_index
chunk reconstruction
multi-object logical files
chunk upload
chunk download
storage allocator
capacity reservation
parallel allocation
rebalancing
background jobs
retry/resume engine
orphan cleanup workers
provider abstraction implementation
Google Drive upload orchestration
```

Those belong to later architecture unless explicitly re-scoped.

---

# 5. Source of Truth

Use these sources in order:

1. Actual repository
2. Actual current database schema
3. Existing migrations
4. Phase 1 V2 report
5. Phase 2 V2 report
6. This Phase 3 specification
7. Original rebuild plan

Do not assume the original plan's chunking design is still active.

The explicit architectural decision in this document takes precedence for this phase.

If the repository contains chunk-related code:

```text
inspect it
determine whether it is actually used
document it
remove obsolete chunk infrastructure where safe
```

Do not preserve dead architecture simply because it exists.

---

# 6. Preconditions

Before making changes:

```text
[ ] Phase 1 security state understood
[ ] Phase 2 credential state understood
[ ] current schema inspected
[ ] migration history inspected
[ ] all file-related tables identified
[ ] all file-related queries identified
[ ] chunk-related code searched
[ ] current physical Drive mapping understood
```

If the actual implementation materially contradicts this specification:

```text
STOP
document the contradiction
do not silently invent a third architecture
```

---

# 7. Existing Core Tables

The current architecture includes:

```text
connected_accounts
virtual_folders
file_records
shared_links
```

The previous architecture also included:

```text
file_chunks
```

but this phase intentionally removes chunking from the active design.

The final schema should contain `file_chunks` **only if actual application behavior proves it is still required**.

If it is unused legacy infrastructure:

```text
remove it through a safe migration
```

after verifying that no application code depends on it.

---

# 8. Schema Inventory

Create a complete inventory:

| Table | Purpose | Primary Key | Owner | Parent | Foreign Keys | Unique Rules | Checks | Indexes | Delete Behavior | RLS |
|---|---|---|---|---|---|---|---|---|---|---|

Every table must appear.

Do not omit apparently unrelated tables.

---

# 9. Identity and Ownership

The ownership chain should remain:

```text
auth.users
    ↓
user-owned application records
```

Directly owned entities should have explicit ownership.

At minimum inspect:

```text
connected_accounts.user_id
virtual_folders.user_id
file_records.user_id
```

Ownership fields that are mandatory must be:

```text
NOT NULL
```

and should reference the authenticated user identity appropriately.

---

# 10. Ownership Invariant

The database must make it impossible, through normal database access, to create:

```text
User A file owned by User B
User A folder owned by User B
User A Drive account owned by User B
```

RLS must remain intact.

Do not replace database security with application-only checks.

---

# 11. Foreign-Key Graph

The intended current graph is approximately:

```text
auth.users
    │
    ├── connected_accounts
    │
    ├── virtual_folders
    │
    └── file_records
            │
            └── shared_links
```

And where the file has a physical provider mapping:

```text
file_records
    │
    └── physical provider object
             │
             └── connected_accounts
```

Adapt the exact graph to the actual repository.

Do not create relationships that do not exist.

---

# 12. Logical File Model

`file_records` represents the **logical MultiDrive file**.

A logical file has:

```text
stable identity
owner
name
metadata
logical size
folder relationship if applicable
lifecycle/status
physical storage mapping
timestamps
```

The logical identity must not simply be the external Google Drive file ID.

---

# 13. Physical File Model

Because chunking is not being used, the current model is:

```text
Logical File
      ↓
One Physical Provider Object
      ↓
One Connected Drive Account
```

The database must clearly distinguish:

```text
MultiDrive logical file ID
```

from:

```text
Google Drive physical file ID
```

This distinction keeps future architecture possible without introducing chunking today.

---

# 14. Physical Provider Mapping

Inspect the existing `file_records` columns.

If physical information is already stored directly on `file_records`, determine whether that is sufficiently clear.

Relevant concepts may include:

```text
connected_account_id
provider
provider_file_id
```

Use the existing architecture where appropriate.

Do not create a new `file_objects` table merely for theoretical future chunking.

Create one only if the current intact-file model genuinely benefits from separating logical and physical metadata.

---

# 15. Physical Object Ownership

A physical object must belong to:

```text
the connected account
```

and that connected account must belong to:

```text
the same MultiDrive user as the logical file
```

Do not assume two independent FKs automatically enforce same-user ownership.

Explicitly verify the integrity mechanism.

---

# 16. Connected Accounts

Review:

```text
connected_accounts
```

Verify:

```text
user ownership
provider
provider account identity
encrypted credential reference
created_at
updated_at
connection lifecycle where required
```

Do not expose credential material.

Phase 2's encrypted credential architecture must remain untouched.

---

# 17. Multiple Connected Accounts

Determine whether the product allows:

```text
one Drive account per user
```

or:

```text
multiple Drive accounts per user
```

The MultiDrive concept strongly suggests multiple connected accounts may be needed.

Do not enforce:

```text
UNIQUE(user_id)
```

unless actual product intent requires one account only.

If multiple accounts are supported, define a correct provider-account uniqueness rule.

---

# 18. Provider Account Identity

A connected account should distinguish:

```text
MultiDrive owner
```

from:

```text
external provider account
```

Where the provider exposes a stable account ID, use it for uniqueness rather than relying solely on email.

Do not store unnecessary profile data.

---

# 19. Folder Model

Inspect:

```text
virtual_folders
```

and determine:

```text
Can folders be nested?
Can files exist without a folder?
How is root represented?
Can folders be deleted?
What happens to contained files?
```

Do not add folder hierarchy unless the current product requires it.

---

# 20. File → Folder Integrity

If:

```text
file_records.folder_id
```

exists, verify:

```text
folder exists
folder belongs to same user
```

A basic FK only proves that the folder exists.

It does not prove that the folder belongs to the same user.

Use an appropriate integrity mechanism.

---

# 21. Folder Delete Semantics

Explicitly choose:

```text
CASCADE
RESTRICT
SET NULL
application-controlled behavior
```

based on actual product behavior.

Do not use CASCADE by default.

The final report must explain the choice.

---

# 22. File Size

The database must reject invalid file sizes.

At minimum:

```text
size >= 0
```

The report must specify:

```text
unit
data type
nullability
maximum, if one exists
```

Do not add arbitrary limits.

---

# 23. File Lifecycle

Determine the actual file lifecycle.

If the application supports recycle-bin behavior, represent it explicitly.

Potential concepts include:

```text
status
deleted_at
trashed_at
```

Do not add states without establishing their meaning.

---

# 24. Recycle Bin

Phase 3 may establish the **data model** for trash/recycle-bin state.

It must NOT implement:

```text
background deletion
physical cleanup
orphan cleanup
scheduled jobs
```

Those belong to later phases.

---

# 25. Timestamps

Review:

```text
created_at
updated_at
deleted_at
trashed_at
```

where relevant.

Use timezone-aware timestamps consistently.

If `updated_at` is maintained automatically, verify the mechanism.

---

# 26. Unique Constraints

Audit natural uniqueness.

Likely candidates:

```text
provider + provider_account_id
share token
physical provider ID within provider/account scope
```

Do not make:

```text
file name
folder name
```

globally unique without product justification.

---

# 27. Check Constraints

Evaluate:

```text
size >= 0
valid status values
valid provider values
```

Only enforce constraints whose semantics are known.

---

# 28. Index Strategy

Review indexes for actual access patterns.

At minimum evaluate:

```text
user_id
folder_id
connected_account_id
provider account identity
provider file ID
share token
status
created_at
updated_at
```

Do not index everything automatically.

---

# 29. Shared Links

`shared_links` should remain tied to:

```text
file_records
```

with explicit lifecycle semantics.

Verify:

```text
share → existing file
```

and prevent unintended dangling shares.

Do not redesign the public-sharing feature in this phase.

---

# 30. Shared-Link Token

If share tokens are used for public lookup:

```text
token uniqueness must be database-enforced
```

The exact uniqueness model must match the implementation.

Do not weaken token entropy/security.

---

# 31. User Deletion

Explicitly determine what happens when a user is deleted.

Answer:

```text
folders?
files?
shares?
connected accounts?
encrypted credential records?
physical-object metadata?
```

Avoid accidental cascading deletion of unrelated records.

---

# 32. Connected Account Deletion

Determine what happens when a connected Drive account is disconnected.

Because files are currently intact objects:

```text
what happens to files stored on that account?
```

must be explicitly documented.

Do not silently delete logical file records.

Do not implement account-recovery/rebalancing yet.

---

# 33. Important Current Storage Limitation

Without chunking:

```text
one file must fit completely on one connected Drive.
```

Therefore the current storage allocator, when implemented later, must find:

```text
one account with sufficient available capacity
```

rather than combining capacities across accounts for a single file.

This is an intentional current product limitation.

It should be documented rather than hidden.

---

# 34. Capacity Semantics

If the current database contains:

```text
capacity
used_space
free_space
quota
```

determine which values are:

```text
source of truth
derived
cached
```

Do not implement capacity allocation in Phase 3.

Do not create reservation systems.

---

# 35. No Chunk Tables

The final Phase 3 architecture should NOT require:

```text
file_chunks
chunk_index
chunk_count
chunk_hash
chunk_order
chunk_offset
```

If any of these currently exist and are unused:

```text
identify them as legacy
remove them safely
```

If they are actually required by live application code:

```text
STOP
report the dependency
```

Do not silently create a hybrid architecture.

---

# 36. No Chunk-Based File State

Do not add statuses such as:

```text
CHUNKING
REASSEMBLING
PARTIAL_CHUNKS
```

to the current file lifecycle.

Current files are either:

```text
pending/uploading
complete
trashed/deleted
```

or whatever the actual implementation requires.

Keep the lifecycle minimal.

---

# 37. Migration Architecture

The original database architecture requires a proper migration system.

Establish:

```text
migration files = authoritative schema history
```

A generated schema snapshot, if retained, must not become a second independently editable source of truth.

---

# 38. Migration Inventory

Create:

| Migration | Purpose | Dependencies | Data Transform | Destructive? | Fresh DB | Existing DB |
|---|---|---|---|---|---|---|

Every Phase 3 migration must be listed.

---

# 39. Migration Ordering

Use the existing Supabase migration convention.

General dependency order:

```text
extensions
→ tables
→ foreign keys
→ constraints
→ indexes
→ functions/triggers
→ RLS
→ policies
```

Adapt to the actual repository.

---

# 40. Fresh Database Test

Build a disposable empty database.

Run the entire migration chain.

Verify:

```text
tables
columns
PKs
FKs
UNIQUE
CHECK
indexes
RLS
policies
functions
triggers
```

No manual SQL should be required outside the documented workflow.

---

# 41. Existing Database Upgrade

Start with a representative Phase 2 database.

Populate synthetic:

```text
users
connected accounts
folders
files
shares
```

Then run Phase 3 migrations.

Verify:

```text
records preserved
IDs preserved
ownership preserved
encrypted credentials preserved
RLS preserved
application queries remain valid
```

---

# 42. Destructive Migration Safety

Before:

```text
DROP
ALTER TYPE
NOT NULL
UNIQUE
FOREIGN KEY
```

verify existing data.

If invalid data exists:

```text
STOP
```

or perform a deterministic, documented remediation.

Never silently delete conflicting data.

---

# 43. NULL Owner Audit

Verify:

```text
connected_accounts.user_id IS NOT NULL
virtual_folders.user_id IS NOT NULL
file_records.user_id IS NOT NULL
```

and equivalent ownership fields.

Expected:

```text
0 invalid rows
```

---

# 44. Orphan Audit

Search for:

```text
files referencing missing folders
files referencing missing accounts
shares referencing missing files
physical objects referencing missing accounts
```

Expected:

```text
0 orphan rows
```

unless a relationship is intentionally nullable.

---

# 45. Cross-User Integrity Tests

Attempt:

```text
User A file → User B folder
User A file → User B account
User A physical object → User B account
User A share → User B file
```

Expected:

```text
database rejects
```

or the relationship must be structurally impossible.

---

# 46. RLS Regression

Repeat Phase 1's isolation testing.

Verify:

```text
User A SELECT → only A data
User A INSERT → cannot claim B ownership
User A UPDATE → cannot modify B rows
User A DELETE → cannot delete B rows
```

Dependent relationships must remain isolated.

---

# 47. Direct Database Testing

Do not rely only on API tests.

Perform direct database tests for:

```text
FK violations
CHECK violations
UNIQUE violations
cross-owner relationships
RLS
```

The database itself must prove the invariant.

---

# 48. Application Regression

After migration changes:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Run any repository-specific migration/test commands as well.

---

# 49. Schema Drift

Compare:

```text
migration SQL
actual database schema
generated types
application queries
schema documentation
```

Resolve inconsistencies.

Do not manually edit generated types to hide schema drift.

---

# 50. ORM / Supabase Authority

If the project uses more than one schema-management mechanism:

```text
determine the canonical authority
```

Do not allow:

```text
Prisma schema
+
Supabase migrations
+
schema.sql
```

to independently define conflicting structures.

Document the final workflow.

---

# 51. Functions and Triggers

Audit existing functions/triggers.

For every function:

```text
purpose
security context
tables affected
side effects
```

If `SECURITY DEFINER` exists:

```text
verify owner
verify search_path
verify authorization
```

Do not use privileged functions as a shortcut around RLS.

---

# 52. Data Preservation

Before and after migration compare:

```text
row counts
primary-key sets
owner counts
file counts
folder counts
share counts
connected-account counts
```

Also inspect representative records.

Credentials must remain encrypted.

---

# 53. Credential Regression

Phase 2 established encrypted credential storage.

Phase 3 must verify:

```text
existing encrypted credential
        ↓
Phase 3 migration
        ↓
same encrypted credential
```

Do not decrypt credentials during verification.

Do not print them.

---

# 54. Security Regression

Explicitly verify that Phase 3 did not:

```text
disable RLS
weaken policies
make ownership nullable
expose service-role credentials
change credential storage to plaintext
```

---

# 55. Legacy Chunk Cleanup

Search the complete repository for:

```text
file_chunks
chunk_index
chunk_count
chunk_id
chunk upload
chunk download
reconstruct
reassemble
```

Classify every hit:

```text
ACTIVE
LEGACY
DOCUMENTATION
TEST
DEAD CODE
```

If the code is genuinely dead and safe to remove:

```text
remove it
```

If it is active:

```text
STOP and report
```

because that means the current implementation still assumes chunking.

---

# 56. No Accidental Hybrid Architecture

Do not finish Phase 3 with:

```text
new intact-file architecture
+
old active chunk architecture
```

unless a deliberate compatibility layer is required.

The report must clearly state:

```text
Current file storage model = intact single physical object.
```

---

# 57. Future Chunking Note

Add this to the final architecture documentation:

```text
Chunking is intentionally deferred.

The current system stores each logical file as one intact physical object
on one connected storage account.

Future chunking, if required, should be introduced as a separate architectural
phase with explicit schema, migration, storage, reconstruction, recovery,
and integrity design.
```

Do not implement that future design now.

---

# 58. Phase 4 Contract

Because chunking is removed, Phase 4's current storage-engine contract becomes:

```text
Requested logical file
        ↓
calculate complete file size
        ↓
find connected account with sufficient capacity
        ↓
reserve/allocate capacity
        ↓
upload intact file
        ↓
verify physical object
        ↓
commit physical mapping
        ↓
mark logical file complete
```

If no connected account can hold the entire file:

```text
upload is rejected/deferred
```

No cross-account splitting occurs.

---

# 59. Phase 4 Must Not Assume Pooled Capacity for One File

Current behavior:

```text
Account A = 5 GB free
Account B = 5 GB free
File = 8 GB
```

does NOT mean:

```text
8 GB upload allowed
```

because:

```text
5 GB + 5 GB ≠ one 8 GB physical destination
```

The combined accounts can increase total MultiDrive capacity, but they do not currently combine capacity for a single file.

---

# 60. Future Migration Path

If chunking is later required, a future phase should introduce something like:

```text
logical file
    ↓
physical objects
    ↓
multiple connected accounts
```

with explicit:

```text
object ordering
object offsets
object sizes
checksums
upload state
reconstruction
recovery
```

That is deliberately deferred.

Do not create these tables now.

---

# 61. Required Database Integrity Tests

At minimum:

```text
[ ] NULL owner rejected
[ ] invalid owner FK rejected
[ ] invalid file size rejected
[ ] invalid folder FK rejected
[ ] invalid account FK rejected
[ ] invalid share FK rejected
[ ] duplicate provider identity rejected where required
[ ] duplicate physical provider ID rejected where required
[ ] invalid status rejected where constrained
```

No chunk tests are required because chunking is not part of the architecture.

---

# 62. Required File Tests

Test:

```text
create logical file
attach physical provider object
associate with same-user connected account
reject foreign-user account
reject nonexistent account
reject invalid size
update metadata
trash file
restore file if supported
delete file according to defined semantics
```

Do not upload actual Google Drive content during database-only tests.

---

# 63. Required Folder Tests

Test:

```text
create folder
create file in folder
reject foreign-user folder
delete folder according to defined semantics
```

If nested folders exist:

```text
reject foreign-user parent
verify cycle strategy
```

---

# 64. Required Account Tests

Test:

```text
create connected account
verify ownership
verify provider identity uniqueness
disconnect account
verify dependent behavior
```

Do not revoke real external credentials during database tests.

---

# 65. Required Share Tests

Test:

```text
create share
verify token uniqueness
reject orphan share
delete file
verify share lifecycle
cross-user mutation rejected
```

Preserve existing public-share semantics.

---

# 66. Migration Failure Testing

Where practical, create invalid synthetic data before adding:

```text
UNIQUE
FK
NOT NULL
CHECK
```

Verify the migration:

```text
fails predictably
```

or:

```text
performs an explicitly documented deterministic remediation
```

Never silently discard rows.

---

# 67. Fresh Bootstrap Reproducibility

Run:

```text
clean database A
→ all migrations
```

and:

```text
clean database B
→ all migrations
```

Compare schema structure.

Expected:

```text
equivalent schema
```

---

# 68. Existing Upgrade Reproducibility

Run:

```text
Phase 2 schema
→ Phase 3 migrations
```

in a disposable environment.

Verify:

```text
same intended final schema
+
preserved legitimate data
```

---

# 69. Migration Diff Audit

Inspect:

```text
git diff
migration SQL
schema snapshot
generated types
```

Look specifically for accidental:

```text
DROP TABLE
DROP COLUMN
TRUNCATE
DROP POLICY
```

Any destructive statement must be explicitly documented.

---

# 70. Required Final Report

Create:

```text
PHASE-3-REPORT.md
```

with:

```text
1. Final status
2. Executive summary
3. Architectural decision — no chunking
4. Verification scope
5. Source-of-truth methodology
6. Existing schema inventory
7. Final schema
8. Ownership model
9. Foreign-key model
10. Delete behavior
11. Unique constraints
12. Check constraints
13. Index strategy
14. Timestamp/status model
15. Logical file model
16. Physical object model
17. Connected account model
18. Folder model
19. Shared-link model
20. Recycle-bin model
21. RLS/security preservation
22. Migration architecture
23. Migration inventory
24. Fresh database verification
25. Existing database upgrade verification
26. Data preservation
27. Database integrity tests
28. Cross-user tests
29. Application regression tests
30. Legacy chunk-code audit
31. Remediations
32. Remaining issues
33. Deferred features
34. Phase 4 storage-engine contract
35. Deviations from specification
36. Risk assessment
37. Final recommendation
```

---

# 71. Required Issue Format

For every finding:

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

Include fixed issues.

---

# 72. Required Architecture Diagram

The report must include:

```text
auth.users
    │
    ├── connected_accounts
    │
    ├── virtual_folders
    │       │
    │       └── file_records
    │               │
    │               ├── physical provider identity
    │               │
    │               └── shared_links
    │
    └── other user-owned entities
```

Adapt to the actual final schema.

Do not show chunk tables.

---

# 73. Required Architecture Statement

The report must explicitly say:

```text
Current MultiDrive file model:

One logical file
        ↓
One intact physical provider object
        ↓
One connected storage account
```

And:

```text
Chunking is intentionally deferred.
```

---

# 74. Required Security Questions

Answer each with:

```text
YES / NO
+
evidence
```

Questions:

```text
Can a user-owned row have NULL ownership?
Can a file reference another user's folder?
Can a file reference another user's connected account?
Can a physical object reference another user's account?
Can an orphan share exist?
Can an invalid negative file size exist?
Can duplicate provider identities exist?
Can a user bypass RLS?
Can Phase 3 destroy encrypted credentials?
Can a clean database reproduce the schema?
Can a Phase 2 database upgrade safely?
Did Phase 1 RLS remain intact?
Did Phase 2 credential protection remain intact?
```

---

# 75. Acceptance Criteria

Phase 3 is:

```text
PASS
```

only if:

```text
database model is coherent
+
logical and physical file identity are clear
+
ownership is enforceable
+
foreign keys are correct
+
delete behavior is intentional
+
unique constraints are correct
+
check constraints protect core invariants
+
indexes support important access paths
+
RLS remains intact
+
fresh database is reproducible
+
existing database upgrades safely
+
data is preserved
+
credentials remain encrypted
+
legacy chunking is removed or proven unused
+
Phase 1 remains green
+
Phase 2 remains green
+
lint passes
+
typecheck passes
+
tests pass
+
production build passes
```

Otherwise:

```text
FAIL
```

or:

```text
BLOCKED
```

---

# 76. STOP Condition

After Phase 3:

```text
STOP.
```

Do not start Phase 4 automatically.

Do not implement:

```text
chunking
storage allocator
capacity reservation
parallel upload
rebalancing
background jobs
retry/resume
orphan cleanup
```

Produce:

```text
PHASE-3-REPORT.md
```

and wait for independent review.

---

# 77. About Combining Phase 3 and Phase 4

Removing chunking makes Phase 3 **smaller in scope**, but that does not automatically mean Phase 3 and Phase 4 should be merged.

The distinction should remain:

```text
PHASE 3
Database architecture
        ↓
PHASE 4
Storage engine
```

Phase 3 establishes:

```text
what the data means
```

Phase 4 establishes:

```text
how files are actually stored, allocated, uploaded, verified, and recovered
```

Even without chunking, Phase 4 still contains substantial work:

```text
capacity discovery
storage allocation
complete-file placement
reservation
upload orchestration
verification
failure handling
provider interaction
physical mapping
```

Therefore **do not merge the phases merely because the MD became shorter**.

If Antigravity completes Phase 3 quickly, that is a good sign: the database architecture is intentionally simpler.

Keep the independent verification gate.

---

# 78. Final Principle

The current architecture should optimize for:

```text
simplicity
correctness
security
reliability
future extensibility
```

rather than implementing hypothetical complexity.

The current storage model is intentionally:

```text
ONE FILE
    ↓
ONE PHYSICAL OBJECT
    ↓
ONE CONNECTED DRIVE
```

MultiDrive still provides value by allowing a user to connect multiple Drive accounts and use them as a larger collection of available storage.

The tradeoff is explicit:

> A single file cannot currently exceed the available capacity of one connected Drive account.

If that limitation becomes unacceptable later, chunking can be introduced deliberately as its own architectural upgrade.

**Do not build complexity before the product needs it.**

---

# END OF PHASE 3 — NO CHUNKING

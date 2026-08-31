# MultiDrive — Phase 2 Verification & Remediation
## Secrets, Credentials & OAuth Hardening

**Purpose:** Independently challenge the Phase 2 implementation and `PHASE-2-REPORT.md`, remediate genuine defects, re-test, produce `PHASE-2-REPORT-V2.md`, then STOP.

---

## 1. Mission

This is a **verification/remediation specification**, not another rebuild prompt.

The existing Phase 2 report claims PASS, 18/18 security assertions passed, TypeScript/lint/build passed, no P0/P1 blockers, and no deviations. Verify those claims against the **actual current repository**. The report is evidence, not proof.

Required workflow:

```text
AUDIT → REPRODUCE → CLASSIFY → REMEDIATE → RETEST → AUDIT AGAIN → REPORT → STOP
```

Do not begin Phase 3.

---

## 2. Source-of-Truth Order

Use:

1. Actual current repository/code
2. `PHASE-2-SECRETS-OAUTH-HARDENING.md`
3. `PHASE-2-REPORT.md`
4. Phase 1 implementation/report/tests

If the report says PASS but code/evidence does not establish the property, mark the claim unsupported and remediate when in scope.

---

## 3. Phase 1 Regression Gate

Verify these remain intact:

- authentication boundaries;
- `requireUser()` on private APIs;
- ownership checks;
- RLS;
- cross-user isolation;
- user-bound OAuth state;
- existing Phase 1 security tests.

Any regression is a blocker until fixed.

---

## 4. Repository Audit Before Editing

Inspect at minimum:

```text
src/lib/config.ts
src/lib/vault.ts
src/lib/google-drive.ts
src/lib/auth.ts
src/app/api/auth/google/connect/route.ts
src/app/api/auth/google/callback/route.ts
src/app/api/accounts/route.ts
supabase/schema.sql
supabase/migrations/*
tests/security.test.ts
package.json
.gitignore
.env.example
```

Also inspect every caller/importer of:

```text
getServerConfig
encryptToken
decryptToken
encryptSecret
decryptSecret
getOAuth2Client
getAuthenticatedDriveClient
revokeGoogleToken
vault_secret_id
```

Do not assume this list is exhaustive.

---

## 5. Repository-Wide Secret/Credential Search

Search the entire repository for:

```text
ENCRYPTION_SECRET
GOOGLE_CLIENT_SECRET
GOOGLE_CLIENT_ID
refresh_token
access_token
client_secret
authorization
authorization_code
token
credential
vault_secret_id
stateParam
md_oauth_state
encryptToken
decryptToken
encryptSecret
decryptSecret
console.log
console.error
console.warn
JSON.stringify
```

Review each security-sensitive occurrence. Classify it as:

```text
SAFE / SUSPICIOUS / UNSAFE / INTENTIONAL / TEST-ONLY
```

The V2 report must summarize the audit.

---

# 6. Configuration Verification

Inspect `src/lib/config.ts` and all callers.

### Missing secret

Run with `ENCRYPTION_SECRET` unset.

Expected:

```text
FAIL CLOSED
```

There must be no default/fallback.

Search for all equivalent fallback patterns:

```text
process.env.ENCRYPTION_SECRET ||
process.env.ENCRYPTION_SECRET ??
```

and indirect defaults.

### Empty/short secret

Test:

```text
ENCRYPTION_SECRET=""
```

and a value below the documented minimum.

Expected: rejection.

### Error safety

Configuration errors must not expose:

```text
secret
derived key
environment object
credential values
```

---

# 7. Server-Only Secret Boundary

Verify `ENCRYPTION_SECRET` and `GOOGLE_CLIENT_SECRET` are never exposed through:

- client components;
- `"use client"` modules;
- `NEXT_PUBLIC_*`;
- serialized props;
- API responses;
- browser storage;
- generated client bundles.

If practical, inspect production client chunks for actual secret values.

Variable names alone are not proof of leakage; actual secret material must remain server-side.

---

# 8. `.env.example` and Git Hygiene

Verify:

```text
[ ] .env.example contains placeholders only
[ ] no real secrets are committed
[ ] local environment files are ignored
[ ] no hardcoded encryption secret exists
[ ] no Google client secret exists in source
```

Search tracked files for suspicious secret literals.

---

# 9. Cryptographic Implementation Audit

Inspect `src/lib/vault.ts` directly.

Verify actual crypto calls establish:

```text
AES-256-GCM
32-byte key
cryptographically random IV
fresh IV per encryption
authentication tag generation
authentication tag verification before plaintext release
```

Do not accept comments as evidence.

---

# 10. Random-IV Test

Encrypt identical plaintext several times.

Expected:

```text
encrypt(P) !== encrypt(P)
```

Inspect IVs where practical and confirm they differ.

Do not use `Math.random()`, timestamps, or deterministic IVs.

---

# 11. Tamper Tests

For a valid ciphertext, independently mutate:

```text
IV
authTag
ciphertext
```

Expected in every case:

```text
decryption rejected
```

No corrupted plaintext may be returned.

---

# 12. Malformed Ciphertext Tests

Test:

```text
empty value
missing version
unsupported version
missing IV
missing auth tag
missing ciphertext
extra segments
invalid hex
odd-length hex
truncated values
```

Expected:

```text
controlled failure
```

No key, plaintext, credential, or stack trace may leak to clients.

---

# 13. Legacy Compatibility

The Phase 2 report claims the Phase 1 format remains decryptable:

```text
<iv>:<authTag>:<ciphertext>
```

Reproduce this with a known fixture generated by the actual legacy implementation.

Verify:

```text
legacy ciphertext → current decrypt → exact plaintext
```

Do not invalidate existing legitimate credentials merely because Phase 2 introduced:

```text
v1:<iv>:<authTag>:<ciphertext>
```

If re-encryption exists, verify it safely.

---

# 14. Wrong-Key Test

Encrypt with secret/key A.

Attempt decryption with secret/key B.

Expected:

```text
rejected
```

Never return garbled plaintext.

---

# 15. Key-Rotation Claim

The report says automated multi-key rotation is deferred.

Verify that claim is accurate.

Test what happens when credentials encrypted under key A are run with key B.

Document whether:

```text
existing credentials remain usable
```

or:

```text
they require migration/recovery
```

Do not claim automated rotation unless it is actually implemented.

If changing the secret can make existing credentials undecryptable, document that operational limitation honestly.

---

# 16. Full Credential Lifecycle Audit

Trace:

```text
Google authorization
→ authorization code
→ Google token exchange
→ access token
→ refresh token
→ encryption
→ database
→ decryption
→ Google API client
```

For every stage document:

```text
where value exists
whether encrypted
whether persisted
whether browser-visible
whether logged
```

---

# 17. Critical Access/Refresh Separation

Search for:

```text
refresh_token || access_token
```

and semantically equivalent fallback logic.

There must be no path where an access token is assigned to the durable refresh-token field.

### Test

Mock:

```json
{
  "access_token": "ACCESS_ONLY",
  "refresh_token": null
}
```

with no existing credential.

Expected:

```text
safe connection failure
no account with unusable credential
ACCESS_ONLY never persisted as vault_secret_id
```

---

# 18. New Refresh Token Test

Mock:

```json
{
  "access_token": "ACCESS_NEW",
  "refresh_token": "REFRESH_NEW"
}
```

Verify:

```text
REFRESH_NEW → encrypted → persisted
```

Verify plaintext `REFRESH_NEW` never reaches the durable database value.

---

# 19. Refresh Token Preservation

Create an existing account containing encrypted `REFRESH_OLD`.

Simulate reauthorization with:

```json
{
  "access_token": "ACCESS_NEW",
  "refresh_token": null
}
```

Expected:

```text
REFRESH_OLD remains intact
```

It must not become:

```text
null
empty string
ACCESS_NEW
```

---

# 20. Initial OAuth Without Refresh Token

With no existing credential, simulate an OAuth response containing only an access token.

Expected:

```text
connection rejected safely
no connected account created
no token persisted
```

---

# 21. OAuth State Verification

Inspect actual implementation and verify:

```text
userId bound to authenticated user
nonce present
createdAt present
authenticated/encrypted
HttpOnly
Secure in production
SameSite=Lax or stricter
expiration enforced
single-use/replay protection
```

Do not rely on comments.

---

# 22. OAuth State Negative Tests

Test all of:

```text
wrong user
cookie/query state mismatch
expired state
replayed state
malformed state
missing cookie
missing query state
```

Expected:

```text
rejected
no token exchange where validation should occur first
no credential persistence
```

---

# 23. Concurrent OAuth Flow Test

Simulate:

```text
User A starts flow #1
User A starts flow #2
```

before either callback completes.

Verify each state can only authorize its own callback.

Also test two near-simultaneous callback attempts where practical.

---

# 24. Process-Local Replay Cache

The report says replay tracking is process-local.

Verify:

```text
cache scope
atomicity under concurrent requests
behavior after process restart
behavior across multiple instances
```

Do not claim distributed replay protection.

If it remains process-local, document it as a limitation rather than hiding it.

---

# 25. OAuth Cookie Audit

Verify production cookie settings:

```text
HttpOnly = true
Secure = true
SameSite = Lax or stricter
expiration ≈ 10 minutes
```

Verify the cookie contains no access/refresh token or client secret.

---

# 26. Redirect URI Security

Inspect how the callback URI is constructed.

It must come only from trusted server configuration.

It must not be derived from attacker-controlled:

```text
Host
Origin
Referer
query parameters
request body
```

Verify:

```text
trailing slash normalization
deterministic callback path
HTTPS in production
no silent localhost fallback
```

If localhost is allowed for development, it must be explicitly configured rather than silently selected.

---

# 27. Host-Header / Origin Poisoning Test

Attempt to manipulate request headers to influence the generated redirect URI.

Expected:

```text
attacker-controlled headers cannot change OAuth callback destination
```

---

# 28. Google Scope Audit

Verify the actual requested scope is:

```text
https://www.googleapis.com/auth/drive.file
```

unless there is a documented product requirement otherwise.

Search all OAuth scope declarations and classify unexpected scopes.

Do not broaden permissions during verification.

---

# 29. Google Client Secret Audit

Search for:

```text
GOOGLE_CLIENT_SECRET
clientSecret
client_secret
```

Verify:

```text
server-only
not NEXT_PUBLIC_*
not returned
not serialized
not logged
not bundled
```

---

# 30. Access Token Persistence Audit

Search every use of `access_token`.

Verify it is not stored in:

```text
database
cookie
localStorage
sessionStorage
URL
API response
client props
```

unless a specific, documented requirement exists.

For this phase, the expected durable Google credential is the encrypted refresh token.

---

# 31. Refresh Token Persistence Audit

Search every use of `refresh_token`.

Expected durable path:

```text
refresh token
→ encryption boundary
→ connected_accounts.vault_secret_id
```

Reject any path that does:

```text
refresh token → plaintext database
refresh token → browser
refresh token → URL
refresh token → logs
```

---

# 32. Google API Refresh Audit

Inspect `getAuthenticatedDriveClient()` and all callers.

Verify:

```text
encrypted credential
→ server-side decrypt
→ OAuth client
→ Google API
```

Access tokens generated by the library remain transient unless a justified requirement exists.

If Google supplies a rotated refresh token, verify whether and how it is safely persisted.

Do not claim rotation support without evidence.

---

# 33. Revocation Audit

Inspect `revokeGoogleToken()`.

Verify:

```text
correct revocation operation
server-side only
no token logging
safe error handling
```

Test with a mocked HTTP layer or equivalent.

A helper existing in source is not proof that revocation behavior is correct.

---

# 34. Disconnect Lifecycle

Trace the real account-disconnect path.

Verify:

```text
disconnect
→ revoke where supported/appropriate
→ remove or invalidate local encrypted credential
→ stale credential cannot be reused
```

If revocation fails, ensure the token is not leaked and determine actual local cleanup behavior.

Report the actual behavior rather than an intended behavior.

---

# 35. Revoked/Invalid Credential Test

Simulate Google returning an invalid/revoked refresh-token error.

Verify:

```text
no infinite retry
no access-token substitution
no secret leakage
no raw Google credential response to client
```

Determine whether the current system returns a controlled error, marks/requires reauthorization, or leaves the account unchanged.

Do not claim persistent status modeling if it does not exist.

---

# 36. Error Response Audit

Trigger:

```text
invalid state
expired state
replay
token exchange failure
missing refresh token
Google credential failure
decryption failure
configuration failure
database failure
```

Verify responses do not expose:

```text
access token
refresh token
authorization code
client secret
encryption secret
raw provider credential response
stack trace
database internals
```

---

# 37. Redirect Leakage Audit

Inspect all OAuth redirects.

No redirect may contain:

```text
access_token
refresh_token
authorization code
client_secret
encrypted credential
OAuth state ciphertext
```

Use controlled error identifiers rather than raw provider errors.

---

# 38. Logging Audit

Review every security-sensitive:

```text
console.log
console.error
console.warn
logger.*
```

especially around:

```text
tokens
credentials
state
secret
error.response
error.config
```

A raw `console.error(error)` can itself leak sensitive request/response data. Inspect the actual error object paths.

Expected:

```text
no plaintext credentials or secrets in logs
```

---

# 39. Database Persistence Audit

Inspect every write involving:

```text
connected_accounts
vault_secret_id
```

Verify:

```text
plaintext refresh token never reaches insert/update
access token never reaches insert/update
failure paths cannot create empty unusable credentials
```

Use spies/mocks where useful to inspect exact persistence arguments.

---

# 40. Database Read / API Serialization Audit

Inspect every read of `vault_secret_id`.

Verify:

```text
encrypted credential remains server-side
decryption occurs only where necessary
decrypted credential is never returned
account objects cannot accidentally serialize credentials
```

Inspect `NextResponse.json()` and equivalent response construction.

---

# 41. Client Bundle Audit

After production build, inspect generated client output where practical.

Verify actual secret values and test credentials are not shipped.

Pay attention to:

```text
GOOGLE_CLIENT_SECRET
ENCRYPTION_SECRET
refresh token fixtures
access token fixtures
```

Do not put real secrets into fixtures.

---

# 42. Test-Quality Audit

Inspect `tests/security.test.ts`.

For each test ask:

```text
Does it exercise production code?
Does it test the real boundary?
Does it assert negative behavior?
Does it verify persistence?
Is the security dependency mocked away?
Does it merely assert constants/comments?
```

Flag weak tests and strengthen them where practical.

A passing test count alone is not evidence.

---

# 43. Required Acceptance Matrix

Create this table in `PHASE-2-REPORT-V2.md`:

| Test | Claim | Verification Method | Evidence/Actual Result | Status |
|---|---|---|---|---|
| A | Missing secret fails closed | Runtime/config | | |
| B | Encryption round trip | Real vault | | |
| C | Tamper rejection | Modified IV/tag/ciphertext | | |
| D | Access token never stored | Callback + persistence | | |
| E | Existing refresh preserved | Reauth test | | |
| F | New refresh encrypted | Callback + DB assertion | | |
| G | User-bound state | Callback | | |
| H | Replay rejected | Repeated callback | | |
| I | Expired state rejected | Expired fixture | | |
| J | No secret leakage | Source/runtime audit | | |

Do not mark PASS without evidence.

---

# 44. Additional Acceptance Tests

Also perform:

```text
K — Empty/short encryption secret
L — Wrong encryption key
M — Legacy ciphertext compatibility
N — OAuth state mismatch
O — Concurrent OAuth flows
P — Client bundle secret audit
Q — Redirect-header poisoning
R — Initial OAuth without refresh token
S — Reauthorization without refresh token
T — Revoked refresh-token behavior
U — Disconnect/revoke behavior
V — Error response leakage
W — Plaintext persistence audit
```

---

# 45. Production-Mode Verification

Where practical:

```bash
npm run build
npm start
```

Then exercise relevant configuration/OAuth behavior in production mode.

Do not use development-only behavior as proof of production security.

---

# 46. Git Diff / Scope Audit

Inspect:

```bash
git status
git diff
```

or equivalent.

Classify changes:

```text
EXPECTED
UNRELATED
SUSPICIOUS
```

Phase 2 verification must not hide unrelated modifications.

Do not implement Phase 3 database/storage work.

---

# 47. Database Scope Check

Confirm no unauthorized redesign of:

```text
file_records
file_chunks
virtual_folders
storage allocation
rebalance
quota architecture
```

If a schema change exists, report:

```text
exact migration
reason
whether credential-related
rollback considerations
```

---

# 48. Dependency Audit

If dependencies changed, report:

```text
dependency
reason
security relevance
whether actually used
```

Do not add unnecessary dependencies during verification.

---

# 49. Remediation Rules

Classify findings:

### P0/P1

Fix immediately.

Examples:

```text
hardcoded secret
plaintext credential persistence
access token stored as refresh token
secret exposed to browser
OAuth state bypass
credential leakage in logs
```

### P2

Fix when small and clearly Phase 2-related.

### Later-phase architecture

Document and defer unless it creates an immediate security failure.

Never turn this verification pass into a Phase 3 implementation.

---

# 50. Re-Test After Remediation

After every security fix:

```text
targeted test
relevant security tests
full test suite
```

Final required commands:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

All must pass for an unconditional PASS.

---

# 51. Required Phase 1 + Phase 2 Regression

Final verification must establish:

```text
Phase 1 security tests → PASS
Phase 2 security tests → PASS
TypeScript → PASS
Lint → PASS
Production build → PASS
```

Never delete or weaken tests to achieve PASS.

---

# 52. Manual Verification

Perform manual inspection of:

```text
OAuth connect
OAuth callback
account disconnect
credential persistence
credential retrieval
error responses
server logs
production client chunks
environment configuration
```

Record what was actually inspected and what evidence was observed.

---

# 53. Security Invariants

The final implementation must establish:

```text
1. No usable encryption secret exists in source.
2. Missing encryption configuration cannot silently fall back.
3. Only encrypted refresh credentials are durably persisted.
4. Access tokens are never substituted for refresh tokens.
5. OAuth credentials cannot cross the browser boundary.
6. OAuth state is bound to the authenticated MultiDrive user.
7. Replay protection is accurately characterized for the deployment model.
8. Credential failures do not disclose secrets.
9. Credentials do not appear in logs.
10. Phase 1 identity/ownership/RLS guarantees remain intact.
```

For process-local replay protection, state the exact limitation rather than overstating it.

---

# 54. Evidence Standard

For each major PASS, provide evidence from one or more of:

```text
source inspection
targeted test
integration test
runtime output
database assertion
production build inspection
manual reproduction
```

Avoid unsupported statements such as:

```text
looks secure
implemented correctly
test passed
```

without describing what was tested.

---

# 55. Final Classification

Use exactly one:

```text
PASS
PASS WITH DOCUMENTED LIMITATIONS
FAIL
BLOCKED
```

### PASS

All Phase 2 security properties are actually established.

### PASS WITH DOCUMENTED LIMITATIONS

Only non-blocking limitations remain and are honestly described.

### FAIL

A fixable security defect remains.

### BLOCKED

Required evidence cannot be obtained.

Do not use PASS merely because `PHASE-2-REPORT.md` says PASS.

---

# 56. Required Output: PHASE-2-REPORT-V2.md

Create:

```text
PHASE-2-REPORT-V2.md
```

with these major sections:

```text
1. Final status
2. Verification scope
3. Source-of-truth methodology
4. Phase 2 claims challenged
5. Repository audit
6. Configuration verification
7. Encryption verification
8. Legacy compatibility verification
9. Credential lifecycle verification
10. OAuth state verification
11. OAuth callback verification
12. Google API credential verification
13. Revocation/disconnect verification
14. Secret/logging audit
15. Browser/client exposure audit
16. Database persistence audit
17. Test-quality audit
18. Acceptance-test matrix
19. Phase 1 regression results
20. Remediations performed
21. Remaining issues
22. Deferred issues
23. Deviations from Phase 2 specification
24. Risk assessment
25. Final recommendation
```

---

# 57. Required Issue Format

For every finding:

```text
Issue ID
Severity
Original claim
Actual behavior
Evidence
Impact
Remediation
Verification
Current status
```

Do not omit a finding because it was fixed.

---

# 58. Required Security Summary

Explicitly answer with:

```text
YES / NO
+
evidence
```

for:

```text
Can missing ENCRYPTION_SECRET silently fall back?
Can an access token be persisted as a refresh token?
Can a refresh token reach the browser?
Can a refresh token reach logs?
Can OAuth state be replayed?
Can OAuth state cross users?
Can callback origin be attacker-controlled?
Can malformed ciphertext return plaintext?
Can legacy credentials still decrypt?
Can key changes break existing credentials?
Can revoked Google credentials cause unsafe behavior?
Can disconnect leave a usable credential?
Can client bundles contain server secrets?
Did Phase 1 remain green?
```

---

# 59. STOP Condition

After verification, remediation, and testing are complete:

```text
STOP.
```

Do not begin:

```text
Phase 3 — Database Architecture
Phase 4 — Storage Engine
```

Do not implement chunking, allocation, rebalancing, background jobs, or unrelated redesign.

Produce `PHASE-2-REPORT-V2.md` and wait for independent review.

---

# 60. Independent Review Gate

The intended workflow is:

```text
PHASE 2 IMPLEMENTATION
        ↓
PHASE-2-REPORT.md
        ↓
PHASE 2 VERIFICATION / REMEDIATION
        ↓
PHASE-2-REPORT-V2.md
        ↓
INDEPENDENT REVIEW
        ↓
PASS
        ↓
PHASE 3
```

The independent reviewer—not Antigravity's own V2 report—determines readiness for Phase 3.

---

# 61. Final Principle

The objective is not to make the Phase 2 report look correct.

The question is:

> **Does the actual MultiDrive implementation establish the security properties Phase 2 claims to establish?**

If yes:

```text
PROVE IT.
```

If no:

```text
FIX IT.
```

If it cannot safely be fixed within Phase 2:

```text
DOCUMENT IT HONESTLY.
```

**Verify the implementation, not the narrative.**

---

# END OF PHASE 2 VERIFICATION / REMEDIATION

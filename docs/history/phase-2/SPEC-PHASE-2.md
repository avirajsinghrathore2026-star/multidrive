# MultiDrive — Phase 2
# Secrets, Credentials & OAuth Hardening

**Document:** `PHASE-2-SECRETS-OAUTH-HARDENING.md`  
**Phase:** 2 of 8  
**Predecessor:** Phase 1 — Security, Identity & Data Isolation  
**Status:** Implementation specification  
**Execution model:** Antigravity must execute this phase only, verify it, report it, and STOP.

---

## 0. Mission

Phase 2 hardens every secret, credential, encryption, and Google OAuth boundary in MultiDrive.

The goal is to make external Google Drive credentials:

- securely encrypted at rest;
- impossible to operate with a silent/default encryption secret;
- correctly separated into access-token and refresh-token concepts;
- safely refreshed;
- safely revoked/disconnected;
- protected from accidental logging;
- bound to the correct MultiDrive user;
- configured through explicit production environment variables;
- covered by automated regression/security tests.

Phase 2 must **not** begin implementing the Phase 3 database redesign or Phase 4 chunked MultiDrive storage engine.

The existing repository is the starting point and source of product intent, but unsafe implementation choices must be replaced rather than preserved for compatibility.

---

# 1. Phase 1 Baseline — DO NOT REGRESS

Phase 1 has already established the application's identity and ownership boundary.

The Phase 1 report states:

- all private APIs enforce `requireUser()`;
- private ownership fields are non-null;
- RLS is enabled;
- cross-user object access is rejected;
- OAuth state is bound to the authenticated MultiDrive user;
- Phase 1 security tests passed 23/23;
- TypeScript passed;
- lint passed;
- production build passed.

Treat these as **existing invariants**.

Phase 2 must preserve them.

### Mandatory regression requirement

At the end of Phase 2:

```text
npm run lint
npx tsc --noEmit
npm test
npm run build
```

must pass.

If Phase 2 causes a Phase 1 regression, fix the regression before declaring Phase 2 complete.

---

# 2. Current Repository Findings

The Phase 1 codebase was inspected before preparing this specification.

## 2.1 Current encryption implementation

Current file:

```text
src/lib/vault.ts
```

Current behavior includes:

```ts
const secret =
  process.env.ENCRYPTION_SECRET ||
  'multidrive-secret-key-32-characters-minimum-super-secure';
```

This is a **Phase 2 blocker**.

The application must never silently fall back to a known hardcoded encryption secret.

The current implementation otherwise uses:

```text
AES-256-GCM
12-byte random IV
authentication tag
iv:authTag:ciphertext format
```

These useful cryptographic properties should be retained unless a better implementation is required.

---

## 2.2 Current OAuth token bug

Current file:

```text
src/app/api/auth/google/callback/route.ts
```

Current code effectively does:

```ts
const refreshToken = tokens.refresh_token || tokens.access_token || '';
```

This is unsafe.

An OAuth access token must **never** be substituted for a refresh token.

Phase 2 must eliminate this behavior completely.

---

## 2.3 Current Google OAuth configuration

Current file:

```text
src/lib/google-drive.ts
```

Current implementation:

- uses `googleapis`;
- requests `https://www.googleapis.com/auth/drive.file`;
- derives redirect URI from `NEXT_PUBLIC_APP_URL`;
- falls back to `http://localhost:3000`;
- creates OAuth clients from environment variables;
- requests offline access;
- uses `prompt: 'consent'`.

Phase 2 must make environment configuration explicit and remove unsafe production fallbacks.

---

## 2.4 Current OAuth state

Current OAuth state:

```text
AES-GCM encrypted JSON
{
  userId,
  nonce,
  createdAt
}
```

is stored in:

```text
md_oauth_state
```

with:

```text
HttpOnly
SameSite=Lax
10-minute maxAge
```

Phase 1 also performs:

- authenticated-user binding;
- cookie/state equality validation;
- expiration validation;
- replay tracking.

Phase 2 must **preserve and harden this implementation**, not casually replace it.

---

## 2.5 Current credential storage

The database currently contains:

```text
connected_accounts.vault_secret_id
```

which is being used to store encrypted Google credential material.

Do not redesign this column/table in Phase 2 unless strictly necessary for credential correctness.

Database architecture belongs primarily to Phase 3.

---

# 3. Scope

## IN SCOPE

Phase 2 includes:

1. Encryption secret management
2. Encryption key derivation/validation
3. AES-256-GCM implementation hardening
4. Encrypted credential format/versioning
5. Credential decryption failure behavior
6. Refresh-token correctness
7. OAuth token lifecycle
8. Google OAuth configuration
9. Redirect URI configuration
10. OAuth callback hardening
11. OAuth state security regression/hardening
12. Google credential revocation handling
13. Disconnect behavior
14. Credential logging audit
15. Secret/environment validation
16. Unit/security tests
17. Integration tests where practical
18. Documentation of required environment variables

## OUT OF SCOPE

Do **not** implement:

- chunked file storage;
- parallel allocation;
- storage balancing/rebalancing architecture;
- new `file_chunks` architecture;
- background job infrastructure;
- major database normalization;
- frontend redesign;
- new sharing architecture;
- general API redesign;
- Phase 3 migrations except narrowly required credential migration;
- Phase 4 storage engine.

If a discovered issue belongs to a later phase, document it and STOP rather than expanding scope.

---

# 4. Non-Negotiable Security Rules

Antigravity must treat the following as hard requirements.

## Rule 1 — No hardcoded secrets

Never use:

```text
fallback-secret
development-secret
default-secret
hardcoded-key
```

for encryption.

No source file may contain a usable production encryption secret.

---

## Rule 2 — Missing encryption secret must fail closed

If `ENCRYPTION_SECRET` is missing or invalid:

```text
application must not silently continue
```

Credential encryption/decryption must fail closed.

Prefer startup/environment validation so a deployment with invalid configuration is rejected before serving requests.

If Next.js runtime architecture makes complete process-startup validation unsafe, implement the strongest server-side fail-fast validation compatible with the framework and document the exact behavior.

Do not weaken security to make local development convenient.

---

## Rule 3 — Never substitute access tokens for refresh tokens

Forbidden:

```ts
refresh_token || access_token
```

Forbidden:

```ts
tokens.access_token
```

being stored in the refresh-token field.

A Google account connection must only persist a refresh token when Google actually supplies one.

---

## Rule 4 — Never log secrets

Never log:

- `ENCRYPTION_SECRET`;
- encryption keys;
- refresh tokens;
- access tokens;
- OAuth authorization codes;
- OAuth state ciphertext;
- decrypted OAuth state;
- encrypted credential blobs;
- `client_secret`;
- credential objects;
- raw Authorization headers.

Logging an object that contains these values is also forbidden.

---

## Rule 5 — No browser exposure of Google client secret

`GOOGLE_CLIENT_SECRET` must remain server-only.

Never place it in:

```text
NEXT_PUBLIC_*
```

variables.

Never return it from an API route.

Never include it in client bundles.

---

## Rule 6 — Credentials are encrypted before database persistence

The plaintext refresh token must exist only transiently in server memory during the OAuth/token lifecycle.

Database writes must contain encrypted credential material.

---

## Rule 7 — Decryption failures must fail closed

A malformed or tampered ciphertext must never produce a plaintext credential.

Return a controlled internal error.

Do not expose:

```text
authentication tag mismatch
ciphertext
key material
stack trace
```

to clients.

---

## Rule 8 — OAuth configuration must be explicit

Production OAuth configuration must not silently fall back to localhost.

The callback URI must be deterministic and explicitly configured.

---

# 5. Required Environment Variables

Establish and document the required server configuration.

At minimum:

```text
ENCRYPTION_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
NEXT_PUBLIC_APP_URL
```

Determine whether any additional environment variable is actually required by the current implementation.

Do not invent unnecessary configuration.

---

# 6. Encryption Architecture

## 6.1 Algorithm

Continue using:

```text
AES-256-GCM
```

unless inspection reveals a concrete implementation reason to change it.

GCM provides:

```text
confidentiality
+
integrity/authentication
```

The authentication tag must always be verified during decryption.

---

## 6.2 IV/nonce

Use a fresh cryptographically secure random IV for every encryption operation.

The current 12-byte IV is appropriate for GCM.

Never:

```text
reuse an IV with the same encryption key
```

Never derive the IV deterministically from the plaintext.

Never use:

```text
Date.now()
Math.random()
UUID text as a replacement for random bytes
```

when cryptographic random bytes are required.

---

## 6.3 Authentication tag

The authentication tag must be:

- generated by the cipher;
- persisted with the ciphertext;
- supplied to the decipher;
- verified before plaintext is returned.

Tampering with any protected ciphertext must cause decryption failure.

---

# 7. Encryption Secret Handling

## 7.1 Validate the secret

Implement a centralized configuration/key-management utility.

It must:

1. read `ENCRYPTION_SECRET`;
2. reject missing values;
3. reject clearly invalid/empty values;
4. avoid logging the value;
5. derive a stable 32-byte AES key.

Do not scatter environment-variable reads across encryption code.

---

## 7.2 Key derivation

The current implementation derives the AES key with SHA-256.

Antigravity must assess whether to retain this approach or introduce a stronger password-based KDF.

Important:

`ENCRYPTION_SECRET` is an application secret, not a user password.

If retaining SHA-256 derivation:

```text
document that ENCRYPTION_SECRET must be high entropy
```

Do not pretend that hashing a weak human password makes it high entropy.

If changing derivation:

- keep the implementation server-only;
- make the format/version explicit;
- provide migration compatibility where required;
- do not silently invalidate existing encrypted credentials.

---

# 8. Version the Encrypted Credential Format

The current format is conceptually:

```text
iv:authTag:ciphertext
```

Phase 2 should introduce an explicit version/format identifier where practical.

Preferred conceptual format:

```text
v1:<iv>:<authTag>:<ciphertext>
```

or an equivalent structured representation.

Requirements:

- parser must reject malformed values;
- parser must reject unsupported versions;
- old values must remain decryptable if they were legitimately created by the Phase 1 implementation;
- migration must not silently destroy valid credentials.

Do not implement a destructive rewrite of all existing credentials without a migration strategy.

---

# 9. Encryption API Requirements

The encryption module should expose a small, deliberate API.

Conceptually:

```ts
encryptSecret(plaintext)
decryptSecret(ciphertext)
```

Existing callers may be adapted from:

```ts
encryptToken()
decryptToken()
```

if doing so improves clarity.

Avoid exposing low-level crypto primitives throughout the application.

The rest of the application should not need to know:

```text
AES
IV
auth tag
key derivation
ciphertext format
```

---

# 10. Encryption Tests

Create or extend tests covering all of the following.

## 10.1 Round trip

```text
plaintext
→ encrypt
→ decrypt
→ original plaintext
```

must pass.

---

## 10.2 Random IV

Encrypt the same plaintext multiple times.

The ciphertexts must differ.

```text
encrypt("same")
encrypt("same")
```

must not produce identical encrypted payloads.

---

## 10.3 Tampering

Modify:

```text
IV
auth tag
ciphertext
```

and verify decryption fails.

---

## 10.4 Malformed input

Reject:

```text
empty string
missing segments
extra segments
invalid hex
invalid version
truncated ciphertext
```

as appropriate.

---

## 10.5 Missing secret

With:

```text
ENCRYPTION_SECRET = undefined
```

encryption/decryption must fail closed.

It must never use a default.

---

## 10.6 Secret change

Verify that data encrypted with key A cannot be decrypted with unrelated key B.

Do not silently return corrupted plaintext.

---

# 11. Google OAuth Token Model

Treat Google OAuth credentials as distinct values.

```text
authorization code
        ↓
Google token exchange
        ↓
access token + refresh token
```

They are not interchangeable.

## Access token

Short-lived credential used to authorize API calls.

Do not persist it as the account's refresh token.

## Refresh token

Longer-lived credential used to obtain new access tokens.

This is the credential MultiDrive should persist encrypted at rest.

---

# 12. Refresh Token Acquisition

In the OAuth callback:

```ts
const { tokens } = await oauth2Client.getToken(code);
```

must be handled carefully.

Required behavior:

### Case A — Google returns a refresh token

```text
tokens.refresh_token exists
        ↓
encrypt it
        ↓
store it
```

### Case B — Google does not return a refresh token

Do **not** do:

```text
use access token instead
```

Instead:

- if an existing connected account exists, preserve its existing refresh token if the OAuth flow is an account reauthorization;
- if no existing refresh token exists, fail the connection in a controlled manner rather than storing an access token as a refresh token.

The exact choice must be documented in code.

---

# 13. Existing Refresh Token Preservation

Google may not return a new refresh token on every authorization.

Therefore:

```text
existing refresh token
+
new OAuth callback without refresh_token
```

must not result in:

```text
existing refresh token overwritten with empty value
```

or:

```text
existing refresh token overwritten with access token
```

Correct conceptual behavior:

```text
new refresh token exists
    → replace encrypted credential

new refresh token absent
    → preserve existing valid refresh token
```

If no existing credential exists:

```text
new refresh token absent
    → connection cannot be completed safely
```

---

# 14. Google OAuth Client Configuration

Current file:

```text
src/lib/google-drive.ts
```

must be hardened.

## Required

Validate:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
NEXT_PUBLIC_APP_URL
```

before constructing an OAuth client.

Do not silently substitute:

```text
http://localhost:3000
```

for production configuration.

---

# 15. Redirect URI

Construct one deterministic redirect URI.

Conceptually:

```text
${NEXT_PUBLIC_APP_URL}/api/auth/google/callback
```

Requirements:

- normalize trailing slash behavior;
- prevent accidental double slashes;
- use HTTPS for production;
- do not accept arbitrary request-origin values;
- do not derive callback URL from attacker-controlled headers;
- document the exact Google Cloud Console redirect URI.

The callback must not be dynamically redirected through an untrusted origin.

---

# 16. OAuth Scopes

Current scope:

```text
https://www.googleapis.com/auth/drive.file
```

must be reviewed.

Do not request broader Google Drive scopes unless the actual product requires them.

For Phase 2:

```text
least privilege
```

is mandatory.

If `drive.file` is sufficient for the current application behavior, retain it.

If later MultiDrive architecture requires broader access, document that as a deliberate future decision rather than expanding scope accidentally in Phase 2.

---

# 17. OAuth State Hardening

Preserve Phase 1's existing state properties:

```text
authenticated MultiDrive user
+
cryptographic nonce
+
createdAt
+
HttpOnly cookie
+
SameSite protection
+
10-minute expiration
+
single-use behavior
```

Verify:

```text
state.userId === authenticatedUser.id
```

before exchanging or persisting credentials.

---

## 17.1 State must not leak

Do not log the full state value.

Instead of:

```ts
console.error("replayed state:", stateParam);
```

log only safe metadata, e.g.:

```text
OAuth state validation failed
reason=REPLAY
```

Do not log encrypted state ciphertext.

---

## 17.2 Replay protection

Phase 1 currently uses an in-memory consumed-state set.

Do not expand this into a new distributed-state architecture during Phase 2 unless necessary.

However, document its limitation:

```text
in-memory replay state is process-local
```

and determine whether the current deployment model makes that acceptable.

If not changed now, explicitly record it as a follow-up security item rather than silently claiming globally distributed replay protection.

---

## 17.3 State cookie cleanup

Ensure state is consumed/deleted safely.

A failed callback must not accidentally leave a reusable authorization state.

Do not consume state before performing checks in a way that creates unexpected behavior, but ensure successful and rejected flows cannot be replayed.

---

# 18. OAuth Callback Error Handling

Current callback:

```text
src/app/api/auth/google/callback/route.ts
```

must distinguish at least:

```text
invalid request
state mismatch
state replay
state expired
user mismatch
token exchange failure
missing refresh token
Google credential failure
database failure
unexpected internal failure
```

Client responses should contain safe error identifiers.

Do not return raw exceptions.

Do not return:

```text
Google API response bodies
OAuth codes
tokens
stack traces
encryption errors
database internals
```

---

# 19. OAuth Error Logging

Replace unsafe logging patterns such as:

```ts
console.error(..., stateParam)
```

with structured safe logging.

Safe logging may include:

```text
event name
error category
route
HTTP status
request correlation ID
authenticated user ID if appropriate for internal logs
Google account email only if policy permits and necessary
```

Never include credentials.

If user IDs/emails are logged, keep them deliberate and minimal.

---

# 20. Google API Credential Refresh

Review the behavior of:

```ts
getAuthenticatedDriveClient(refreshToken)
```

The OAuth client should be created with the decrypted refresh token only when required.

Do not persist the newly obtained access token unless a later feature explicitly requires it.

When Google automatically refreshes an access token:

```text
access token is transient
refresh token remains the durable credential
```

If Google supplies a rotated refresh token, preserve the new refresh token securely.

If the Google client library exposes refreshed credentials, inspect whether a new refresh token needs to be persisted.

Do not blindly overwrite the database on every API call.

---

# 21. Revoked / Expired Credentials

Define a consistent error classification.

If Google returns a credential error indicating that the refresh token is invalid/revoked:

```text
do not retry indefinitely
do not expose Google internals
do not delete the account silently
```

Instead:

```text
mark/identify the connected account as requiring reauthorization
```

If the current schema does not have an account status field, do not redesign the database in this phase unless necessary.

Document the minimal safe implementation and defer persistent status modeling to Phase 3 if appropriate.

The user-facing layer should eventually be able to distinguish:

```text
connected
needs reauthorization
disconnected
```

but a complete UI implementation belongs to a later phase.

---

# 22. Disconnect / Revoke

Audit existing account-disconnect behavior.

If no disconnect/revoke implementation exists:

- implement the minimum safe server-side behavior required by the current product;
- revoke Google authorization when practical and supported;
- remove the stored encrypted refresh credential;
- ensure associated account records cannot subsequently be used with an old credential;
- do not leave plaintext credentials in logs or temporary storage.

Do not expand this into a complete account-management redesign.

---

# 23. Credential Storage Boundary

The following conceptual boundary must exist:

```text
Google OAuth
     ↓
refresh token
     ↓
encryption utility
     ↓
encrypted credential
     ↓
database
```

and:

```text
database
     ↓
encrypted credential
     ↓
decryption utility
     ↓
refresh token
     ↓
Google API client
```

The UI must never receive the refresh token.

The browser must never receive the refresh token.

---

# 24. Credential Access API

Audit every current caller of:

```text
vault.ts
getAuthenticatedDriveClient()
fetchGoogleAccountDetails()
```

Ensure:

- decryption occurs only server-side;
- plaintext refresh tokens are not passed into client components;
- decrypted tokens are not returned in JSON;
- database records containing encrypted credentials are not accidentally serialized to clients.

Search the entire repository for:

```text
vault_secret_id
encryptToken
decryptToken
refresh_token
access_token
GOOGLE_CLIENT_SECRET
ENCRYPTION_SECRET
```

Every occurrence must be reviewed.

---

# 25. Logging Audit

Perform a repository-wide search for credential leakage.

Search for patterns such as:

```text
console.log(
console.error(
console.warn(
logger.
JSON.stringify(
```

around:

```text
token
secret
credential
authorization
oauth
state
```

Review each match manually.

The goal is:

```text
No secrets in logs.
```

Do not simply suppress all logging.

Safe operational error information should remain available.

---

# 26. Environment Validation

Create a centralized server-only configuration layer if the repository does not already have one.

Conceptually:

```ts
getServerConfig()
```

should validate required variables.

Do not expose this configuration object to browser code.

Separate:

```text
public configuration
```

from:

```text
server secrets
```

Never place secret configuration in:

```text
NEXT_PUBLIC_*
```

---

# 27. Local Development

Local development must remain possible, but convenience must not compromise the security model.

Provide:

```text
.env.example
```

with placeholders only.

Example conceptual entries:

```text
ENCRYPTION_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Do not put a real secret into `.env.example`.

Do not commit `.env.local`.

Confirm `.gitignore` protects local secret files.

---

# 28. Secret Entropy Requirements

Document that `ENCRYPTION_SECRET` must be a high-entropy secret.

Recommended operational guidance:

```text
generate randomly
store in deployment secret manager
never commit to git
never share in source code
never print in logs
```

Do not use:

```text
password123
multidrive
your-secret
development
```

as a real deployment value.

---

# 29. Encryption Key Rotation

Phase 2 must establish a **rotation strategy**, even if full automated rotation is deferred.

Document:

```text
current key
old key(s)
credential version
migration/re-encryption process
```

Do not create a system where changing `ENCRYPTION_SECRET` permanently makes every stored credential undecryptable without a documented recovery path.

If full multi-key rotation is not implemented in this phase:

```text
explicitly document it as a Phase 2 limitation/follow-up
```

Do not falsely claim automatic key rotation.

---

# 30. Existing Credential Migration

Before changing the encrypted format:

1. identify whether existing encrypted credentials exist;
2. determine which format they use;
3. preserve backward decryption compatibility;
4. write migration logic only if needed;
5. test a real legacy-format round trip;
6. never overwrite an existing credential with an access token;
7. never delete credentials merely because a new format is preferred.

If there are no production credentials, document that fact from repository/runtime evidence and keep the migration path safe anyway.

---

# 31. Database Constraints

Phase 2 should preserve:

```text
connected_accounts.vault_secret_id NOT NULL
```

and Phase 1 ownership/RLS guarantees.

Do not redesign:

```text
file_records
file_chunks
virtual_folders
```

as part of this phase.

If credential lifecycle requires a tiny schema addition such as an explicit credential version/status, justify it carefully and keep it isolated.

Major schema architecture belongs to Phase 3.

---

# 32. Required Unit Tests

Add tests for:

### Encryption

- successful encryption/decryption;
- random IV;
- tampered IV;
- tampered tag;
- tampered ciphertext;
- malformed ciphertext;
- missing secret;
- invalid secret;
- key mismatch;
- format/version handling.

### OAuth token selection

- refresh token returned → refresh token stored;
- refresh token absent + existing credential → existing refresh token preserved;
- refresh token absent + no existing credential → safe failure;
- access token never stored as refresh token.

### OAuth state

- valid state;
- wrong user;
- expired state;
- replayed state;
- state mismatch;
- malformed state;
- state cookie missing.

### Configuration

- missing encryption secret;
- missing Google client ID;
- missing Google client secret;
- missing application URL;
- invalid application URL if validation is implemented.

---

# 33. Required Integration Tests

Where practical, test the real route handlers.

Minimum OAuth flow:

```text
authenticated user
      ↓
connect endpoint
      ↓
state generated
      ↓
state cookie created
      ↓
callback receives state
      ↓
state validated
      ↓
Google token exchange mocked
      ↓
refresh token encrypted
      ↓
connected account persisted
```

Verify the database never receives the plaintext refresh token.

---

# 34. Security Regression Tests

The Phase 1 security suite must remain green.

Additionally verify:

```text
Anonymous → Google connect → 401
Anonymous → Google callback → rejected
User A → User B OAuth state → rejected
Tampered OAuth state → rejected
Replayed OAuth state → rejected
Expired OAuth state → rejected
```

Verify no credential is returned in:

```text
HTTP response body
redirect URL
cookie
client-visible error
server logs
```

---

# 35. Repository-Wide Static Audit

Antigravity must search the complete repository for:

```text
multidrive-secret-key
ENCRYPTION_SECRET
refresh_token
access_token
client_secret
GOOGLE_CLIENT_SECRET
stateParam
md_oauth_state
encryptToken
decryptToken
vault_secret_id
```

The final report must list:

```text
search term
files found
whether each occurrence is safe
changes made
remaining intentional occurrences
```

---

# 36. Specific Files to Inspect

At minimum:

```text
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

Also inspect every file that imports or references the encryption/OAuth modules.

Do not assume the list above is exhaustive.

---

# 37. Required Implementation Sequence

Antigravity should work in this order.

## Step 1 — Repository audit

Before editing:

```text
search
inspect
map callers
identify current credential lifecycle
```

Do not immediately rewrite files.

---

## Step 2 — Configuration hardening

Implement:

```text
server-only environment validation
ENCRYPTION_SECRET requirement
Google OAuth configuration validation
explicit application URL
```

---

## Step 3 — Encryption hardening

Implement:

```text
no fallback secret
centralized key derivation
AES-GCM validation
format/version handling
safe errors
```

---

## Step 4 — OAuth token correctness

Fix:

```text
refresh_token || access_token
```

and implement correct refresh-token preservation.

---

## Step 5 — OAuth callback hardening

Review:

```text
state
cookie
expiration
replay
user binding
token exchange
database persistence
error handling
logging
```

---

## Step 6 — Google API credential lifecycle

Review:

```text
refresh
revocation
credential failures
rotated refresh tokens
disconnect
```

---

## Step 7 — Test suite

Add/modify tests.

Run:

```text
lint
typecheck
tests
build
```

---

## Step 8 — Security audit

Perform final repository-wide secret/token search.

---

# 38. Things Antigravity Must NOT Do

Do not:

- hardcode another fallback secret;
- disable encryption to simplify development;
- store plaintext refresh tokens;
- store access tokens as refresh tokens;
- log tokens for debugging;
- log OAuth state values;
- expose server environment variables;
- use `NEXT_PUBLIC_` for secrets;
- accept callback URLs from request headers;
- broaden Google scopes without justification;
- delete existing credentials merely because the format changed;
- silently invalidate existing credentials;
- redesign the database;
- implement chunking;
- implement distributed storage allocation;
- implement background jobs;
- rewrite the frontend;
- modify unrelated Phase 1 security logic without a reason;
- claim a security property that was not actually tested.

---

# 39. Definition of Done

Phase 2 is complete only when all of the following are true.

## Encryption

```text
[ ] No hardcoded encryption fallback exists
[ ] Missing ENCRYPTION_SECRET fails closed
[ ] Encryption uses AES-256-GCM
[ ] IV is cryptographically random
[ ] Authentication tag is verified
[ ] Tampering causes decryption failure
[ ] Ciphertext format is validated
[ ] Encryption format/version is documented
[ ] Existing credentials remain recoverable
[ ] Key rotation strategy is documented
```

## Credentials

```text
[ ] Refresh token is the only durable Google credential
[ ] Access token is never substituted for refresh token
[ ] Existing refresh token is preserved when Google omits a new one
[ ] Missing initial refresh token fails safely
[ ] Credential decryption occurs server-side only
[ ] Credentials are encrypted before database persistence
```

## OAuth

```text
[ ] OAuth state remains bound to MultiDrive user
[ ] OAuth state expires
[ ] OAuth state is single-use
[ ] OAuth replay is rejected
[ ] OAuth state is not logged
[ ] Callback URL is explicitly configured
[ ] Production does not silently fall back to localhost
[ ] Google scopes are least-privilege
[ ] Callback errors do not leak secrets
```

## Configuration

```text
[ ] GOOGLE_CLIENT_ID validated
[ ] GOOGLE_CLIENT_SECRET validated
[ ] ENCRYPTION_SECRET validated
[ ] NEXT_PUBLIC_APP_URL validated
[ ] Server secrets are not public
[ ] .env.example contains placeholders only
```

## Logging

```text
[ ] No access tokens logged
[ ] No refresh tokens logged
[ ] No OAuth codes logged
[ ] No encryption secrets logged
[ ] No encrypted OAuth state logged
[ ] No client secret logged
```

## Regression

```text
[ ] npm run lint
[ ] npx tsc --noEmit
[ ] npm test
[ ] npm run build
```

all pass.

---

# 40. Acceptance Tests

Antigravity must explicitly execute and report these.

## Test A — Missing encryption secret

```text
Remove ENCRYPTION_SECRET
start application / invoke configuration validation
```

Expected:

```text
FAIL CLOSED
```

Not:

```text
application silently uses default secret
```

---

## Test B — Encryption round trip

```text
encrypt known plaintext
decrypt ciphertext
```

Expected:

```text
original plaintext
```

---

## Test C — Ciphertext tampering

Modify one ciphertext byte.

Expected:

```text
decryption rejected
```

---

## Test D — Access token substitution

Mock Google token response:

```json
{
  "access_token": "ACCESS_ONLY",
  "refresh_token": null
}
```

with no existing credential.

Expected:

```text
connection rejected safely
```

and:

```text
ACCESS_ONLY is never stored as vault_secret_id
```

---

## Test E — Refresh-token preservation

Existing account:

```text
encrypted refresh token = REFRESH_OLD
```

New OAuth response:

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

---

## Test F — New refresh token

OAuth response:

```json
{
  "access_token": "ACCESS_NEW",
  "refresh_token": "REFRESH_NEW"
}
```

Expected:

```text
REFRESH_NEW encrypted and stored
```

---

## Test G — User-bound OAuth state

Create state for:

```text
User A
```

invoke callback as:

```text
User B
```

Expected:

```text
rejected
```

---

## Test H — Replay

Use the same valid OAuth state twice.

Expected:

```text
first use → accepted if all other OAuth requirements pass
second use → rejected
```

---

## Test I — Expiration

Use state older than:

```text
10 minutes
```

Expected:

```text
rejected
```

---

## Test J — Secret leakage

Run repository search and inspect all credential-related logs.

Expected:

```text
No plaintext secret/token logging
```

---

# 41. Required Verification Commands

Run:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Also run repository searches appropriate to the shell.

Examples:

```bash
git grep -n "multidrive-secret-key"
git grep -n "refresh_token || access_token"
git grep -n "GOOGLE_CLIENT_SECRET"
git grep -n "ENCRYPTION_SECRET"
git grep -n "stateParam"
```

If a command is unavailable in the environment, use an equivalent search and report it.

---

# 42. Required Final Antigravity Report

At the end of Phase 2, Antigravity must produce a report with exactly these major sections:

```text
1. Final status
2. Executive summary
3. Files changed
4. Encryption changes
5. Credential lifecycle changes
6. OAuth changes
7. Environment/configuration changes
8. Logging/security audit
9. Database impact
10. Migration impact
11. Tests added
12. Tests executed
13. Verification command results
14. Security acceptance-test results
15. Remaining issues
16. Deferred issues
17. Deviations from this specification
18. Risk assessment
19. Final recommendation
```

For every failed test:

```text
test
expected
actual
root cause
whether fixed
```

must be reported.

Do not hide failures.

---

# 43. STOP CONDITION

**STOP after Phase 2.**

Do not proceed automatically into:

```text
Phase 3 — Database Architecture
```

or:

```text
Phase 4 — Storage Engine
```

After all Phase 2 work is complete:

```text
STOP
```

and provide the final report.

The next phase may begin only after independent review of this report.

---

# 44. Phase 2 Completion Statement

Antigravity may mark Phase 2:

```text
PASS
```

only if:

```text
Encryption is fail-closed
+
credentials are correctly managed
+
OAuth is hardened
+
no secret leakage was found
+
tests pass
+
Phase 1 remains green
```

Otherwise:

```text
FAIL
```

or:

```text
BLOCKED
```

must be reported.

Never mark the phase complete merely because the code compiles.

---

# 45. Architectural Principle

The central principle for this phase is:

> **Credentials are security-critical assets, not ordinary application data.**

Therefore:

```text
configuration
      ↓
validated server-only secret
      ↓
cryptographic boundary
      ↓
encrypted credential
      ↓
database
```

and:

```text
database
      ↓
encrypted credential
      ↓
cryptographic boundary
      ↓
short-lived server-side credential use
      ↓
Google API
```

must remain the architectural boundary.

The browser must never become part of the trusted credential path.

---

# 46. Phase 2 Exit

When the implementation and verification are complete, provide the required report and stop.

Do not make assumptions about Phase 3.

Do not begin database redesign.

Do not begin chunking.

Do not begin the MultiDrive allocation engine.

**Phase 2 ends here.**

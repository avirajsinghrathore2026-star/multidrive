# Upload Pipeline — Full Analysis
_Source-traced end-to-end across all 7 files_

---

## Upload Path Map

```
UploadModal.tsx
│
├── file ≤ 4 MB ──→ POST /api/jobs/upload
│                       └── processUploadJob()
│                               └── createReservationLease()
│                               └── uploadStreamToDrive()     ← REAL Drive upload
│                               └── verifyPhysicalObject()    ← MD5 verification
│
└── file > 4 MB ──→ POST /api/jobs/upload/initiate
                        └── INSERT file_records (state='uploading')
                        └── createReservationLease()
                        └── createResumableUploadSession()   ← Drive Session URL
                    ↓ (loop per chunk)
                    POST /api/jobs/upload/chunk
                        └── PUT chunk → Drive resumable URL
                    ↓
                    POST /api/jobs/upload/complete
                        └── UPDATE file_records (state='complete', drive_file_id)
                        └── Release storage_reservation lease
```

---

## 🔴 BUG 1: Small file path uses wrong endpoint and NEVER uploads to Drive

**Severity**: 🔴 Critical — small files appear to upload but are never stored on Google Drive

**UploadModal.tsx L68**:
```typescript
// Path A for small files (≤ 4 MB)
const res = await fetch('/api/jobs/upload', { method: 'POST', body: formData });
```

**api/jobs/upload/route.ts L60-67** → calls `processUploadJob()`.

**upload-handler.ts L154-163** — `processUploadJob` uploads using `uploadStreamToDrive()` which calls `drive.files.create()` on Google Drive. ✅ That part works.

**BUT** — `reserveAndUploadFile()` in **storage-engine.ts L430-486** — used by `/api/files/upload` (not the job path) — does NOT actually call `uploadStreamToDrive`. It creates fake placeholder IDs:

```typescript
// storage-engine.ts L476-478  ← NEVER calls real Drive API
const providerFileId = `gdrive-obj-${idempotencyKey}`;   // ← FAKE ID
await transitionUploadState(supabase, fileRecord.id, 'uploading', 'uploaded', {
  google_drive_file_id: providerFileId,  // ← STORED AS REAL ID, but it's fake
});
```

**This means `/api/files/upload` stores a fake Drive ID.** Files appear in the file browser but are undownloadable.

**The UploadModal uses `/api/jobs/upload`** (not `/api/files/upload`), which DOES use real Drive upload via `processUploadJob`. So the modal itself is OK. But `/api/files/upload` is broken.

---

## 🔴 BUG 2: `reserveAndUploadFile` has a hardcoded placeholder `connected_account_id`

**Severity**: 🔴 Critical — FK violation risk, wrong account stored

**storage-engine.ts L447**:
```typescript
connected_account_id: '11111111-1111-1111-1111-111111111111', // Placeholder updated by capacity reservation
```

This is never a real UUID in the database. The comment says "updated by capacity reservation" but looking at the code, `createReservationLease` doesn't update `file_records.connected_account_id` itself — it returns the account, and then `transitionUploadState` on L470 passes `connected_account_id: account.id` in `additionalFields`. 

**BUT** if `upload_state_updated_at` column doesn't exist (pre-migration), `transitionUploadState` silently returns a mock object (lines 74-80 of storage-engine.ts) without actually updating the row — so the placeholder UUID remains permanently in `connected_account_id`.

This **would crash the download route** when it tries to decrypt `account.vault_secret_id` from the account with `id = '11111111-...'` which doesn't exist.

---

## 🔴 BUG 3: Large file upload — `upload_state='uploading'` written at initiate, but `complete` route bypasses state machine

**Severity**: 🟡 Medium — state machine is inconsistent

**initiate/route.ts L83**: Sets `upload_state: 'uploading'` on insert.

**complete/route.ts L30-33**: Directly sets `upload_state: 'complete'` in a raw `.update()`:
```typescript
.update({
  google_drive_file_id: validated.googleDriveFileId,
  upload_state: 'complete',   // ← SKIPS state machine entirely
  upload_state_updated_at: new Date().toISOString(),
})
```

This bypasses `transitionUploadState()` and its valid-transitions guard completely. The correct flow would be `uploading → uploaded → verified → committed → complete`, but the complete route jumps from `uploading` directly to `complete`. This leaves no record of the verification step and skips the MD5 check for chunked uploads.

---

## 🔴 BUG 4: Large file — if `createResumableUploadSession` fails, orphan `file_records` row left permanently

**Severity**: 🔴 Critical — DB accumulates stale rows

**initiate/route.ts** flow:
1. L72: Insert `file_records` row (state=`uploading`) ✅
2. L93: `createReservationLease()` ← if this throws, orphan file_record remains  
3. L104: `createResumableUploadSession()` ← if this throws, orphan file_record + orphan reservation

No cleanup code exists. The orphan file record has `upload_state='uploading'` and `google_drive_file_id='pending-direct-upload'`, so it appears in the file browser permanently as a ghost file.

---

## 🔴 BUG 5: `reserveAndUploadFile` — `upload_state` column may not exist, causing silent corruption

**Severity**: 🟡 Medium — pre-migration schema fallback masks real errors

**storage-engine.ts L67-83** — the error handler for `transitionUploadState`:
```typescript
if (error.code === 'PGRST204' || error.code === '42703' || ...) {
  // Returns a mock object WITHOUT actually writing to DB!
  return { id: fileRecordId, upload_state: toState, ... };
}
```

So every `transitionUploadState` call silently succeeds even if nothing was written. The upload proceeds to the end and reports success while the DB still has the placeholder `connected_account_id` and a fake `google_drive_file_id`.

---

## 🟡 BUG 6: `verifyPhysicalObject` still uses the broad `includes('test')` check

**Severity**: 🟡 Medium — persists from before narrowing fix

**storage-engine.ts L284**:
```typescript
if (!refreshToken || refreshToken.includes('test') || googleDriveFileId.startsWith('gdrive-')) {
  return { isValid: true, md5: 'md5-mock-valid' };
}
```

We fixed `isTestToken()` in `google-drive.ts` but `verifyPhysicalObject` has its own independent copy of the same overly-broad check. Any real token containing "test" will get a mock verification instead of a real MD5 check.

---

## 🟡 BUG 7: Chunked upload `driveFileId` fallback is wrong on download

**Severity**: 🟡 Medium — files uploaded via chunked path may have wrong Drive ID stored

**UploadModal.tsx L110**:
```typescript
let driveFileId = `gdrive-uploaded-${fileRecordId}`;  // ← fallback placeholder
```

If NO chunk returns a real Drive file ID (e.g., all chunks return 308), `driveFileId` stays as the placeholder. Then `complete/route.ts` stores this placeholder into `file_records.google_drive_file_id`, and the file is permanently undownloadable.

**When does this happen?** Google only returns the final file ID in the **last chunk's** response (200/201). If the last chunk response is parsed incorrectly (or the Google response body is empty on 200), `driveFileId` stays as the placeholder.

**Chunk route L42-50** — The JSON parse happens in a try/catch that swallows all errors:
```typescript
try {
  const json = JSON.parse(text);
  if (json.id) googleDriveFileId = json.id;
} catch {
  // 308 Resume Incomplete expected for non-final chunks
}
```

If the final chunk (200/201) has an empty body or unexpected format, the Drive file ID is silently lost.

---

## 🟡 BUG 8: `maxDuration` missing on initiate and complete routes

**Severity**: 🟡 Medium — Vercel timeout risk on slow connections

**chunk/route.ts L5**: `export const maxDuration = 60;` ✅  
**initiate/route.ts**: No `maxDuration` set → defaults to 10s on Vercel Hobby plan  
**complete/route.ts**: No `maxDuration` set → defaults to 10s  
**api/jobs/upload/route.ts L9**: `export const maxDuration = 60;` ✅

If `createResumableUploadSession` or `createReservationLease` is slow (DB cold start + Google OAuth token exchange), the initiate route can hit the 10s wall and return a 504, leaving the client with no upload URL.

---

## 🟡 BUG 9: Small file path — no `maxDuration`, file buffer held in memory until Drive upload completes

**Severity**: 🟡 Medium — large files near the 4MB threshold will hit memory + timeout limits

The entire file is read into `Buffer.from(arrayBuffer)` in the route handler and held in memory while `uploadStreamToDrive` streams it. For a 4MB file this is borderline on Vercel's 1792 MB memory limit per invocation, but more importantly, if the Drive upload takes > 10s (slow connection), the function times out.

**upload-handler.ts L9**: `maxDuration` is set in `api/jobs/upload/route.ts` (60s) but not visible from the route handler file directly. ✅ Actually this one is fine.

---

## 🟡 BUG 10: `upload_state` on initiate is set to `'uploading'` but should be `'pending'`

**Severity**: 🟡 Low — state machine violation from the start

**initiate/route.ts L83**: `upload_state: 'uploading'`

The defined state machine is: `pending → reserved → uploading → uploaded → ...`

The file is not yet reserved or uploading at initiate time — the reservation was just created, so the correct initial state is `'reserved'` (or `'uploading'` only after the resumable session starts). Starting at `'uploading'` skips the `'pending'` and `'reserved'` states entirely.

---

## 🔴 BUG 11: Two completely separate upload paths for small files — one is a dead stub

**Severity**: 🔴 Critical — code confusion / double-registration

There are **two** routes that accept small file uploads:
- `POST /api/jobs/upload` → `processUploadJob()` → REAL Drive upload ✅
- `POST /api/files/upload` → `reserveAndUploadFile()` → FAKE placeholder IDs ❌

`UploadModal.tsx` correctly uses `/api/jobs/upload`. But `/api/files/upload` exists as a registered route and is dead code that produces silent corruption if ever called. It should either be removed or fixed to actually call `uploadStreamToDrive`.

---

## Summary Table

| # | Bug | Path | Severity |
|---|---|---|---|
| 1 | `reserveAndUploadFile` stores fake Drive IDs | `/api/files/upload` | 🔴 |
| 2 | Hardcoded placeholder `connected_account_id` | `storage-engine.ts` | 🔴 |
| 3 | `complete` route bypasses state machine (jumps to `'complete'` directly) | `/api/jobs/upload/complete` | 🟡 |
| 4 | No cleanup on `initiate` failure → orphan file_records | `/api/jobs/upload/initiate` | 🔴 |
| 5 | `transitionUploadState` silently succeeds pre-migration | `storage-engine.ts` | 🟡 |
| 6 | `verifyPhysicalObject` still has broad `includes('test')` check | `storage-engine.ts` | 🟡 |
| 7 | Chunked upload: final Drive file ID lost if last chunk body empty | `UploadModal.tsx` + `chunk/route.ts` | 🟡 |
| 8 | `maxDuration` missing on `initiate` and `complete` routes | both routes | 🟡 |
| 9 | `initiate` route sets wrong initial `upload_state` (`'uploading'` not `'pending'`) | `initiate/route.ts` | 🟡 |
| 10 | Dead route `/api/files/upload` stores fake IDs if called | `api/files/upload` | 🔴 |

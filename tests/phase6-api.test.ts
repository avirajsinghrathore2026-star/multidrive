/**
 * MultiDrive Phase 6 Acceptance Test Suite & Validation Matrix
 * Tests Zod Schema validation, standardized response envelopes, fail-fast authorization checks, and rate-limiting sliding windows.
 */

import {
  UploadJobSchema,
  MigrationJobSchema,
  DeleteJobSchema,
  ArchiveJobSchema,
  CreateFolderSchema,
  ShareLinkSchema,
  BatchOperationSchema,
} from '../src/lib/schemas/api-schemas';
import { successResponse, errorResponse, handleApiError, checkRateLimit } from '../src/lib/api-utils';
import { ZodError } from 'zod';
import { AuthError } from '../src/lib/auth';
import fs from 'fs';
import path from 'path';

interface TestResult {
  id: string;
  description: string;
  result: 'pass' | 'fail';
  details?: string;
}

const testResults: TestResult[] = [];

function recordTest(id: string, description: string, pass: boolean, details?: string) {
  const result: TestResult['result'] = pass ? 'pass' : 'fail';
  testResults.push({ id, description, result, details });
  const icon = pass ? '  ✓ PASS:' : '  ✗ FAIL:';
  console.log(`${icon} [${id}] ${description} ${details ? `(${details})` : ''}`);
}

async function runPhase6Tests() {
  console.log('\n🛡️ Starting MultiDrive Phase 6 API, Validation & Security Test Suite...\n');

  // ---------------------------------------------------------------------------
  // 1. Zod Input Validation Unit Tests
  // ---------------------------------------------------------------------------

  // Test 1: UploadJobSchema validation
  const validUpload = UploadJobSchema.safeParse({ sizeBytes: 1024, idempotencyKey: 'idemp-1' });
  const invalidUpload = UploadJobSchema.safeParse({ sizeBytes: -100 });
  recordTest(
    'zod-upload-job-validation',
    'UploadJobSchema rejects negative sizeBytes and validates positive integer',
    validUpload.success && !invalidUpload.success,
    `Valid: ${validUpload.success}, Invalid Rejected: ${!invalidUpload.success}`
  );

  // Test 2: MigrationJobSchema validation
  const validMigration = MigrationJobSchema.safeParse({
    fileId: '11111111-1111-1111-1111-111111111111',
    destinationAccountId: '22222222-2222-2222-2222-222222222222',
  });
  const invalidMigration = MigrationJobSchema.safeParse({
    fileId: 'not-a-uuid',
    destinationAccountId: '22222222-2222-2222-2222-222222222222',
  });
  recordTest(
    'zod-migration-job-validation',
    'MigrationJobSchema enforces valid UUID format on fileId and destinationAccountId',
    validMigration.success && !invalidMigration.success,
    `Valid UUID: ${validMigration.success}, Bad UUID Rejected: ${!invalidMigration.success}`
  );

  // Test 3: DeleteJobSchema validation
  const validDelete = DeleteJobSchema.safeParse({ fileId: '33333333-3333-3333-3333-333333333333' });
  const invalidDelete = DeleteJobSchema.safeParse({ fileId: 'invalid-id' });
  recordTest(
    'zod-delete-job-validation',
    'DeleteJobSchema rejects non-UUID fileId',
    validDelete.success && !invalidDelete.success,
    `Valid: ${validDelete.success}, Invalid Rejected: ${!invalidDelete.success}`
  );

  // Test 4: ArchiveJobSchema validation
  const validArchive = ArchiveJobSchema.safeParse({ fileIds: ['44444444-4444-4444-4444-444444444444'] });
  const invalidArchive = ArchiveJobSchema.safeParse({ fileIds: [] });
  recordTest(
    'zod-archive-job-validation',
    'ArchiveJobSchema rejects empty fileIds array',
    validArchive.success && !invalidArchive.success,
    `Valid Array: ${validArchive.success}, Empty Array Rejected: ${!invalidArchive.success}`
  );

  // Test 5: CreateFolderSchema validation
  const validFolder = CreateFolderSchema.safeParse({ name: 'Documents' });
  const invalidFolder = CreateFolderSchema.safeParse({ name: '' });
  recordTest(
    'zod-create-folder-validation',
    'CreateFolderSchema rejects empty string folder name',
    validFolder.success && !invalidFolder.success,
    `Valid Name: ${validFolder.success}, Empty Name Rejected: ${!invalidFolder.success}`
  );

  // Test 6: ShareLinkSchema validation
  const validShare = ShareLinkSchema.safeParse({ fileId: '55555555-5555-5555-5555-555555555555', expiresInHours: 24 });
  const invalidShare = ShareLinkSchema.safeParse({ fileId: '55555555-5555-5555-5555-555555555555', expiresInHours: -5 });
  recordTest(
    'zod-share-link-validation',
    'ShareLinkSchema rejects negative expiration hours',
    validShare.success && !invalidShare.success,
    `Valid Expiry: ${validShare.success}, Negative Expiry Rejected: ${!invalidShare.success}`
  );

  // Test 7: BatchOperationSchema validation
  const validBatch = BatchOperationSchema.safeParse({ action: 'delete', fileIds: ['66666666-6666-6666-6666-666666666666'] });
  const invalidBatch = BatchOperationSchema.safeParse({ action: 'invalid_action' as any, fileIds: ['66666666-6666-6666-6666-666666666666'] });
  recordTest(
    'zod-batch-operation-validation',
    'BatchOperationSchema rejects unsupported batch action enum values',
    validBatch.success && !invalidBatch.success,
    `Valid Enum: ${validBatch.success}, Bad Enum Rejected: ${!invalidBatch.success}`
  );

  // ---------------------------------------------------------------------------
  // 2. Standardized Response Envelope & Error Handling Tests
  // ---------------------------------------------------------------------------

  // Test 8: Success Response Wrapper
  const successRes = successResponse({ id: 'job-123', status: 'COMPLETED' }, 200);
  const successJson = await successRes.json();
  const isSuccessEnvelopeValid = successRes.status === 200 && successJson.data && successJson.data.id === 'job-123';
  recordTest(
    'api-success-envelope-structure',
    'successResponse wraps payload in { data: ... } with status 200',
    isSuccessEnvelopeValid,
    `Data Key Present: ${Boolean(successJson.data)}`
  );

  // Test 9: Error Response Wrapper
  const errorRes = errorResponse('INVALID_ARGUMENT', 'Validation failed', { field: 'sizeBytes' }, 400);
  const errorJson = await errorRes.json();
  const isErrorEnvelopeValid =
    errorRes.status === 400 &&
    errorJson.error &&
    errorJson.error.code === 'INVALID_ARGUMENT' &&
    errorJson.error.details.field === 'sizeBytes';
  recordTest(
    'api-error-envelope-structure',
    'errorResponse formats payload as { error: { code, message, details } } with status 400',
    isErrorEnvelopeValid,
    `Error Code: ${errorJson.error?.code}`
  );

  // Test 10: Global API Error Handler (ZodError)
  const zodErr = UploadJobSchema.safeParse({ sizeBytes: -5 });
  const handledZodRes = handleApiError(zodErr.error!);
  const handledZodJson = await handledZodRes.json();
  const isZodHandledCleanly = handledZodRes.status === 400 && handledZodJson.error.code === 'INVALID_ARGUMENT';
  recordTest(
    'global-error-handler-zod',
    'handleApiError maps ZodError to 400 Bad Request with code INVALID_ARGUMENT',
    isZodHandledCleanly,
    `Status: ${handledZodRes.status}, Code: ${handledZodJson.error?.code}`
  );

  // Test 11: Global API Error Handler (AuthError)
  const authErr = new AuthError('Access denied', 403);
  const handledAuthRes = handleApiError(authErr);
  const handledAuthJson = await handledAuthRes.json();
  const isAuthHandledCleanly = handledAuthRes.status === 403 && handledAuthJson.error.code === 'FORBIDDEN';
  recordTest(
    'global-error-handler-auth',
    'handleApiError maps AuthError(403) to 403 Forbidden with code FORBIDDEN',
    isAuthHandledCleanly,
    `Status: ${handledAuthRes.status}, Code: ${handledAuthJson.error?.code}`
  );

  // ---------------------------------------------------------------------------
  // 3. Sliding-Window Rate Limiting Engine Tests
  // ---------------------------------------------------------------------------

  const rateLimitKey = `test_limit_key_${Date.now()}`;
  const res1 = await checkRateLimit(rateLimitKey, 2, 60);
  const res2 = await checkRateLimit(rateLimitKey, 2, 60);
  const res3 = await checkRateLimit(rateLimitKey, 2, 60);

  const isRateLimitEnforced = res1.allowed && res2.allowed && !res3.allowed && res3.remaining === 0;
  recordTest(
    'rate-limit-sliding-window',
    'checkRateLimit permits requests up to max capacity (2) and blocks excess (3rd request) with 429 status',
    isRateLimitEnforced,
    `Req1 Allowed: ${res1.allowed}, Req2 Allowed: ${res2.allowed}, Req3 Blocked: ${!res3.allowed}`
  );

  // ---------------------------------------------------------------------------
  // Summary & Machine-Readable Matrix Export
  // ---------------------------------------------------------------------------

  const passedCount = testResults.filter((t) => t.result === 'pass').length;
  const failedCount = testResults.filter((t) => t.result === 'fail').length;

  console.log('\n==================================================');
  console.log(`Phase 6 API & Security Suite Summary: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('==================================================\n');

  const matrixOutput = {
    phase: 6,
    timestamp: new Date().toISOString(),
    total_tests: testResults.length,
    passed: passedCount,
    failed: failedCount,
    tests: testResults,
  };

  const matrixDir = path.join(process.cwd(), 'docs', 'active');
  fs.mkdirSync(matrixDir, { recursive: true });
  const matrixPath = path.join(matrixDir, 'phase-6-test-matrix.json');
  fs.writeFileSync(matrixPath, JSON.stringify(matrixOutput, null, 2));

  console.log(`📄 Generated machine-readable matrix: ${matrixPath}\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

runPhase6Tests().catch((err) => {
  console.error('Test runner exception:', err);
  process.exit(1);
});

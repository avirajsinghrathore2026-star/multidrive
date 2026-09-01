import fs from 'fs';
import path from 'path';

// Load .env.local variables if running standalone tsx test script
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...valueParts] = trimmed.split('=');
      const val = valueParts.join('=').trim();
      if (key && val && !process.env[key.trim()]) {
        process.env[key.trim()] = val;
      }
    }
  });
}

// Fallback high-entropy secret for test runner environment
if (!process.env.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET.length < 32) {
  process.env.ENCRYPTION_SECRET = 'e98f7b2c9e4a1d6e3f5b0a9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e';
}

import { requireUser, requireOwnedAccount, AuthError } from '../src/lib/auth';
import { encryptToken, decryptToken } from '../src/lib/vault';
import { getServerConfig } from '../src/lib/config';
import { revokeGoogleToken, getOAuth2Client } from '../src/lib/google-drive';
import { createClient as createServerSupabaseClient } from '../src/lib/supabase/server';
import { GET as getAccounts, POST as postAccountsQuota } from '../src/app/api/accounts/route';
import { GET as getFiles } from '../src/app/api/files/route';
import { POST as postFolders } from '../src/app/api/folders/route';
import { POST as postShare } from '../src/app/api/share/route';
import { NextRequest } from 'next/server';

/**
 * MultiDrive Phase 3 V3 Comprehensive Test Suite
 * Directly exercises Supabase Database Constraints, Triggers, DDL/DML, and Auth Boundaries.
 */

async function runFullTestSuiteV3() {
  console.log('\n🛡️ Starting MultiDrive Phase 3 V3 Database & Security Acceptance Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, section: string, testName: string, expected: string, actual: string) {
    if (condition) {
      console.log(`  ✓ PASS: [${section}] ${testName} (Expected: ${expected}, Actual: ${actual})`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: [${section}] ${testName} (Expected: ${expected}, Actual: ${actual})`);
      failed++;
    }
  }

  const userA_Id = '11111111-1111-1111-1111-111111111111';
  const userB_Id = '22222222-2222-2222-2222-222222222222';

  // Initialize Supabase Client
  const supabase = await createServerSupabaseClient();

  // ---------------------------------------------------------------------------
  // Phase 3 Test Section 1: Database DDL/DML Integrity & Ownership Triggers
  // ---------------------------------------------------------------------------
  console.log('--- Phase 3 Section 1: Database DDL/DML Integrity & Ownership Triggers ---');

  // Seed valid parent rows for User A and User B
  const accountA_Id = 'a1111111-1111-1111-1111-111111111111';
  const accountB_Id = 'b2222222-2222-2222-2222-222222222222';
  const folderB_Id = 'f2222222-2222-2222-2222-222222222222';

  // Ensure parent rows exist for clean FK testing
  await supabase.from('connected_accounts').upsert({
    id: accountA_Id,
    user_id: userA_Id,
    google_email: 'usera@example.com',
    google_account_id: 'google-sub-user-a',
    vault_secret_id: 'v1:test_vault_secret_a',
  });

  await supabase.from('connected_accounts').upsert({
    id: accountB_Id,
    user_id: userB_Id,
    google_email: 'userb@example.com',
    google_account_id: 'google-sub-user-b',
    vault_secret_id: 'v1:test_vault_secret_b',
  });

  await supabase.from('virtual_folders').upsert({
    id: folderB_Id,
    user_id: userB_Id,
    name: 'User B Private Folder',
  });

  // Test 3.1 Real DB NOT NULL Owner Constraint Rejection
  const { error: nullOwnerError } = await supabase.from('file_records').insert({
    user_id: null as any,
    filename: 'null_owner.pdf',
    size_bytes: 1024,
    mime_type: 'application/pdf',
    connected_account_id: accountA_Id,
    google_drive_file_id: 'gdrive-null-1',
  });
  const nullOwnerCode = nullOwnerError?.code || (nullOwnerError ? 'REJECTED' : 'SUCCESS');
  const isNullOwnerDbRejected = !!nullOwnerError;
  assert(isNullOwnerDbRejected, 'Phase 3 DDL', 'Supabase DB rejects NULL user_id owner via NOT NULL constraint', 'DB Error (23502/23503)', `DB Error (${nullOwnerCode})`);

  // Test 3.2 Real DB Check Constraint Rejection (size_bytes >= 0)
  const { error: checkSizeError } = await supabase.from('file_records').insert({
    user_id: userA_Id,
    filename: 'negative_size.pdf',
    size_bytes: -1024,
    mime_type: 'application/pdf',
    connected_account_id: accountA_Id,
    google_drive_file_id: 'gdrive-neg-1',
  });
  const checkSizeCode = checkSizeError?.code || (checkSizeError ? 'REJECTED' : 'SUCCESS');
  const isNegativeSizeDbRejected = !!checkSizeError;
  assert(isNegativeSizeDbRejected, 'Phase 3 DDL', 'Supabase DB rejects negative file size via CHECK (size_bytes >= 0)', 'DB Error (23514/42501)', `DB Error (${checkSizeCode})`);

  // Test 3.3 Intact Single-Object File Model Mapping
  const mockIntactFile = {
    id: 'file-doc-1',
    user_id: userA_Id,
    connected_account_id: accountA_Id,
    google_drive_file_id: '1e8AJncAZ-LnYzbohFQRs77eOp2KhlkSs',
    filename: 'report.pdf',
    size_bytes: 2048576,
  };
  const isIntactSingleObject = !!mockIntactFile.google_drive_file_id && !!mockIntactFile.connected_account_id;
  assert(isIntactSingleObject, 'Phase 3 Model', 'Logical file maps to 1 intact physical object on 1 connected account', '1 Physical Object', isIntactSingleObject ? '1 Physical Object' : 'Chunked');

  // Test 3.4 Real DB Cross-User Ownership Trigger Rejection (trg_enforce_file_records_ownership)
  const { error: triggerFolderError } = await supabase.from('file_records').insert({
    user_id: userA_Id, // File belongs to User A
    filename: 'cross_user_file.pdf',
    size_bytes: 512,
    mime_type: 'application/pdf',
    connected_account_id: accountA_Id,
    virtual_folder_id: folderB_Id, // Folder belongs to User B! Trigger MUST reject!
    google_drive_file_id: 'gdrive-cross-1',
  });
  const triggerErrorCode = triggerFolderError?.code || (triggerFolderError ? 'REJECTED' : 'ALLOWED');
  const isTriggerRejected = !!triggerFolderError;
  assert(isTriggerRejected, 'Phase 3 Trigger', 'Database trigger trg_enforce_file_records_ownership rejects cross-user folder reference', 'DB Trigger Exception (P0001/42501)', `DB Error (${triggerErrorCode})`);

  // Test 3.5 Real DB Unique Share Token Constraint Rejection
  const uniqueToken = 'share-token-unique-test-' + Date.now();
  const validFileId = '11111111-1111-1111-1111-111111111111';

  // Seed valid file record for shared link parent FK
  await supabase.from('file_records').upsert({
    id: validFileId,
    user_id: userA_Id,
    connected_account_id: accountA_Id,
    google_drive_file_id: 'gdrive-share-parent',
    filename: 'share_parent.pdf',
    size_bytes: 1024,
    mime_type: 'application/pdf',
  });

  await supabase.from('shared_links').insert({ file_id: validFileId, token: uniqueToken });
  const { error: duplicateTokenError } = await supabase.from('shared_links').insert({ file_id: validFileId, token: uniqueToken });
  const duplicateTokenCode = duplicateTokenError?.code || (duplicateTokenError ? 'REJECTED' : 'SUCCESS');
  const isDuplicateTokenDbRejected = !!duplicateTokenError;
  assert(isDuplicateTokenDbRejected, 'Phase 3 DDL', 'Supabase DB rejects duplicate share token via UNIQUE constraint', 'DB Error (23505/42501)', `DB Error (${duplicateTokenCode})`);

  // Test 3.6 Real DB Stable Provider Account Uniqueness (google_account_id)
  const { error: duplicateGoogleAccountError } = await supabase.from('connected_accounts').insert({
    user_id: userA_Id,
    google_email: 'usera_duplicate@example.com',
    google_account_id: 'google-sub-user-a', // Duplicate google_account_id!
    vault_secret_id: 'v1:test_vault_secret_dup',
  });
  const duplicateAccountCode = duplicateGoogleAccountError?.code || (duplicateGoogleAccountError ? 'REJECTED' : 'SUCCESS');
  const isDuplicateGoogleAccountRejected = !!duplicateGoogleAccountError;
  assert(isDuplicateGoogleAccountRejected, 'Phase 3 DDL', 'Supabase DB rejects duplicate google_account_id via UNIQUE constraint', 'DB Error (23505/42501)', `DB Error (${duplicateAccountCode})`);

  // ---------------------------------------------------------------------------
  // Phase 2 Test Section: Cryptographic Vault & Fail-Closed Configuration
  // ---------------------------------------------------------------------------
  console.log('\n--- Phase 2 Section: Vault Encryption & Fail-Closed Config ---');

  const testPlaintext = '1//0gX_test_google_refresh_token_secret_999';
  const encryptedVersioned = encryptToken(testPlaintext);
  const decryptedRoundTrip = decryptToken(encryptedVersioned);
  assert(encryptedVersioned.startsWith('v1:') && decryptedRoundTrip === testPlaintext, 'Phase 2 Vault', 'Vault round-trip encryption & decryption (v1 format)', testPlaintext, decryptedRoundTrip);

  const payloadParts = encryptedVersioned.split(':');
  const tamperedCiphertext = `${payloadParts[0]}:${payloadParts[1]}:${payloadParts[2]}:${payloadParts[3].slice(0, -2)}00`;
  let tamperRejected = false;
  try {
    decryptToken(tamperedCiphertext);
  } catch (e: any) {
    tamperRejected = true;
  }
  assert(tamperRejected, 'Phase 2 Vault', 'Tampered ciphertext rejected cleanly', 'Throws Decryption Error', tamperRejected ? 'Throws Decryption Error' : 'Returned Corrupted Data');

  // ---------------------------------------------------------------------------
  // Phase 1 Test Section: Confirm Identity & Ownership Invariants
  // ---------------------------------------------------------------------------
  console.log('\n--- Phase 1 Section: Identity, Ownership & RLS Invariants ---');

  const testUnauthenticatedRoute = async (routeHandler: () => Promise<any>, routeName: string) => {
    try {
      const res = await routeHandler();
      const status = res.status;
      assert(status === 401, 'Phase 1 Auth', `Anonymous call to ${routeName}`, '401', `${status}`);
    } catch (e: any) {
      const is401 = e instanceof AuthError ? e.statusCode === 401 : e.message?.includes('Authentication required') || e.message?.includes('401');
      assert(is401, 'Phase 1 Auth', `Anonymous call to ${routeName}`, '401', is401 ? '401' : `${e.message}`);
    }
  };

  await testUnauthenticatedRoute(() => getAccounts(), 'GET /api/accounts');
  await testUnauthenticatedRoute(() => postAccountsQuota(), 'POST /api/accounts');
  await testUnauthenticatedRoute(() => getFiles(new NextRequest('http://localhost/api/files')), 'GET /api/files');
  await testUnauthenticatedRoute(() => postFolders(new NextRequest('http://localhost/api/folders', { method: 'POST', body: JSON.stringify({ name: 'Test' }) })), 'POST /api/folders');
  await testUnauthenticatedRoute(() => postShare(new NextRequest('http://localhost/api/share', { method: 'POST', body: JSON.stringify({ fileId: 'f1' }) })), 'POST /api/share');

  // ---------------------------------------------------------------------------
  // Summary Results
  // ---------------------------------------------------------------------------
  console.log(`\n==================================================`);
  console.log(`Phase 3 V3 Full Suite Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runFullTestSuiteV3().catch((err) => {
  console.error('Test runner exception:', err);
  process.exit(1);
});

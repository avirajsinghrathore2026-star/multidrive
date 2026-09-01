# Phase 6 — API, Validation, Authorization & Performance

## 1. Objective
Transform the Next.js API route handlers into a production-grade interface. Implement strict input validation, standardize error responses, enforce application-level authorization (in addition to existing RLS), and introduce basic rate-limiting strategies to protect the Phase 5 job engine from abuse.

## 2. Context
Currently, the `/api/*` endpoints parse arbitrary JSON and lack a unified error-handling strategy. Before we build the frontend UX (Phase 7), the API must predictably return standardized `400 Bad Request` errors for invalid inputs and `403 Forbidden` for unauthorized cross-tenant actions, rather than crashing or throwing unhandled 500 errors. 

## 3. Files / Modules to Inspect
*   `src/app/api/**/*.ts` (All route handlers)
*   `src/lib/auth.ts` (Authentication utilities)
*   `package.json`

## 4. Exact Problems to Fix
*   Arbitrary `await request.json()` without type safety or schema validation.
*   Inconsistent error response shapes (e.g., some returning strings, some returning objects).
*   Missing explicit ownership/authorization checks at the API level (relying solely on Postgres RLS is good for defense-in-depth, but the API should fail fast and cleanly).
*   Lack of rate-limiting on expensive endpoints (like triggering migrations or uploads).

## 5. Implementation Requirements
*   **Validation Layer:** Install and configure `zod`.
*   **Request Schemas:** Create a strict Zod schema for the request body and query parameters of *every* POST, PUT, and PATCH endpoint.
*   **Standardized Wrapper:** Create a utility (e.g., `src/lib/api-utils.ts`) that standardizes API responses.
    *   Success: `{ data: ... }`
    *   Error: `{ error: { code: string, message: string, details?: any } }`
*   **API Refactoring:** Rewrite all endpoints in `src/app/api/` to use the validation schemas and the standardized response wrapper.
*   **Rate Limiting Strategy:** Implement a basic rate-limiting utility. Implement a simple sliding-window rate limiter using Supabase/Postgres (e.g., a lightweight `api_rate_limits` table) OR an in-memory Map (if running in a long-lived Node process). *Note: Keep it simple; the goal is protection against basic spam, not distributed DDoS mitigation.*

## 6. Database Requirements
*   **No changes to core tables.** 
*   If a rate-limiting table is added, create it via a new migration file: `supabase/migrations/phase6_api_security.sql`.

## 7. Security Requirements
*   **Authentication Check:** Every private endpoint must explicitly verify the user's session before parsing the body.
*   **Authorization Check:** Endpoints interacting with specific `file_record_id`s or `job_id`s must verify the authenticated user owns that ID *before* dispatching commands to the job engine.
*   **Error Masking:** Do not leak database constraint error messages directly to the client. Map them to generic `403` or `404` errors.

## 8. Backwards-Compatibility Considerations
*   The API payload structures for existing tests (`tests/phase5-jobs.test.ts`) must not change unless absolutely necessary to comply with standard JSON formatting. If they do change, you must update the test files to match.

## 9. Tests to Write
*   **Validation Tests:** Write unit tests for the new Zod schemas ensuring valid payloads pass and invalid ones fail with detailed errors.
*   **Authorization Tests:** Write integration tests specifically attempting to access API endpoints using a different user's mocked session token to ensure `403 Forbidden` is returned.

## 10. Tests to Run
*   Execute your new tests.
*   Execute the existing `tests/phase5-jobs.test.ts` to guarantee the API refactoring did not break the underlying job engine.

## 11. Acceptance Criteria
1.  All POST/PUT/PATCH routes use Zod for validation.
2.  Invalid payloads return `400 Bad Request` with a Zod error trace in the `details` field.
3.  Unauthenticated requests return `401 Unauthorized`.
4.  Cross-tenant access attempts return `403 Forbidden` or `404 Not Found`.
5.  All API responses wrap their payloads in a `{ data: ... }` object.
6.  The Phase 5 Job Engine tests still pass with 100% success.

## 12. Things Explicitly NOT to Touch Yet
*   **Frontend Components:** DO NOT touch `src/components/`, `src/app/page.tsx`, or any `.tsx` UI files. We are strictly isolating this phase to the API layer.
*   **Core Job Engine:** DO NOT modify the logic in `src/lib/jobs/`. That code is verified and locked.

## 13. Required Final Report From Antigravity
Generate `docs/active/REPORT-PHASE-6.md` containing:
*   Summary of changes.
*   List of endpoints refactored.
*   Explanation of the chosen rate-limiting strategy.
*   Test execution results.
*   Any deviations or decisions made.

## 14. STOP CONDITION
After generating the report and updating `docs/PROJECT_STATE.md`, export the clean codebase zip and HALT. Do not proceed to Phase 7 until the Architect approves the Phase 6 report.
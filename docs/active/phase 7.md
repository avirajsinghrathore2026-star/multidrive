# Phase 7 — Production Authentication, Routing & UX Shell

## 1. Objective
Implement a production-grade, secure authentication architecture using `@supabase/ssr` and Next.js App Router. Establish a strict routing hierarchy (Marketing vs. Protected Dashboard) and build a polished Authentication UI supporting Google OAuth (PKCE), Email/Password, and Magic Links.

## 2. Context
Currently, the application lacks a secure, cookie-based session strategy and full user authentication flows. We need to implement Edge Middleware to handle session refreshing and route protection. The user should experience a standard SaaS flow: landing on a marketing page (`/`), logging in via a dedicated portal (`/login`), and being seamlessly routed to the protected application (`/dashboard`).

## 3. Files / Modules to Create or Modify
*   `middleware.ts` (Root level)
*   `src/lib/supabase/middleware.ts` (Handles SSR cookie refresh logic)
*   `src/app/api/auth/callback/route.ts` (PKCE exchange handler)
*   `src/app/page.tsx` (Marketing Landing Page)
*   `src/app/(auth)/login/page.tsx` (Auth Portal)
*   `src/app/(app)/dashboard/page.tsx` (Protected Application Root)
*   `src/app/layout.tsx`
*   `src/components/AuthModal.tsx`

## 4. Implementation Requirements

### A. Core Supabase SSR Utilities
*   Ensure `src/lib/supabase/server.ts` and `src/lib/supabase/client.ts` correctly implement the `@supabase/ssr` patterns for the Next.js App Router.
*   Create `src/lib/supabase/middleware.ts` containing the `updateSession` logic to refresh tokens and set updated cookies on requests and responses.

### B. Next.js Middleware (`middleware.ts`)
*   Create `middleware.ts` at the root of the project.
*   **Route Protection:** Intercept all requests. If an unauthenticated user attempts to access `/dashboard` or protected API endpoints, redirect them to `/login?next=/dashboard`.
*   **Auth Redirection:** If an authenticated user navigates to `/login`, redirect them to `/dashboard`.
*   **Matcher:** Exclude static assets, `_next`, favicon, and public images from middleware evaluation.

### C. The PKCE OAuth Callback (`src/app/api/auth/callback/route.ts`)
*   Implement the GET handler in `src/app/api/auth/callback/route.ts`.
*   Extract the `code` and `next` URL search parameters.
*   Call `supabase.auth.exchangeCodeForSession(code)` on the server Supabase client.
*   Redirect the user to the requested `next` path (defaulting to `/dashboard`).

### D. The Marketing Landing Page (`src/app/page.tsx`)
*   Build a clean landing page explaining Multi Drive (aggregate storage pooling, fault-tolerant operations, zero data loss).
*   Check the active user session on the server.
*   **Unauthenticated State:** Render a primary "Get Started" / "Log In" button routing to `/login`.
*   **Authenticated State:** Render a primary "Go to Dashboard" button routing to `/dashboard`.

### E. The Auth Portal (`src/app/(auth)/login/page.tsx`)
*   Build a centered login card UI.
*   **Primary Action:** A prominent "Sign in with Google" button utilizing `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${origin}/api/auth/callback` } })`.
*   **Secondary Actions:** Dedicated tabs or sections for:
    *   **Email & Password Login / Sign Up**
    *   **Passwordless Magic Link (OTP)**
*   Implement explicit loading indicators during authentication requests.
*   Handle and display error notifications (e.g., OAuth cancellation, invalid credentials, rate limits).

## 5. Security Requirements
*   **Secret Protection:** The `SUPABASE_SERVICE_ROLE_KEY` must remain strictly server-side and never be exposed in client bundles or public environment variables.
*   **Cookie Synchronization:** Ensure cookie modifications performed in `middleware.ts` are applied to both request and response objects to prevent desynchronized auth states.
*   **Sanitization:** Validate and sanitize all user input fields (email, password) before submission using client-side checks and Zod schemas where applicable.

## 6. Backwards-Compatibility Considerations
*   Do not alter the database schema (`supabase/schema.sql`) or the verified background job engine in `src/lib/jobs/`.
*   Migrate existing dashboard mockups and file browser components from `src/app/page.tsx` into `src/app/(app)/dashboard/page.tsx`.

## 7. Verification & Manual Checklist
*   [ ] Unauthenticated request to `/dashboard` redirects to `/login?next=/dashboard`.
*   [ ] "Sign in with Google" button initiates OAuth and returns successfully to `/dashboard`.
*   [ ] Email/password registration and login authenticate and set session cookies.
*   [ ] Magic link request successfully dispatches email.
*   [ ] Authenticated user visiting `/login` is automatically redirected to `/dashboard`.
*   [ ] Authenticated user visiting `/` sees the "Go to Dashboard" call to action.
*   [ ] User logout clears session cookies and returns user to `/`.

## 8. Required Final Report From Antigravity
Generate `docs/active/REPORT-PHASE-7.md` containing:
*   Summary of Next.js middleware and SSR session handling.
*   Confirmation of Google OAuth PKCE callback execution.
*   Overview of the new Auth portal UI and routing structure.
*   Results of the manual verification checklist.

## 9. STOP CONDITION
After completing implementation, generating the report, and updating `docs/PROJECT_STATE.md`, export the clean codebase zip also from now on give the zip in active  and HALT. Await the Architect review before proceeding to Phase 8.
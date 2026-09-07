# 📐 MultiDrive Architecture & System Design Specification

This document details the complete end-to-end architecture, data flows, security boundaries, and database entity relationships for **MultiDrive** — a unified multi-cloud storage aggregator with atomic capacity allocation and zero-fragmentation storage paradigm.

---

## 📑 Table of Contents

1. [High-Level System Architecture](#1-high-level-system-architecture)
2. [Security & Vault Architecture](#2-security--vault-architecture)
3. [Authentication & Session Flow](#3-authentication--session-flow)
4. [Storage Engine & Capacity Selection](#4-storage-engine--capacity-selection)
5. [Upload & File Lifecycle State Machine](#5-upload--file-lifecycle-state-machine)
6. [Asynchronous Background Job Engine](#6-asynchronous-background-job-engine)
7. [Database Schema & Entity Relationship Diagram (ERD)](#7-database-schema--entity-relationship-diagram-erd)
8. [API & Security Boundary Matrix](#8-api--security-boundary-matrix)

---

## 1. High-Level System Architecture

MultiDrive aggregates multiple third-party cloud storage accounts (e.g. Google Drive, OneDrive, Dropbox) into a single virtual filesystem. It enforces a strict **1:1 logical-to-physical object mapping** (no file splitting or chunk metadata overhead) and balances uploads dynamically based on real-time account capacity.

```mermaid
flowchart TB
    subgraph ClientLayer ["Client Layer (Browser)"]
        UI["React 19 Frontend (Next.js 16 App Router)"]
        Landing["Marketing Landing Page (/)"]
        AuthUI["Auth Portal (/login)"]
        DashUI["Protected Dashboard (/dashboard)"]
        UploadModal["Streaming Upload Engine (UploadModal)"]
    end

    subgraph EdgeLayer ["Edge & Routing Layer"]
        Middleware["Next.js Edge Middleware (middleware.ts)\n• SSR Cookie Session Refresh\n• Route Protection & Redirects"]
    end

    subgraph AppServer ["Next.js App Server (API & Core Engine)"]
        API_Routes["API Gateway (/api/*)\n• Zod Schema Validation\n• Standardized JSON Envelope\n• Rate Limiter Engine"]
        
        subgraph CoreServices ["Core Services Layer"]
            AuthService["Auth & Token Manager\n(src/lib/auth.ts)"]
            VaultModule["Crypto Vault (AES-256-GCM)\n(src/lib/vault.ts)"]
            StorageEngine["Storage Allocation Engine\n(src/lib/storage-engine.ts)"]
            JobEngine["Resumable Job Engine\n(src/lib/job-engine.ts)"]
            GDriveClient["Google Drive API Client\n(src/lib/google-drive.ts)"]
        end
    end

    subgraph DataLayer ["Supabase PostgreSQL (Database & RLS)"]
        RLS["Row Level Security (RLS) & DB Triggers"]
        PG_Procs["Atomic Stored Procedures\n(create_storage_reservation_atomic)"]
        Tables[("PostgreSQL Tables\n• users\n• connected_accounts\n• virtual_folders\n• file_records\n• storage_reservations\n• background_jobs")]
    end

    subgraph CloudStorage ["Physical Storage Layer (Multi-Account Providers)"]
        Drive1["Google Drive Account #1 (15 GB)"]
        Drive2["Google Drive Account #2 (15 GB)"]
        DriveN["Google Drive Account #N (15 GB)"]
    end

    %% Connections
    UI --> Middleware
    Middleware --> API_Routes
    UploadModal -->|Stream Chunks / Payload| API_Routes
    
    API_Routes --> AuthService
    API_Routes --> StorageEngine
    API_Routes --> JobEngine
    
    AuthService <--> VaultModule
    StorageEngine --> GDriveClient
    JobEngine --> GDriveClient
    
    AuthService <--> RLS
    StorageEngine <--> PG_Procs
    StorageEngine <--> RLS
    JobEngine <--> RLS
    
    PG_Procs <--> Tables
    RLS <--> Tables
    
    GDriveClient -->|OAuth2 Stream Upload/Download| Drive1
    GDriveClient -->|OAuth2 Stream Upload/Download| Drive2
    GDriveClient -->|OAuth2 Stream Upload/Download| DriveN
```

---

## 2. Security & Vault Architecture

Sensitive OAuth2 refresh tokens and provider secrets are never stored in plaintext. They are encrypted using authenticated **AES-256-GCM** with a dynamic 12-byte initialization vector (IV) and a 16-byte authentication tag.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant App as Next.js API (/api/auth/google/callback)
    participant Vault as Vault Engine (src/lib/vault.ts)
    participant DB as Supabase DB (connected_accounts)

    Note over User,App: OAuth 2.0 PKCE Code Exchange
    User->>App: Google OAuth redirect with Auth Code
    App->>App: Exchange code for Access & Refresh Tokens
    
    Note over App,Vault: Authenticated AES-256-GCM Encryption
    App->>Vault: encryptToken(plaintextRefreshToken)
    Vault->>Vault: Derive 256-bit key from ENCRYPTION_SECRET (SHA-256)
    Vault->>Vault: Generate 12-byte random IV
    Vault->>Vault: Encrypt text & compute 16-byte GCM AuthTag
    Vault-->>App: Return versioned string "v1:iv:authTag:ciphertext"
    
    App->>DB: Store encrypted string in connected_accounts.access_token / refresh_token
    DB-->>App: Confirmed (Stored securely)

    Note over App,DB: Decryption on Demand (Upload/Download)
    App->>DB: Query connected_account tokens (RLS enforced)
    DB-->>App: Returns "v1:iv:authTag:ciphertext"
    App->>Vault: decryptToken(payload)
    Vault->>Vault: Parse IV + AuthTag + Ciphertext
    Vault->>Vault: Decipher with integrity check (GCM AuthTag verification)
    alt Verification Successful
        Vault-->>App: Returns plaintext Refresh Token
    else Tampering Detected or Invalid Secret
        Vault-->>App: Throws "Vault decryption failed" (Fail closed)
    end
```

---

## 3. Authentication & Session Flow

MultiDrive leverages `@supabase/ssr` with HttpOnly cookies, validated across both Edge Middleware and API routes.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Browser
    participant MW as Edge Middleware (middleware.ts)
    participant AuthAPI as Auth Handler (/api/auth/*)
    participant SupaAuth as Supabase Auth Server
    participant DB as Supabase DB

    Client->>AuthAPI: POST /api/auth/login or Google OAuth PKCE
    AuthAPI->>SupaAuth: Authenticate Credentials / Token Exchange
    SupaAuth-->>AuthAPI: Issue JWT & Refresh Token
    AuthAPI-->>Client: Set Secure HttpOnly Cookies (sb-access-token, sb-refresh-token)

    Note over Client,MW: Subsequent Page / API Request
    Client->>MW: Request /dashboard or /api/files (with Cookies)
    MW->>SupaAuth: createServerClient() -> getUser()
    alt Session Valid & Active
        MW->>MW: Refresh token if nearing expiration
        MW-->>Client: Allow request to proceed (Pass to Route Handler)
    else Session Expired / Missing
        MW-->>Client: Redirect to /login?redirectedFrom=...
    end
```

---

## 4. Storage Engine & Capacity Selection

To prevent race conditions and quota over-subscriptions during concurrent uploads, MultiDrive implements an **Atomic Capacity Selection & Reservation** system using Postgres row-level locks (`FOR UPDATE`).

```mermaid
sequenceDiagram
    autonumber
    actor Client as User / Upload Modal
    participant API as Upload API (/api/files/upload)
    participant SE as Storage Engine (src/lib/storage-engine.ts)
    participant DB as Postgres Procedure (create_storage_reservation_atomic)
    participant Provider as Google Drive API

    Client->>API: POST /api/files/upload (fileName, fileSize, parentFolderId)
    API->>SE: createReservationLease(userId, fileRecordId, fileSizeBytes)
    
    rect rgb(240, 248, 255)
        Note over SE,DB: Atomic Capacity Selection in Postgres
        SE->>DB: CALL create_storage_reservation_atomic()
        DB->>DB: SELECT * FROM connected_accounts WHERE user_id = $1 FOR UPDATE
        DB->>DB: Calculate Real Free Space:\n(total_capacity - used_capacity - active_reserved_capacity)
        DB->>DB: Pick connected_account with MAX(available_space) >= fileSizeBytes
        alt Capacity Available
            DB->>DB: Insert into storage_reservations (TTL = 15 mins)
            DB->>DB: Insert file_records (upload_state = 'reserved')
            DB-->>SE: Returns { account_id, reservation_id }
        else No Account has sufficient space
            DB-->>SE: Error: INSUFFICIENT_STORAGE
            SE-->>API: 400 Insufficient aggregated storage
        end
    end

    SE->>Provider: Stream file content to selected Google Drive account
    Provider-->>SE: Upload complete (fileId, md5Checksum, size)
    
    SE->>SE: verifyPhysicalObject(expectedSize, actualSize, checksum)
    SE->>DB: Transition file_records -> 'complete'
    SE->>DB: Release storage_reservation & increment connected_accounts.used_capacity
    SE-->>API: File record created successfully
    API-->>Client: 201 Created { file: ... }
```

---

## 5. Upload & File Lifecycle State Machine

Each file upload is strictly governed by a deterministic state machine (§5.1). Illegal state jumps are rejected immediately to prevent orphaned or partially written files.

```mermaid
stateDiagram-v2
    [*] --> pending : File upload initiated
    pending --> reserved : Atomic lease created (TTL 15m)
    pending --> rejected : Insufficient space or policy failure
    pending --> failed : Initialization error

    reserved --> uploading : Binary stream active
    reserved --> failed : Network / Lease timeout
    reserved --> rejected : Validation error

    uploading --> uploaded : Stream fully transmitted to provider
    uploading --> failed : Connection dropped / Aborted

    uploaded --> verified : Size & MD5 checksum verified
    uploaded --> failed : Integrity check failed
    uploaded --> orphaned : Incomplete payload detected

    verified --> committed : DB record metadata synced
    verified --> failed : DB sync error
    verified --> orphaned : Storage node unreachable

    committed --> complete : Finalized & available in UI
    committed --> failed : Post-commit hook failure

    complete --> [*] : Terminal Success
    failed --> reserved : Retryable (Backoff)
    failed --> rejected : Max retries exhausted
    rejected --> [*] : Terminal Failure
    orphaned --> [*] : Swept by GC Job
```

---

## 6. Asynchronous Background Job Engine

Heavy operations (large cross-account migrations, bulk deletions, zip archiving, and periodic reconciliation sweeps) run asynchronously via a robust, leasing-based job queue.

```mermaid
flowchart TD
    subgraph JobQueue ["Job Queue Tables (Supabase DB)"]
        UJ["upload_jobs"]
        MJ["migration_jobs"]
        DJ["delete_jobs"]
        AJ["archive_jobs"]
    end

    subgraph JobEngineRuntime ["Job Engine Worker (src/lib/job-engine.ts)"]
        Worker["Job Runner / Worker Loop"]
        LeaseLock["Atomic Lease Lock\n(acquireJobLease: FOR UPDATE SKIP LOCKED)"]
        StateValidator["State Machine Validator\n(PENDING -> RUNNING -> VERIFYING -> COMPLETED)"]
        RetryLogic["Exponential Backoff with Jitter\n(attempt_count, max_retries)"]
    end

    subgraph Handlers ["Dedicated Job Handlers"]
        H_Migrate["Cross-Account Migration Handler\n(Enforces Rule §8.1: Stream -> Verify -> Delete Old)"]
        H_Delete["Cascade Delete & Provider Purge Handler"]
        H_Archive["Streaming Zip Aggregator Handler"]
        H_Reconcile["Garbage Collector & Orphan Sweep Handler"]
    end

    Worker --> LeaseLock
    LeaseLock <--> JobQueue
    LeaseLock --> StateValidator
    StateValidator --> Handlers
    
    Handlers --> H_Migrate
    Handlers --> H_Delete
    Handlers --> H_Archive
    Handlers --> H_Reconcile
    
    Handlers -.->|On Failure| RetryLogic
    RetryLogic --> JobQueue
```

---

## 7. Database Schema & Entity Relationship Diagram (ERD)

```mermaid
erDiagram
    users ||--o{ connected_accounts : "owns"
    users ||--o{ virtual_folders : "owns"
    users ||--o{ file_records : "owns"
    users ||--o{ storage_reservations : "reserves"
    users ||--o{ upload_jobs : "triggers"
    users ||--o{ migration_jobs : "triggers"
    users ||--o{ file_shares : "creates"

    connected_accounts ||--o{ file_records : "physically stores"
    connected_accounts ||--o{ storage_reservations : "locks quota on"
    
    virtual_folders ||--o{ virtual_folders : "parent/child nesting"
    virtual_folders ||--o{ file_records : "contains"

    file_records ||--o{ storage_reservations : "binds to"
    file_records ||--o{ file_shares : "shared via"

    users {
        uuid id PK
        string email
        timestamp created_at
    }

    connected_accounts {
        uuid id PK
        uuid user_id FK
        string provider "google_drive | onedrive | dropbox"
        string email
        string encrypted_access_token "v1:iv:tag:cipher"
        string encrypted_refresh_token "v1:iv:tag:cipher"
        bigint total_capacity_bytes
        bigint used_capacity_bytes
        string status "active | error | revoked"
        timestamp last_synced_at
    }

    virtual_folders {
        uuid id PK
        uuid user_id FK
        uuid parent_id FK
        string name
        string path
        boolean is_deleted
        timestamp created_at
    }

    file_records {
        uuid id PK
        uuid user_id FK
        uuid folder_id FK
        uuid account_id FK
        string name
        bigint size_bytes
        string mime_type
        string provider_file_id
        string checksum_md5
        string upload_state "pending|reserved|uploading|complete|failed"
        boolean is_deleted
        timestamp created_at
        timestamp updated_at
    }

    storage_reservations {
        uuid id PK
        uuid user_id FK
        uuid account_id FK
        uuid file_record_id FK
        bigint reserved_bytes
        string idempotency_key
        timestamp expires_at
        string status "active | committed | released | expired"
    }

    migration_jobs {
        uuid id PK
        uuid user_id FK
        uuid file_record_id FK
        uuid source_account_id FK
        uuid target_account_id FK
        string state "pending | running | verifying | completed | failed"
        int retry_count
        timestamp locked_until
    }

    file_shares {
        uuid id PK
        uuid file_id FK
        uuid user_id FK
        string share_token
        string access_level "view | download"
        timestamp expires_at
    }
```

---

## 8. API & Security Boundary Matrix

| Component / Layer | Access Method | Security & Authorization Policy |
| :--- | :--- | :--- |
| **Frontend UI Pages** | Next.js Server Components / SSR | Edge Middleware checks Supabase session cookies; redirects unauthenticated users to `/login`. |
| **Public API Endpoints** | `GET /api/share/[token]` | Rate-limited public token lookup with expiration and access-level checks. |
| **Protected API Endpoints** | `/api/files/*`, `/api/folders/*`, `/api/accounts/*` | SSR Cookie Auth + Zod Request Validation + Application-level ownership checks (`user_id = auth.uid()`). |
| **Service Role Boundary** | `src/lib/supabase/server.ts` (Admin Client) | Restricted strictly to background tasks, atomic stored procedure invocations, and system reconciliation sweeps. |
| **Database Tables** | Supabase PostgreSQL | Protected by **Row Level Security (RLS)** ensuring users cannot query or mutate records belonging to other `auth.uid()`s. |
| **Provider OAuth Tokens** | Database `connected_accounts` | Stored exclusively as **AES-256-GCM** versioned ciphertexts. Decrypted only in memory during active API requests. |

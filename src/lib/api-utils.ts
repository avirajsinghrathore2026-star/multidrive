import { NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { AuthError } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/server';

export interface ApiSuccessEnvelope<T = any> {
  data: T;
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  details?: any;
}

export interface ApiErrorEnvelope {
  error: ApiErrorDetail;
}

// In-memory fallback rate-limiting cache
const memoryRateLimitMap = new Map<string, { count: number; windowStart: number }>();

/**
 * Standardized API Success Response Wrapper (§5)
 * Returns { data: payload }
 */
export function successResponse<T>(data: T, status: number = 200): NextResponse<ApiSuccessEnvelope<T>> {
  return NextResponse.json({ data }, { status });
}

/**
 * Standardized API Error Response Wrapper (§5)
 * Returns { error: { code, message, details } }
 */
export function errorResponse(
  code: string,
  message: string,
  details?: any,
  status: number = 400
): NextResponse<ApiErrorEnvelope> {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
    { status }
  );
}

/**
 * Sliding Window Rate Limiter Utility (§5, §7)
 * Limits expensive endpoint abuse (e.g. 10 requests / 60 sec per user/key)
 */
export async function checkRateLimit(
  key: string,
  limit: number = 20,
  windowSeconds: number = 60
): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const currentWindowIso = new Date(Math.floor(now / windowMs) * windowMs).toISOString();

  try {
    const admin = await createAdminClient();
    const { data: record, error } = await admin
      .from('api_rate_limits')
      .select('*')
      .eq('key', key)
      .eq('window_start', currentWindowIso)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    const currentCount = record ? record.request_count : 0;

    if (currentCount >= limit) {
      const resetSeconds = Math.ceil((Math.floor(now / windowMs) * windowMs + windowMs - now) / 1000);
      return { allowed: false, remaining: 0, resetSeconds };
    }

    await admin.from('api_rate_limits').upsert(
      {
        key,
        window_start: currentWindowIso,
        request_count: currentCount + 1,
      },
      { onConflict: 'key,window_start' }
    );

    return {
      allowed: true,
      remaining: limit - (currentCount + 1),
      resetSeconds: Math.ceil((Math.floor(now / windowMs) * windowMs + windowMs - now) / 1000),
    };
  } catch (dbErr) {
    // In-memory fallback if rate limit DB table unavailable in test runner
    const memRecord = memoryRateLimitMap.get(key);
    const windowStartMs = Math.floor(now / windowMs) * windowMs;

    if (!memRecord || memRecord.windowStart !== windowStartMs) {
      memoryRateLimitMap.set(key, { count: 1, windowStart: windowStartMs });
      return { allowed: true, remaining: limit - 1, resetSeconds: windowSeconds };
    }

    if (memRecord.count >= limit) {
      const resetSeconds = Math.ceil((windowStartMs + windowMs - now) / 1000);
      return { allowed: false, remaining: 0, resetSeconds };
    }

    memRecord.count++;
    return {
      allowed: true,
      remaining: limit - memRecord.count,
      resetSeconds: Math.ceil((windowStartMs + windowMs - now) / 1000),
    };
  }
}

/**
 * Validates request JSON body against a Zod schema (§5)
 * Throws ZodError if invalid
 */
export async function parseAndValidateJson<T>(request: Request, schema: z.ZodSchema<T>): Promise<T> {
  let bodyJson: any;
  try {
    bodyJson = await request.json();
  } catch (parseErr) {
    throw new Error('INVALID_JSON: Request body contains malformed JSON');
  }

  const result = schema.safeParse(bodyJson);
  if (!result.success) {
    throw result.error;
  }

  return result.data;
}

/**
 * Global API Error Handler (§5, §7)
 * Maps ZodError, AuthError, and Database errors to clean standardized response envelopes.
 */
export function handleApiError(err: any): NextResponse<ApiErrorEnvelope> {
  if (err instanceof ZodError) {
    const flattened = err.flatten();
    return errorResponse('INVALID_ARGUMENT', 'Input payload validation failed', flattened, 400);
  }

  if (err instanceof AuthError) {
    return errorResponse(
      err.statusCode === 401 ? 'UNAUTHORIZED' : err.statusCode === 403 ? 'FORBIDDEN' : 'NOT_FOUND',
      err.message,
      undefined,
      err.statusCode
    );
  }

  if (err.message === 'INVALID_JSON: Request body contains malformed JSON') {
    return errorResponse('INVALID_ARGUMENT', 'Request body contains malformed JSON', undefined, 400);
  }

  if (err.message?.startsWith('ILLEGAL_JOB_TRANSITION')) {
    return errorResponse('ILLEGAL_JOB_TRANSITION', err.message, undefined, 400);
  }

  if (err.message?.startsWith('CANCELLATION_REJECTED')) {
    return errorResponse('CANCELLATION_REJECTED', err.message, undefined, 400);
  }

  // Mask internal database/system traces (§7)
  console.error('[api-utils] Unhandled API error:', err);
  const userMessage = process.env.NODE_ENV === 'development' ? err.message || 'Internal server error' : 'Internal server error';

  return errorResponse('INTERNAL_SERVER_ERROR', userMessage, undefined, 500);
}

-- MultiDrive Phase 6 — API Security & Rate Limiting Migration

-- 1. API Rate Limits Table (Sliding Window Rate Limiter)
CREATE TABLE IF NOT EXISTS api_rate_limits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT NOT NULL, -- Format: "user_id:endpoint" or "ip:endpoint"
  window_start TIMESTAMPTZ NOT NULL,
  request_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_api_rate_limits_key_window UNIQUE (key, window_start)
);

-- Index for fast rate limit window lookups and cleanup sweeps
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_lookup ON api_rate_limits(key, window_start);

-- Enable RLS
ALTER TABLE api_rate_limits ENABLE ROW LEVEL SECURITY;

-- Allow service role full access to rate limiting engine
DROP POLICY IF EXISTS "Allow full service role access to api_rate_limits" ON api_rate_limits;
CREATE POLICY "Allow full service role access to api_rate_limits" ON api_rate_limits
  FOR ALL USING (true);

NOTIFY pgrst, 'reload schema';

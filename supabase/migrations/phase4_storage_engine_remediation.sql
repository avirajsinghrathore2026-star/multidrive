-- Phase 4 Storage Engine Remediation Migration
-- Adds uq_storage_reservations_idempotency_key UNIQUE constraint
-- Adds atomic row-locking capacity selection stored procedure

ALTER TABLE storage_reservations 
  DROP CONSTRAINT IF EXISTS uq_storage_reservations_idempotency_key;

ALTER TABLE storage_reservations 
  ADD CONSTRAINT uq_storage_reservations_idempotency_key UNIQUE (idempotency_key);

CREATE OR REPLACE FUNCTION create_storage_reservation_atomic(
  p_user_id UUID,
  p_file_record_id UUID,
  p_file_size_bytes BIGINT,
  p_idempotency_key TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS JSONB AS $$
DECLARE
  v_existing storage_reservations%ROWTYPE;
  v_account connected_accounts%ROWTYPE;
  v_rec RECORD;
  v_best_account connected_accounts%ROWTYPE;
  v_max_net_bytes BIGINT := -1;
  v_reservation storage_reservations%ROWTYPE;
BEGIN
  -- 1. Check existing active reservation for idempotency key
  SELECT * INTO v_existing
  FROM storage_reservations
  WHERE idempotency_key = p_idempotency_key
    AND released_at IS NULL
    AND expires_at > NOW()
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    SELECT * INTO v_account FROM connected_accounts WHERE id = v_existing.connected_account_id;
    RETURN jsonb_build_object(
      'reservation', to_jsonb(v_existing),
      'account', to_jsonb(v_account),
      'is_reused', true
    );
  END IF;

  -- 2. Lock candidate connected accounts for user to prevent concurrent reservation races
  FOR v_rec IN
    SELECT ca.*,
           (ca.storage_total_bytes - ca.storage_used_bytes) - COALESCE(
             (SELECT SUM(sr.reserved_bytes)
              FROM storage_reservations sr
              WHERE sr.connected_account_id = ca.id
                AND sr.released_at IS NULL
                AND sr.expires_at > NOW()
             ), 0
           ) AS net_available_bytes
    FROM connected_accounts ca
    WHERE ca.user_id = p_user_id
    FOR UPDATE OF ca
  LOOP
    IF v_rec.net_available_bytes > v_max_net_bytes THEN
      v_max_net_bytes := v_rec.net_available_bytes;
      v_best_account.id := v_rec.id;
      v_best_account.user_id := v_rec.user_id;
      v_best_account.google_email := v_rec.google_email;
      v_best_account.vault_secret_id := v_rec.vault_secret_id;
      v_best_account.storage_used_bytes := v_rec.storage_used_bytes;
      v_best_account.storage_total_bytes := v_rec.storage_total_bytes;
    END IF;
  END LOOP;

  IF v_best_account.id IS NULL THEN
    RAISE EXCEPTION 'NO_CONNECTED_ACCOUNTS: No Google Drive accounts found for user %', p_user_id;
  END IF;

  IF v_max_net_bytes < p_file_size_bytes THEN
    RAISE EXCEPTION 'INSUFFICIENT_CAPACITY: File size (% bytes) exceeds available capacity (% bytes)', p_file_size_bytes, v_max_net_bytes;
  END IF;

  -- 3. Atomically insert reservation with ON CONFLICT resolution
  INSERT INTO storage_reservations (
    file_record_id,
    connected_account_id,
    reserved_bytes,
    idempotency_key,
    expires_at
  )
  VALUES (
    p_file_record_id,
    v_best_account.id,
    p_file_size_bytes,
    p_idempotency_key,
    p_expires_at
  )
  ON CONFLICT (idempotency_key) DO UPDATE
    SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING * INTO v_reservation;

  RETURN jsonb_build_object(
    'reservation', to_jsonb(v_reservation),
    'account', to_jsonb(v_best_account),
    'is_reused', false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- API billing identity remains the upstream key. These fields preserve its
-- account source after a key is replaced or removed locally.
ALTER TABLE usage_logs ADD COLUMN source_account_id TEXT;
ALTER TABLE usage_logs ADD COLUMN source_vm_id TEXT;
ALTER TABLE usage_logs ADD COLUMN source_email TEXT;
ALTER TABLE request_attempts ADD COLUMN source_account_id TEXT;
ALTER TABLE request_attempts ADD COLUMN source_vm_id TEXT;
ALTER TABLE request_attempts ADD COLUMN source_email TEXT;
ALTER TABLE request_attempts ADD COLUMN error_code TEXT;
ALTER TABLE request_attempts ADD COLUMN error_message TEXT;

CREATE INDEX idx_usage_logs_source_created ON usage_logs(source_account_id, created_at);
CREATE INDEX idx_request_attempt_source_started ON request_attempts(source_account_id, started_at);

-- Only existing key associations prove historical ownership. A deleted key's
-- account cannot be reconstructed from a slot's present login.
UPDATE usage_logs SET
  source_account_id = k.source_account_id,
  source_vm_id = NULLIF(k.source_vm_id, ''),
  source_email = COALESCE(
    (SELECT NULLIF(a.email, '') FROM accounts a WHERE a.id = k.source_account_id),
    CASE WHEN ep.name LIKE 'OpenAI API · %' THEN NULLIF(TRIM(SUBSTR(ep.name, LENGTH('OpenAI API · ') + 1)), '') END
  )
FROM api_endpoint_keys k JOIN api_endpoints ep ON ep.id = k.endpoint_id
WHERE k.source_account_id <> ''
  AND COALESCE(NULLIF(usage_logs.final_account_id, ''), usage_logs.account_id) = k.id
  AND usage_logs.via = 'api-kernel';

UPDATE request_attempts SET
  source_account_id = k.source_account_id,
  source_vm_id = NULLIF(k.source_vm_id, ''),
  source_email = COALESCE(
    (SELECT NULLIF(a.email, '') FROM accounts a WHERE a.id = k.source_account_id),
    CASE WHEN ep.name LIKE 'OpenAI API · %' THEN NULLIF(TRIM(SUBSTR(ep.name, LENGTH('OpenAI API · ') + 1)), '') END
  )
FROM api_endpoint_keys k JOIN api_endpoints ep ON ep.id = k.endpoint_id
WHERE k.source_account_id <> '' AND request_attempts.account_id = k.id;

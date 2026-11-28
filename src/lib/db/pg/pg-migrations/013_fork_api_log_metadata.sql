-- Platform state belongs to the OpenAI account, not the OAuth kernel lifecycle.
CREATE TABLE IF NOT EXISTS openai_api_orgs (
  organization_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  endpoint_id TEXT NOT NULL DEFAULT '',
  balance TEXT,
  balance_checked_at TEXT,
  balance_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS openai_api_accounts (
  account_id TEXT PRIMARY KEY,
  vm_id TEXT NOT NULL DEFAULT '',
  organization_id TEXT NOT NULL DEFAULT '',
  key_id TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  claim_status TEXT NOT NULL DEFAULT 'unknown',
  ineligibility_reason TEXT,
  operation_id TEXT,
  destination_account_id TEXT,
  offer_json TEXT,
  benefit_json TEXT,
  destinations_json TEXT NOT NULL DEFAULT '[]',
  delivery_json TEXT,
  setup_status TEXT NOT NULL DEFAULT 'idle',
  fingerprint_json TEXT,
  storage_state_enc TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_openai_api_accounts_vm ON openai_api_accounts(vm_id);
CREATE INDEX IF NOT EXISTS idx_openai_api_accounts_org ON openai_api_accounts(organization_id);

ALTER TABLE api_endpoint_keys ADD COLUMN IF NOT EXISTS source_vm_id TEXT NOT NULL DEFAULT '';
ALTER TABLE api_endpoint_keys ADD COLUMN IF NOT EXISTS source_account_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_api_endpoint_keys_source ON api_endpoint_keys(source_vm_id, source_account_id);

-- Browser identity and authenticated web storage belong to a slot, including
-- slots which have not completed their first OpenAI OAuth login yet.
CREATE TABLE IF NOT EXISTS slot_browser_profiles (
  vm_id TEXT PRIMARY KEY,
  account_id TEXT,
  fingerprint_json TEXT,
  storage_state_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE openai_api_accounts ADD COLUMN IF NOT EXISTS offer_checked_at TEXT;
ALTER TABLE openai_api_accounts ADD COLUMN IF NOT EXISTS link_checked_at TEXT;
ALTER TABLE openai_api_orgs ADD COLUMN IF NOT EXISTS paid_balance TEXT;
ALTER TABLE openai_api_orgs ADD COLUMN IF NOT EXISTS grants_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE openai_api_orgs ADD COLUMN IF NOT EXISTS next_expiring_amount TEXT;
ALTER TABLE openai_api_orgs ADD COLUMN IF NOT EXISTS next_expiring_at TEXT;
-- Billing authentication is owned by the slot's fixed web identity.
ALTER TABLE slot_browser_profiles ADD COLUMN IF NOT EXISTS billing_session_enc TEXT;
ALTER TABLE openai_api_accounts ADD COLUMN IF NOT EXISTS call_error_json TEXT;

-- Keep the PostgreSQL writer and readers compatible with the fork's SQLite log schema.
ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS source_account_id TEXT,
  ADD COLUMN IF NOT EXISTS source_vm_id TEXT,
  ADD COLUMN IF NOT EXISTS source_email TEXT,
  ADD COLUMN IF NOT EXISTS sent_model TEXT,
  ADD COLUMN IF NOT EXISTS upstream_response_model TEXT,
  ADD COLUMN IF NOT EXISTS failure_diagnostics_json TEXT;

ALTER TABLE request_attempts
  ADD COLUMN IF NOT EXISTS source_account_id TEXT,
  ADD COLUMN IF NOT EXISTS source_vm_id TEXT,
  ADD COLUMN IF NOT EXISTS source_email TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_logs_source_created ON usage_logs(source_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_attempt_source_started ON request_attempts(source_account_id, started_at);

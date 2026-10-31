-- Platform state belongs to the OpenAI account, not the OAuth kernel lifecycle.
CREATE TABLE openai_api_orgs (
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

CREATE TABLE openai_api_accounts (
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
CREATE INDEX idx_openai_api_accounts_vm ON openai_api_accounts(vm_id);
CREATE INDEX idx_openai_api_accounts_org ON openai_api_accounts(organization_id);

ALTER TABLE api_endpoint_keys ADD COLUMN source_vm_id TEXT NOT NULL DEFAULT '';
ALTER TABLE api_endpoint_keys ADD COLUMN source_account_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_api_endpoint_keys_source ON api_endpoint_keys(source_vm_id, source_account_id);

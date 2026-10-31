-- Browser identity and authenticated web storage belong to a slot, including
-- slots which have not completed their first OpenAI OAuth login yet.
CREATE TABLE slot_browser_profiles (
  vm_id TEXT PRIMARY KEY,
  account_id TEXT,
  fingerprint_json TEXT,
  storage_state_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE openai_api_accounts ADD COLUMN offer_checked_at TEXT;
ALTER TABLE openai_api_accounts ADD COLUMN link_checked_at TEXT;
ALTER TABLE openai_api_orgs ADD COLUMN paid_balance TEXT;
ALTER TABLE openai_api_orgs ADD COLUMN grants_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE openai_api_orgs ADD COLUMN next_expiring_amount TEXT;
ALTER TABLE openai_api_orgs ADD COLUMN next_expiring_at TEXT;

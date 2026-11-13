-- ShardBrowser starts fresh web profiles. Account identity, OAuth credentials,
-- API keys and organization/business records are not part of this migration.
UPDATE slot_browser_profiles
SET fingerprint_json = NULL, storage_state_enc = NULL, billing_session_enc = NULL;

UPDATE openai_api_accounts
SET fingerprint_json = NULL, storage_state_enc = NULL;

DELETE FROM settings WHERE key = 'account_browser_cloakbrowser_key';

-- File removal is completed before the first Shard profile can be created.
INSERT INTO settings (key, value, updated_at)
VALUES ('account_browser_shard_migrated', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO NOTHING;

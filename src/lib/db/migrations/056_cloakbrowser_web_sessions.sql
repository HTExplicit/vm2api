-- Firefox web state cannot be reused as a complete Chromium profile.
-- OAuth credentials, API keys and account/business records remain unchanged.
UPDATE slot_browser_profiles
SET fingerprint_json = NULL, storage_state_enc = NULL, billing_session_enc = NULL;

UPDATE openai_api_accounts
SET fingerprint_json = NULL, storage_state_enc = NULL;

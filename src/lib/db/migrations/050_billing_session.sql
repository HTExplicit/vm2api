-- Billing authentication is owned by the slot's fixed web identity.
ALTER TABLE slot_browser_profiles ADD COLUMN billing_session_enc TEXT;

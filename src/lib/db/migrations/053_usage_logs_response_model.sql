-- Observe sent and upstream-declared model names without changing legacy billing fields.
-- Historical rows remain unknown; the mixed legacy upstream_model is not backfilled.
ALTER TABLE usage_logs ADD COLUMN sent_model TEXT;
ALTER TABLE usage_logs ADD COLUMN upstream_response_model TEXT;

-- Update the default for new endpoints. Existing endpoints keep their selected policy.

ALTER TABLE api_endpoints
  ALTER COLUMN body_policy SET DEFAULT 'caller';

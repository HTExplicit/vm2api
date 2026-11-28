UPDATE api_endpoints
SET body_policy = 'caller'
WHERE body_policy = 'persona';

-- Cleanup po sjednocení online/offline logiky a device_source mapování.
-- docker compose exec -T db psql -U netpulse -d netpulse < shared/migrations/005_ip_addresses_source_cleanup.sql

-- Ping FALSE musí mít alive_source = NULL.
UPDATE ip_addresses
SET alive_source = NULL, updated_at = NOW()
WHERE is_alive IS FALSE
  AND alive_source = 'ping';

-- Historické "primary" sjednotíme na "api_address" (vlastní IP zařízení).
UPDATE ip_addresses ia
SET device_source = 'api_address', updated_at = NOW()
FROM devices d
WHERE ia.device_source = 'primary'
  AND ia.device_id = d.id
  AND ia.ip = d.ip;

-- Všechny ostatní non-own mapy (ne api/snmp_address) zrušíme.
UPDATE ip_addresses ia
SET device_id = NULL, device_source = NULL, updated_at = NOW()
WHERE ia.device_id IS NOT NULL
  AND ia.device_source NOT IN ('api_address', 'snmp_address');

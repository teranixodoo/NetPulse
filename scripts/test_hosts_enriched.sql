-- Test dotazu pro stránku „Detailní výpis IP“ (spustit na serveru)
-- docker compose exec -T db psql -U netpulse -d netpulse -f scripts/test_hosts_enriched.sql

\echo '=== Počty ==='
SELECT COUNT(*) AS ip_addresses FROM ip_addresses;
SELECT COUNT(*) AS device_ips_7d FROM device_ips WHERE last_seen > NOW() - INTERVAL '7 days';

\echo '=== Ukázka enriched (prvních 5 řádků) ==='
WITH device_map AS MATERIALIZED (
    SELECT DISTINCT ON (di.ip)
        di.ip, di.device_id, di.source AS device_source
    FROM device_ips di
    WHERE di.last_seen > NOW() - INTERVAL '7 days'
    ORDER BY di.ip,
        CASE di.source
            WHEN 'api_address' THEN 1 WHEN 'snmp_address' THEN 2
            WHEN 'api_arp' THEN 3 WHEN 'snmp_arp' THEN 4
            WHEN 'api_dhcp' THEN 5 ELSE 6
        END,
        di.last_seen DESC
)
SELECT
    ia.ip::text,
    ia.is_alive,
    r.label AS range_label,
    s.name AS site_name,
    d.hostname
FROM ip_addresses ia
LEFT JOIN device_map dm ON dm.ip = ia.ip
LEFT JOIN ip_ranges r ON r.id = ia.range_id
LEFT JOIN sites s ON s.id = r.site_id
LEFT JOIN devices d ON d.id = COALESCE(ia.device_id, dm.device_id)
ORDER BY ia.ip
LIMIT 5;

\echo '=== Statistiky (bez filtru) ==='
WITH device_map AS MATERIALIZED (
    SELECT DISTINCT ON (di.ip)
        di.ip, di.device_id, di.source AS device_source
    FROM device_ips di
    WHERE di.last_seen > NOW() - INTERVAL '7 days'
    ORDER BY di.ip,
        CASE di.source
            WHEN 'api_address' THEN 1 WHEN 'snmp_address' THEN 2
            WHEN 'api_arp' THEN 3 WHEN 'snmp_arp' THEN 4
            WHEN 'api_dhcp' THEN 5 ELSE 6
        END,
        di.last_seen DESC
)
SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE ia.is_alive IS TRUE)::int AS alive,
    COUNT(*) FILTER (WHERE ia.device_id IS NOT NULL OR dm.device_id IS NOT NULL)::int AS assigned
FROM ip_addresses ia
LEFT JOIN device_map dm ON dm.ip = ia.ip;

\echo '=== Test filtru site_id=2 (upravte ID podle: SELECT id, name FROM sites;) ==='
-- \set site_id 2
WITH device_map AS MATERIALIZED (
    SELECT DISTINCT ON (di.ip)
        di.ip, di.device_id
    FROM device_ips di
    WHERE di.last_seen > NOW() - INTERVAL '7 days'
    ORDER BY di.ip, di.last_seen DESC
)
SELECT COUNT(*)::int AS filtered_total
FROM ip_addresses ia
LEFT JOIN device_map dm ON dm.ip = ia.ip
LEFT JOIN ip_ranges r ON r.id = ia.range_id
WHERE r.site_id = 2;

-- Zpětné přiřazení ip_addresses.range_id podle ip_ranges (síť = ip_ranges.site_id)
-- docker compose exec -T db psql -U netpulse -d netpulse -f shared/migrations/003_sync_ip_ranges.sql

\echo '=== Před synchronizací ==='
SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE range_id IS NOT NULL)::int AS with_range,
    COUNT(*) FILTER (WHERE range_id IS NULL)::int AS without_range
FROM ip_addresses;

\echo '=== Přiřazení nejužšího rozsahu ==='
WITH best_range AS (
    SELECT DISTINCT ON (ia.ip)
        ia.ip,
        ir.id AS range_id
    FROM ip_addresses ia
    JOIN ip_ranges ir ON ia.ip << ir.network AND ir.active
    ORDER BY ia.ip, masklen(ir.network::cidr) DESC
)
UPDATE ip_addresses ia
SET range_id = br.range_id, updated_at = NOW()
FROM best_range br
WHERE ia.ip = br.ip
  AND ia.range_id IS DISTINCT FROM br.range_id;

\echo '=== Odstranění neplatných range_id ==='
UPDATE ip_addresses ia
SET range_id = NULL, updated_at = NOW()
WHERE ia.range_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM ip_ranges r
      WHERE ia.ip << r.network AND r.active AND r.id = ia.range_id
  );

\echo '=== Po synchronizaci ==='
SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE range_id IS NOT NULL)::int AS with_range,
    COUNT(*) FILTER (WHERE range_id IS NULL)::int AS without_range
FROM ip_addresses;

SELECT
    s.id, s.name, COUNT(ia.ip)::int AS ip_count
FROM sites s
JOIN ip_ranges r ON r.site_id = s.id
JOIN ip_addresses ia ON ia.range_id = r.id
GROUP BY s.id, s.name
ORDER BY s.id;

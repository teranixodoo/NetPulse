-- Přiřadí rozsahy JJJ / 10.101.x k síti Jehnice (pokud site_id chybí).
-- docker compose exec -T db psql -U netpulse -d netpulse < shared/migrations/004_jehnice_site_jjj_ranges.sql

INSERT INTO sites (name, description, color)
VALUES ('Jehnice', 'JJJ — lokalita Kleštínek / 10.101.x', '#22c55e')
ON CONFLICT (name) DO NOTHING;

UPDATE ip_ranges ir
SET site_id = (SELECT id FROM sites WHERE name = 'Jehnice' LIMIT 1)
WHERE ir.site_id IS NULL
  AND ir.active
  AND (
      ir.label ILIKE '%JJJ%'
      OR ir.network <<= '10.101.0.0/16'::cidr
  );

-- Migrace pro existující databázi (spustit jednou na serveru):
-- docker compose exec -T db psql -U netpulse -d netpulse < shared/migrations/001_sites.sql

CREATE TABLE IF NOT EXISTS sites (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    color       TEXT NOT NULL DEFAULT '#6366f1',
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO sites (id, name, description, color)
VALUES (1, 'Default', 'Výchozí síť', '#6366f1')
ON CONFLICT (name) DO NOTHING;

SELECT setval(
    'sites_id_seq',
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM sites), 1)
);

ALTER TABLE ip_ranges
    ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ip_ranges_site ON ip_ranges (site_id);

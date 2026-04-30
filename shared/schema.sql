-- schema.sql — NetPulse databázové schéma

-- Uživatelé API
CREATE TABLE IF NOT EXISTS api_users (
    id            SERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer',  -- viewer | admin
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- API klíče (alternativa k JWT)
CREATE TABLE IF NOT EXISTS api_keys (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES api_users(id) ON DELETE CASCADE,
    key_hash    TEXT UNIQUE NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    last_used   TIMESTAMPTZ,
    active      BOOLEAN DEFAULT TRUE
);

-- IP rozsahy ke skenování
CREATE TABLE IF NOT EXISTS ip_ranges (
    id        SERIAL PRIMARY KEY,
    label     TEXT NOT NULL,
    network   CIDR NOT NULL,
    active    BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Výsledky pingů
CREATE TABLE IF NOT EXISTS ping_results (
    id          BIGSERIAL PRIMARY KEY,
    ip          INET NOT NULL,
    scanned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_alive    BOOLEAN NOT NULL,
    rtt_ms      DOUBLE PRECISION,
    packet_loss DOUBLE PRECISION,
    jitter_ms   DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_ping_ip_time
    ON ping_results (ip, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_ping_time
    ON ping_results (scanned_at DESC);

-- Konfigurace (key-value, editovatelná přes UI)
CREATE TABLE IF NOT EXISTS app_config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Vložení výchozí konfigurace
INSERT INTO app_config (key, value, description) VALUES
    ('scan_interval_s',  '300',                              'Interval scanu v sekundách'),
    ('ping_count',       '3',                               'Počet pingů na IP'),
    ('ping_timeout_ms',  '1000',                            'Timeout pingu v ms'),
    ('max_concurrent',   '128',                             'Max. souběžných pingů'),
    ('alert_email',      '',                                'Email pro alerty'),
    ('alert_rtt_ms',     '100',                             'RTT práh pro alert (ms)'),
    ('retention_days',   '30',                              'Počet dní uchování dat')
ON CONFLICT (key) DO NOTHING;

-- Discovery scheduler konfigurace
INSERT INTO app_config (key, value, description) VALUES
    ('discovery_enabled',   'false', 'Automatický discovery scheduler zapnutý'),
    ('discovery_interval_s','3600',  'Interval discovery scanu v sekundách'),
    ('discovery_only_online','true', 'Testovat jen online zařízení')
ON CONFLICT (key) DO NOTHING;

-- Statistický pohled — uptime za posledních 24h
CREATE OR REPLACE VIEW host_stats_24h AS
SELECT
    ip::text,
    COUNT(*)                                         AS checks,
    ROUND((100.0 * SUM(is_alive::int) / COUNT(*))::numeric, 2) AS uptime_pct,
    ROUND(AVG(rtt_ms)::numeric, 2)                   AS avg_rtt_ms,
    ROUND(MIN(rtt_ms)::numeric, 2)                   AS min_rtt_ms,
    ROUND(MAX(rtt_ms)::numeric, 2)                   AS max_rtt_ms,
    ROUND(AVG(packet_loss)::numeric * 100, 2)        AS avg_loss_pct,
    MAX(scanned_at)                                  AS last_check,
    BOOL_OR(is_alive)                                AS currently_alive
FROM ping_results
WHERE scanned_at > NOW() - INTERVAL '24 hours'
GROUP BY ip;

-- Log výpadků
CREATE OR REPLACE VIEW outage_events AS
SELECT
    ip::text,
    scanned_at,
    is_alive,
    rtt_ms,
    packet_loss,
    LAG(is_alive) OVER (PARTITION BY ip ORDER BY scanned_at) AS prev_alive
FROM ping_results
WHERE scanned_at > NOW() - INTERVAL '7 days'
ORDER BY scanned_at DESC;

-- --- SEKCE PRO DEVICES A CREDENTIALS ---

-- Tabulka pro unikátní zařízení (identifikace přes Device ID / MAC / Alias)
CREATE TABLE IF NOT EXISTS devices (
    id            SERIAL PRIMARY KEY,
    device_uuid   TEXT UNIQUE NOT NULL,       -- Náš složený otisk (SHA-256)
    ip            INET NOT NULL,              -- IP už NENÍ unikátní (může se měnit)
    hostname      TEXT NOT NULL,
    mac           MACADDR UNIQUE,             -- MAC musí být unikátní, pokud existuje
    device_type   TEXT DEFAULT 'unknown',
    description   TEXT,
    alias         TEXT,                       -- Přidáváme pole alias
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index pro rychlé hledání podle hostname, když nemáme MAC
CREATE INDEX IF NOT EXISTS idx_devices_hostname ON devices(hostname);

-- Trezor na šifrované přihlašovací údaje
CREATE TABLE IF NOT EXISTS credentials (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,                  -- Název profilu (např. 'SSH Sklad')
    auth_type       TEXT NOT NULL,                  -- ssh | snmp | api | http
    username        TEXT,
    password_cipher TEXT NOT NULL,                  -- Zašifrované heslo (Fernet)
    port            INTEGER,                        -- Volitelný nestandardní port
    extra_params    JSONB DEFAULT '{}',             -- Např. {"snmp_version": "2c"}
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Vazební tabulka (M:N) mezi zařízeními a jejich hesly
CREATE TABLE IF NOT EXISTS device_credentials (
    device_id     INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    credential_id INTEGER REFERENCES credentials(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, credential_id)
);
    

-- Logy discovery testů pro každé zařízení
CREATE TABLE IF NOT EXISTS device_discovery_logs (
    id            SERIAL PRIMARY KEY,
    device_id     INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    tested_at     TIMESTAMPTZ DEFAULT NOW(),
    ip            TEXT NOT NULL,
    layers        JSONB NOT NULL,         -- výsledky jednotlivých vrstev [{layer, ok, result, note}]
    open_ports    INTEGER[],              -- seznam otevřených portů
    services      JSONB DEFAULT '{}',    -- bannery služeb {port: popis}
    patch_applied JSONB DEFAULT '{}'     -- co bylo zapsáno do zařízení
);

CREATE INDEX IF NOT EXISTS idx_discovery_logs_device
    ON device_discovery_logs(device_id, tested_at DESC);

-- Přidání polí vendor a serial_number do devices (migrace)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS vendor      TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_number TEXT;
-- Přidání poll dat do devices (migrace)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware      TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS model         TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_uptime_s INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_poll_method TEXT;


-- ---------------------------------------------------------------------------
-- Log scanování — historie všech typů scanů
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_jobs (
    id            SERIAL PRIMARY KEY,
    job_type      TEXT        NOT NULL,   -- 'ping_scan' | 'discovery' | 'snmp_poll'
    trigger_type  TEXT        NOT NULL,   -- 'cron' | 'manual'
    triggered_by  TEXT,                   -- username nebo 'scheduler'
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    duration_s    FLOAT,                  -- vypočteno při ukončení
    status        TEXT        NOT NULL DEFAULT 'running',  -- 'running'|'done'|'error'
    total_targets INTEGER     DEFAULT 0,  -- počet IP / zařízení
    ok_count      INTEGER     DEFAULT 0,  -- úspěšně
    fail_count    INTEGER     DEFAULT 0,  -- selhaly
    changed_count INTEGER     DEFAULT 0,  -- změny (nové online/offline/patche)
    error_msg     TEXT,                   -- chybová zpráva pokud status='error'
    meta          JSONB       DEFAULT '{}' -- další metadata (ranges, device_ids...)
);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_started ON scan_jobs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_type    ON scan_jobs (job_type, started_at DESC);

-- ---------------------------------------------------------------------------
-- Výsledky device pollingu (čtení dat ze zařízení)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_poll_results (
    id          SERIAL PRIMARY KEY,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ip          TEXT NOT NULL,
    method      TEXT NOT NULL,          -- api | snmp | ssh | http | failed
    success     BOOLEAN NOT NULL DEFAULT FALSE,
    hostname    TEXT,
    model       TEXT,
    vendor      TEXT,
    firmware    TEXT,
    uptime_s    INTEGER,
    interfaces  JSONB DEFAULT '[]',
    ports       JSONB DEFAULT '[]',
    system_info JSONB DEFAULT '{}',
    error       TEXT,
    polled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_poll_results_device
    ON device_poll_results (device_id, polled_at DESC);

-- Migrace: přidání textového uptime (originální string ze zařízení)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_uptime_str VARCHAR(40);
ALTER TABLE device_poll_results ADD COLUMN IF NOT EXISTS uptime_str VARCHAR(40);

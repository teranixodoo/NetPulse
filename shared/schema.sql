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
    ('discovery_only_online','true', 'Testovat jen online zařízení'),
('discovery_skip_polled','true', 'Přeskočit zařízení s čerstvým pollem (< discovery_interval_s)')
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

-- Migrace: ID posledního úspěšného credential profilu (pro backup engine)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_successful_credential_id INTEGER
    REFERENCES credentials(id) ON DELETE SET NULL;

-- Migrace: snapshot úspěšného přihlášení (pro backup engine)
-- Ukládá kompletní parametry které vedly k úspěšnému pollu:
-- credential_id, auth_type, username, port, use_ssl, ssl_context_type
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_successful_auth JSONB;

-- Migrace: Backup scheduler — globální konfigurace
INSERT INTO app_config (key, value, description) VALUES
    ('backup_enabled',         'false', 'Automatický backup scheduler zapnutý'),
    ('backup_interval_s',      '86400', 'Interval automatického backupu v sekundách (výchozí 24h)'),
    ('backup_only_online',     'true',  'Zálohovat pouze online zařízení'),
    ('backup_only_successful', 'true',  'Zálohovat pouze zařízení s úspěšným pollem (last_polled_at NOT NULL)')
ON CONFLICT (key) DO NOTHING;

-- Migrace: individuální backup nastavení pro každé zařízení
ALTER TABLE devices ADD COLUMN IF NOT EXISTS backup_enabled   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS backup_schedule  TEXT;    -- cron-like: 'daily'|'weekly'|'disabled'

-- ===========================================================================
-- System logs — strukturované záznamy událostí backendu
-- ===========================================================================
CREATE TABLE IF NOT EXISTS system_logs (
    id          BIGSERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level       TEXT        NOT NULL,   -- INFO / WARNING / ERROR / CRITICAL
    module      TEXT        NOT NULL,   -- netpulse.backup / netpulse.scheduler / ...
    event_type  TEXT        NOT NULL,   -- backup_ok / backup_fail / poll_ok / ...
    message     TEXT        NOT NULL,
    device_id   INTEGER     REFERENCES devices(id) ON DELETE SET NULL,
    user_name   TEXT,                   -- kdo akci spustil (NULL = systém)
    meta        JSONB                   -- extra strukturovaná data
);

-- Index pro rychlé filtrování
CREATE INDEX IF NOT EXISTS idx_system_logs_created  ON system_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_level    ON system_logs (level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_module   ON system_logs (module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_device   ON system_logs (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_event    ON system_logs (event_type, created_at DESC);

-- Konfigurace retence
INSERT INTO app_config (key, value, description) VALUES
    ('syslog_retention_days_info',     '100', 'Retence INFO logů v dnech'),
    ('syslog_retention_days_warning',  '365', 'Retence WARNING logů v dnech'),
    ('syslog_retention_days_error',    '365', 'Retence ERROR/CRITICAL logů v dnech')
ON CONFLICT (key) DO NOTHING;

-- Migrace: popis IP rozsahu
ALTER TABLE ip_ranges ADD COLUMN IF NOT EXISTS description TEXT;

-- Migrace: scan_enabled na ip_ranges
ALTER TABLE ip_ranges ADD COLUMN IF NOT EXISTS scan_enabled BOOLEAN NOT NULL DEFAULT true;

-- Výjimky ze scanování — konkrétní IP vyloučené ze scanu
CREATE TABLE IF NOT EXISTS scan_exclusions (
    id          SERIAL PRIMARY KEY,
    ip          INET NOT NULL UNIQUE,
    reason      TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scan_exclusions_ip ON scan_exclusions (ip);

-- Migrace: popis rozsahu
ALTER TABLE ip_ranges ADD COLUMN IF NOT EXISTS description TEXT;

-- ===========================================================================
-- device_data — rozšířená data ze zařízení (ARP, DHCP, interfaces)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS device_data (
    id          BIGSERIAL PRIMARY KEY,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    data_type   TEXT NOT NULL,       -- 'interfaces' | 'arp' | 'dhcp'
    data        JSONB NOT NULL,      -- pole objektů
    collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source      TEXT                 -- 'api' | 'snmp'
);

CREATE INDEX IF NOT EXISTS idx_device_data_device ON device_data (device_id, data_type, collected_at DESC);

-- Zachováme jen poslední 3 záznamy na typ — čistíme triggerem
CREATE OR REPLACE FUNCTION cleanup_device_data() RETURNS trigger AS $$
BEGIN
    DELETE FROM device_data
    WHERE device_id = NEW.device_id
      AND data_type = NEW.data_type
      AND id NOT IN (
          SELECT id FROM device_data
          WHERE device_id = NEW.device_id
            AND data_type = NEW.data_type
          ORDER BY collected_at DESC
          LIMIT 3
      );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_device_data ON device_data;
CREATE TRIGGER trg_cleanup_device_data
    AFTER INSERT ON device_data
    FOR EACH ROW EXECUTE FUNCTION cleanup_device_data();

-- Migrace: cron_poll — povolení automatického cron pollu zařízení
ALTER TABLE devices ADD COLUMN IF NOT EXISTS cron_poll BOOLEAN NOT NULL DEFAULT false;

-- Migrace: indexy pro výkon
CREATE INDEX IF NOT EXISTS idx_ping_results_scanned_at  ON ping_results  (scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_ping_results_ip_scanned  ON ping_results  (ip, scanned_at DESC);

-- ===========================================================================
-- device_ips — aktuální IP adresy na zařízeních
-- ===========================================================================
CREATE TABLE IF NOT EXISTS device_ips (
    id          BIGSERIAL PRIMARY KEY,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ip          INET NOT NULL,
    mac         TEXT,                   -- MAC adresa (může být NULL u vlastních IP)
    interface   TEXT,                   -- název rozhraní (ether1, vlan10...)
    is_primary  BOOLEAN DEFAULT false,  -- primární IP = ta v devices.ip
    source      TEXT NOT NULL,          -- 'api_address' | 'api_arp' | 'api_dhcp' | 'snmp_address' | 'snmp_arp'
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    change_count INTEGER NOT NULL DEFAULT 0,  -- počet zaznamenaných změn
    UNIQUE (device_id, ip, source)      -- jedna IP z jednoho zdroje per zařízení
);

CREATE INDEX IF NOT EXISTS idx_device_ips_device    ON device_ips (device_id);
CREATE INDEX IF NOT EXISTS idx_device_ips_ip        ON device_ips (ip);
CREATE INDEX IF NOT EXISTS idx_device_ips_mac       ON device_ips (mac) WHERE mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_device_ips_last_seen ON device_ips (last_seen DESC);

-- ===========================================================================
-- device_ip_history — log všech změn IP/MAC na zařízeních
-- ===========================================================================
CREATE TABLE IF NOT EXISTS device_ip_history (
    id          BIGSERIAL PRIMARY KEY,
    device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ip          INET NOT NULL,
    mac         TEXT,
    interface   TEXT,
    source      TEXT,
    event       TEXT NOT NULL,  -- 'assigned'|'released'|'changed_mac'|'changed_ip'
    old_value   JSONB,          -- předchozí stav {ip, mac, interface}
    new_value   JSONB,          -- nový stav
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_ip_history_device     ON device_ip_history (device_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_ip_history_ip         ON device_ip_history (ip);
CREATE INDEX IF NOT EXISTS idx_device_ip_history_mac        ON device_ip_history (mac) WHERE mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_device_ip_history_changed_at ON device_ip_history (changed_at DESC);

-- Migrace: change_count
ALTER TABLE device_ips ADD COLUMN IF NOT EXISTS change_count INTEGER NOT NULL DEFAULT 0;

-- Index pro ping_results
CREATE INDEX IF NOT EXISTS idx_ping_results_scanned_at
  ON ping_results (scanned_at DESC);

-- Heartbeat pro detekci zombie jobů
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS pid INTEGER;

-- Oprava zombie jobů při startu (joby starší 10 minut ve stavu running)
UPDATE scan_jobs
SET status = 'error', error_msg = 'Zombie — backend restart'
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes';

-- ===========================================================================
-- ip_presence_log — timeline přítomnosti IP (ARP/DHCP zdroje)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS ip_presence_log (
    id         BIGSERIAL PRIMARY KEY,
    ip         INET NOT NULL,
    source     TEXT NOT NULL,        -- 'arp' | 'dhcp' | 'ping'
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ           -- pro DHCP: lease expiry, pro ARP: seen_at + poll_interval
);

CREATE INDEX IF NOT EXISTS idx_ip_presence_ip      ON ip_presence_log (ip, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ip_presence_seen_at ON ip_presence_log (seen_at DESC);

-- Automatický cleanup — zachováme max 30 dní
-- (spouštět přes scheduled job)

-- ===========================================================================
-- ip_addresses — živý stav IP adres
-- ===========================================================================
CREATE TABLE IF NOT EXISTS ip_addresses (
    id              SERIAL PRIMARY KEY,
    ip              INET NOT NULL UNIQUE,
    range_id        INTEGER REFERENCES ip_ranges(id) ON DELETE SET NULL,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ,
    last_check      TIMESTAMPTZ,
    is_alive        BOOLEAN,
    rtt_ms          FLOAT,
    uptime_pct_24h  FLOAT,
    avg_rtt_24h     FLOAT,
    min_rtt_24h     FLOAT,
    max_rtt_24h     FLOAT,
    checks_24h      INTEGER DEFAULT 0,
    online_24h      INTEGER DEFAULT 0,
    device_id       INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    device_source   TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_ip     ON ip_addresses (ip);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_device ON ip_addresses (device_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_alive  ON ip_addresses (is_alive, last_check DESC);

ALTER TABLE ip_addresses ADD COLUMN IF NOT EXISTS alive_source TEXT;
-- 'ping' | 'arp' | 'dhcp' | NULL

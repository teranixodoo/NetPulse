-- Sloupec pro agregovanou ztrátu paketů (refresh z ping_results 24h)
ALTER TABLE ip_addresses
    ADD COLUMN IF NOT EXISTS packet_loss_24h FLOAT;

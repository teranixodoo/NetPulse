#!/usr/bin/env python3
"""
Import zařízení z Excel souboru do NetPulse DB.
Použití: python import_devices.py <soubor.xlsx>

Vytvoří:
  - Lokace (Místa jako budovy, Umístnění jako bytové jednotky)
  - Zařízení s přiřazením lokace, IP a MAC
  - Záznamy v ip_addresses pro každou IP
"""

import sys
import asyncio
import re
import uuid
import logging
from pathlib import Path

import asyncpg
import openpyxl

# ---------------------------------------------------------------------------
# Konfigurace
# ---------------------------------------------------------------------------
DB_URL = "postgresql://netpulse:netpulse@localhost:5433/netpulse"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("import")

# ---------------------------------------------------------------------------
# Parsování adresy z textu Místo
# ---------------------------------------------------------------------------
def parse_misto(text: str) -> dict:
    """
    Parsuje text jako 'KoRa Hybešova 46, Brno 60300' na části.
    Vrátí dict {name, street, city, zip}.
    """
    text = text.strip()
    psc = re.search(r'(\d{5})', text)
    zip_code = psc.group(1) if psc else None

    if ',' in text:
        parts = text.split(',', 1)
        first  = parts[0].strip()
        second = parts[1].strip()
        city   = re.sub(r'\d{5}', '', second).strip().rstrip(',').strip() or None
        # Název = první slovo(a) před první číslicí v první části
        m = re.match(r'^(\S+(?:\s+\S+)*?)\s+(\S*\d+\S*(?:\s+.*)?)$', first)
        if m:
            name   = m.group(1).strip()
            street = m.group(2).strip()
        else:
            name   = first
            street = None
    else:
        name   = text
        street = None
        city   = None

    return {"name": name, "street": street, "city": city, "zip": zip_code}


# ---------------------------------------------------------------------------
# Hlavní import
# ---------------------------------------------------------------------------
async def run_import(xlsx_path: str, dry_run: bool = False):
    log.info(f"Načítám soubor: {xlsx_path}")
    wb  = openpyxl.load_workbook(xlsx_path)
    ws  = wb.active
    rows = [r for r in ws.iter_rows(min_row=2, values_only=True) if any(r)]
    log.info(f"Nalezeno {len(rows)} řádků dat")

    conn = await asyncpg.connect(DB_URL)
    log.info("Připojen k DB")

    try:
        # ---------------------------------------------------------------
        # Krok 1 — Vytvoření Míst (budovy)
        # ---------------------------------------------------------------
        log.info("─" * 60)
        log.info("KROK 1 — Místa (budovy)")
        misto_to_id: dict[str, int] = {}

        unikatni_mista = {}
        for row in rows:
            misto = str(row[5]).strip()
            if misto not in unikatni_mista:
                unikatni_mista[misto] = parse_misto(misto)

        for misto_text, parsed in unikatni_mista.items():
            # Zkontrolujeme jestli lokace s tímto názvem už existuje
            existing = await conn.fetchrow(
                "SELECT id FROM locations WHERE name=$1 AND type='building'",
                parsed["name"]
            )
            if existing:
                misto_to_id[misto_text] = existing["id"]
                log.info(f"  EXISTS  budova '{parsed['name']}' (id={existing['id']})")
                continue

            if not dry_run:
                loc_id = await conn.fetchval("""
                    INSERT INTO locations (name, type, street, city, zip, country, active)
                    VALUES ($1, 'building', $2, $3, $4, 'CZ', TRUE)
                    RETURNING id
                """, parsed["name"], parsed.get("street"), parsed.get("city"), parsed.get("zip"))
                misto_to_id[misto_text] = loc_id
                log.info(f"  CREATE  budova '{parsed['name']}' → id={loc_id}"
                         f" ({parsed.get('street')}, {parsed.get('city')})")
            else:
                log.info(f"  DRY-RUN budova '{parsed['name']}'"
                         f" ({parsed.get('street')}, {parsed.get('city')})")

        # ---------------------------------------------------------------
        # Krok 2 — Vytvoření Umístnění (bytové jednotky)
        # ---------------------------------------------------------------
        log.info("─" * 60)
        log.info("KROK 2 — Umístnění (bytové jednotky)")
        umist_to_id: dict[tuple, int] = {}

        unikatni_umist = {}
        for row in rows:
            key = (str(row[4]).strip(), str(row[5]).strip())
            if key not in unikatni_umist:
                unikatni_umist[key] = key

        for (umist_text, misto_text) in unikatni_umist:
            parent_id = misto_to_id.get(misto_text)

            existing = await conn.fetchrow(
                "SELECT id FROM locations WHERE name=$1 AND type='apartment' AND parent_id=$2",
                umist_text, parent_id
            )
            if existing:
                umist_to_id[(umist_text, misto_text)] = existing["id"]
                log.info(f"  EXISTS  byt '{umist_text}' (id={existing['id']})")
                continue

            if not dry_run:
                loc_id = await conn.fetchval("""
                    INSERT INTO locations (name, type, parent_id, active)
                    VALUES ($1, 'apartment', $2, TRUE)
                    RETURNING id
                """, umist_text, parent_id)
                umist_to_id[(umist_text, misto_text)] = loc_id
                log.info(f"  CREATE  byt '{umist_text}' → id={loc_id} (parent={parent_id})")
            else:
                log.info(f"  DRY-RUN byt '{umist_text}' (parent={parent_id})")

        # ---------------------------------------------------------------
        # Krok 3 — Vytvoření zařízení
        # ---------------------------------------------------------------
        log.info("─" * 60)
        log.info("KROK 3 — Zařízení")
        created = 0
        skipped = 0
        updated = 0

        for i, row in enumerate(rows, 1):
            mac_raw, ip_raw, dtype, device_name, umist_text, misto_text = row
            mac         = str(mac_raw).strip().upper() if mac_raw else None
            ip          = str(ip_raw).strip()          if ip_raw  else None
            dtype       = str(dtype).strip()           if dtype   else "unknown"
            device_name = str(device_name).strip()     if device_name else f"device_{i}"
            umist_text  = str(umist_text).strip()
            misto_text  = str(misto_text).strip()

            location_id = umist_to_id.get((umist_text, misto_text))

            # Zkontrolujeme jestli zařízení s touto MAC nebo IP existuje
            existing = None
            if mac:
                existing = await conn.fetchrow(
                    "SELECT id, hostname FROM devices WHERE mac=$1::macaddr", mac
                )
            if not existing and ip:
                existing = await conn.fetchrow(
                    "SELECT id, hostname FROM devices WHERE ip=$1::inet", ip
                )

            if existing:
                # Aktualizujeme location_id pokud chybí
                if not dry_run:
                    await conn.execute(
                        "UPDATE devices SET location_id=$1 WHERE id=$2",
                        location_id, existing["id"]
                    )
                updated += 1
                log.info(f"  UPDATE  [{i:3d}] '{device_name}' ({ip}) → location={location_id}")
                continue

            # Vytvoříme nové zařízení
            dev_uuid = str(uuid.uuid4())
            if not dry_run:
                dev_id = await conn.fetchval("""
                    INSERT INTO devices
                        (device_uuid, ip, mac, hostname, device_type, ownership, location_id)
                    VALUES ($1, $2::inet, $3::macaddr, $4, $5, 'client', $6)
                    RETURNING id
                """, dev_uuid, ip, mac, device_name, dtype, location_id)

                # Upsert do ip_addresses
                await conn.execute("""
                    INSERT INTO ip_addresses (ip, is_alive, device_id, updated_at)
                    VALUES ($1::inet, NULL, $2, NOW())
                    ON CONFLICT (ip) DO UPDATE SET
                        device_id = $2,
                        updated_at = NOW()
                """, ip, dev_id)

                created += 1
                log.info(f"  CREATE  [{i:3d}] '{device_name}' {ip} MAC={mac}"
                         f" type={dtype} loc={location_id}")
            else:
                created += 1
                log.info(f"  DRY-RUN [{i:3d}] '{device_name}' {ip} MAC={mac}"
                         f" type={dtype} loc={location_id}")

        # ---------------------------------------------------------------
        # Souhrn
        # ---------------------------------------------------------------
        log.info("─" * 60)
        log.info(f"HOTOVO {'(DRY RUN)' if dry_run else ''}")
        log.info(f"  Budovy:      {len(unikatni_mista)}")
        log.info(f"  Bytové j.:   {len(unikatni_umist)}")
        log.info(f"  Zař. vytvořeno: {created}")
        log.info(f"  Zař. aktualizováno: {updated}")
        log.info(f"  Zař. přeskočeno:    {skipped}")

    finally:
        await conn.close()


if __name__ == "__main__":
    xlsx = sys.argv[1] if len(sys.argv) > 1 else None
    dry  = "--dry-run" in sys.argv

    if not xlsx:
        print("Použití: python import_devices.py <soubor.xlsx> [--dry-run]")
        sys.exit(1)

    if not Path(xlsx).exists():
        print(f"Soubor nenalezen: {xlsx}")
        sys.exit(1)

    asyncio.run(run_import(xlsx, dry_run=dry))

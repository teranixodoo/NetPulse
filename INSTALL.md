# NetPulse — Instalační příručka

## Architektura

```
┌─────────────────────────────────────────────────────────────┐
│  PROHLÍŽEČ                                                  │
│  Streamlit Frontend  :8501                                  │
│  • Dashboard (mapa IP, tabulka)                             │
│  • Grafy RTT (Plotly)                                       │
│  • Log výpadků                                              │
│  • Nastavení (konfigurace, IP rozsahy, uživatelé)           │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP REST API (JSON)
                        │ Bearer JWT / X-API-Key
┌───────────────────────▼─────────────────────────────────────┐
│  FastAPI Backend  :8000                                     │
│  • /auth/login      POST  → JWT token                       │
│  • /hosts           GET   → statistiky všech IP             │
│  • /hosts/{ip}/rtt  GET   → RTT trend (pro externí API)     │
│  • /scan/trigger    POST  → okamžitý scan                   │
│  • /config          GET/PUT → konfigurace                   │
│  • /ranges          CRUD  → IP rozsahy                      │
│  APScheduler (background) → ping scan každých N sekund      │
└───────────────────────┬─────────────────────────────────────┘
                        │ asyncpg
┌───────────────────────▼─────────────────────────────────────┐
│  PostgreSQL  :5432                                          │
│  • ping_results  (měření)                                   │
│  • ip_ranges     (rozsahy)                                  │
│  • app_config    (konfigurace)                              │
│  • api_users     (uživatelé)                                │
│  • api_keys      (API klíče)                                │
└─────────────────────────────────────────────────────────────┘
```

---

## Rychlý start — Docker Compose (doporučeno)

```bash
# 1. Klonuj / rozbal projekt
cd netpulse

# 2. Spusť celý stack
docker compose up -d

# 3. Vytvoř prvního admin uživatele
docker compose exec backend python - <<'EOF'
import asyncio, asyncpg
from auth import hash_password

async def main():
    pool = await asyncpg.create_pool(
        "postgresql://netpulse:netpulse_secret@localhost/netpulse"
    )
    pw = hash_password("admin1234")
    await pool.execute(
        "INSERT INTO api_users (username, password_hash, role) VALUES ($1,$2,$3)",
        "admin", pw, "admin"
    )
    print("Admin vytvořen: admin / admin1234")
    await pool.close()

asyncio.run(main())
EOF

# 4. Otevři prohlížeč
#    Streamlit:  http://localhost:8501
#    API docs:   http://localhost:8000/docs
```

---

## Manuální instalace na Debianu

### 1. Závislosti systému

```bash
sudo apt update
sudo apt install python3.12 python3-pip python3-venv postgresql postgresql-contrib
```

### 2. Databáze

```bash
sudo -u postgres psql <<SQL
CREATE USER netpulse WITH PASSWORD 'netpulse_secret';
CREATE DATABASE netpulse OWNER netpulse;
SQL

psql postgresql://netpulse:netpulse_secret@localhost/netpulse < shared/schema.sql
```

### 3. Python prostředí

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Proměnné prostředí

```bash
# Vytvoř .env soubor
cat > .env <<EOF
DATABASE_URL=postgresql://netpulse:netpulse_secret@localhost/netpulse
NETPULSE_API_URL=http://localhost:8000
PORT=8000
EOF
```

### 5. Spuštění

```bash
# Terminal 1 — backend
cd backend
source ../.venv/bin/activate
python main.py

# Terminal 2 — frontend
cd frontend
source ../.venv/bin/activate
streamlit run app.py --server.port 8501
```

### 6. ICMP oprávnění (pro raw ping bez root)

```bash
# Možnost A: CAP_NET_RAW na Python binárce
sudo setcap cap_net_raw+ep $(which python3)

# Možnost B: Spustit backend jako root (méně bezpečné)
sudo python main.py
```

---

## Použití externího API

Jiná aplikace se může ptát na data přes REST API:

```bash
# 1. Přihlášení → token
TOKEN=$(curl -s -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin1234"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. RTT trend pro IP
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/hosts/192.168.1.1/rtt?hours=24"

# 3. Statistiky všech hostů
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/hosts"

# 4. Alternativně — API klíč (bez expiry)
curl -H "X-API-Key: np_váš_klíč" \
  "http://localhost:8000/hosts/192.168.1.1/rtt"
```

### Python klient pro externí app

```python
import requests

BASE  = "http://váš-server:8000"
TOKEN = "np_váš_api_klíč"   # nebo JWT

def get_rtt_trend(ip: str, hours: int = 24):
    r = requests.get(
        f"{BASE}/hosts/{ip}/rtt",
        headers = {"X-API-Key": TOKEN},
        params  = {"hours": hours},
        timeout = 10,
    )
    r.raise_for_status()
    return r.json()["points"]

# Příklad
trend = get_rtt_trend("192.168.1.1", hours=12)
for point in trend:
    print(point["ts"], point["rtt_ms"])
```

---

## Struktura souborů

```
netpulse/
├── backend/
│   ├── main.py          ← FastAPI, endpoint POST /devices/{id}/discovery
│   ├── discovery.py     ← ✅ zde patří — síťové operace
│   ├── scanner.py       ← ping scanner (stejná logika)
│   ├── scheduler.py
│   ├── db.py
│   ├── auth.py
│   └── models.py
│
├── frontend/
│   ├── app.py
│   ├── api_client.py    ← volá POST /devices/{id}/discovery přes HTTP
│   └── pages/
│       └── 5_zarizeni.py ← tlačítko TEST → api_client.run_discovery()
│
├── shared/
│   └── schema.sql
│
├── Dockerfile.backend   ← obsahuje iproute2, NET_RAW, NET_ADMIN
├── Dockerfile.frontend
└── docker-compose.yml
```
Struktura projektu
netpulse/
├── backend/                 ← beze změny
│   ├── main.py
│   ├── db.py
│   ├── scanner.py
│   └── ...
├── frontend-react/          ← NOVÉ
│   ├── app/
│   │   ├── layout.tsx       ← hlavní layout, sidebar
│   │   ├── page.tsx         ← homepage (přesměrování na dashboard)
│   │   ├── dashboard/
│   │   │   └── page.tsx
│   │   ├── devices/
│   │   │   └── page.tsx     ← tabulka zařízení (přesně co chceš)
│   │   ├── ranges/
│   │   │   └── page.tsx
│   │   ├── credentials/
│   │   │   └── page.tsx
│   │   ├── logs/
│   │   │   └── page.tsx
│   │   └── settings/
│   │       └── page.tsx
│   ├── components/
│   │   ├── ui/              ← shadcn komponenty
│   │   ├── DataTable/       ← univerzální tabulka s akcemi
│   │   ├── DeviceDetail/    ← inline detail/edit panel
│   │   ├── StatusBadge.tsx
│   │   ├── NetworkMap.tsx   ← IP mapa rozsahů
│   │   └── Sidebar.tsx
│   ├── lib/
│   │   ├── api.ts           ← API client (všechny volání)
│   │   ├── auth.ts          ← JWT management
│   │   └── types.ts         ← TypeScript typy z API
│   ├── package.json
│   ├── tailwind.config.ts
│   └── Dockerfile.frontend-react
├── frontend/                ← starý Streamlit (souběžně)
├── shared/
│   └── schema.sql
└── docker-compose.yml

docker compose up -d --build frontend-react

# NetPulse — Struktura projektu na serveru
# Kořenový adresář: ~/netpulse/

~/netpulse/
│
├── docker-compose.yml              ← PŘEPSAT
├── Dockerfile.backend              ← PŘEPSAT
├── Dockerfile.frontend             ← zachovat (beze změny)
├── Dockerfile.frontend-react       ← NOVÝ soubor
├── requirements.txt                ← PŘEPSAT
│
├── backend/                        ← složka pro Python backend
│   ├── main.py                     ← PŘEPSAT
│   ├── db.py                       ← PŘEPSAT
│   ├── auth.py                     ← PŘEPSAT
│   ├── models.py                   ← PŘEPSAT
│   ├── scanner.py                  ← zachovat (beze změny)
│   ├── scheduler.py                ← zachovat (beze změny)
│   ├── discovery.py                ← PŘEPSAT
│   └── init_admin.py               ← PŘEPSAT
│
├── frontend/                       ← starý Streamlit (zatím zachovat)
│   ├── app.py                      ← zachovat
│   ├── api_client.py               ← zachovat
│   └── pages/
│       ├── 1_dashboard.py          ← zachovat
│       ├── 2_grafy.py              ← zachovat
│       ├── 3_log.py                ← zachovat
│       ├── 4_nastaveni.py          ← zachovat
│       └── 5_zarizeni.py          ← zachovat
│
├── frontend-react/                 ← NOVÁ složka (celá)
│   ├── package.json                ← NOVÝ
│   ├── tsconfig.json               ← NOVÝ
│   ├── next.config.js              ← NOVÝ
│   ├── tailwind.config.ts          ← NOVÝ
│   ├── postcss.config.js           ← NOVÝ
│   ├── .gitignore                  ← NOVÝ
│   ├── .env.local.example          ← NOVÝ (přejmenuj na .env.local)
│   │
│   ├── app/                        ← Next.js App Router
│   │   ├── globals.css             ← NOVÝ
│   │   ├── layout.tsx              ← NOVÝ
│   │   ├── page.tsx                ← NOVÝ
│   │   ├── providers.tsx           ← NOVÝ
│   │   ├── login/
│   │   │   └── page.tsx            ← NOVÝ
│   │   └── dashboard/
│   │       └── page.tsx            ← NOVÝ
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppShell.tsx        ← NOVÝ
│   │   │   ├── Sidebar.tsx         ← NOVÝ
│   │   │   ├── TopBar.tsx          ← NOVÝ
│   │   │   └── ScanStatusWidget.tsx ← NOVÝ
│   │   └── ui/
│   │       └── index.tsx           ← NOVÝ
│   │
│   ├── hooks/
│   │   └── useNetPulse.ts          ← NOVÝ
│   │
│   └── lib/
│       ├── api.ts                  ← NOVÝ
│       ├── auth.ts                 ← NOVÝ
│       ├── types.ts                ← NOVÝ
│       └── utils.ts                ← NOVÝ
│
└── shared/
    └── schema.sql                  ← PŘEPSAT


# ═══════════════════════════════════════════════════════
# PŘÍKAZY PRO NASAZENÍ NA SERVER
# ═══════════════════════════════════════════════════════

# 1. Vytvoř složky které ještě neexistují:
mkdir -p ~/netpulse/frontend-react/app/login
mkdir -p ~/netpulse/frontend-react/app/dashboard
mkdir -p ~/netpulse/frontend-react/components/layout
mkdir -p ~/netpulse/frontend-react/components/ui
mkdir -p ~/netpulse/frontend-react/hooks
mkdir -p ~/netpulse/frontend-react/lib

# 2. Zkopíruj soubory (SCP z tvého PC nebo přímo na serveru)
#    Příklad pro SCP z lokálního PC:
#    scp -r frontend-react/ user@server:~/netpulse/

# 3. Přejmenuj .env.local.example:
cp ~/netpulse/frontend-react/.env.local.example \
   ~/netpulse/frontend-react/.env.local

# 4. Spusť nový React frontend:
cd ~/netpulse
docker compose up -d --build frontend-react

# 5. Ověř že běží:
docker compose logs -f frontend-react

# React dostupný na: http://server:3000
# Streamlit stále na: http://server:8501
# Backend API stále na: http://server:8000

# Build
docker compose build --no-cache frontend-react && docker compose up -d frontend-react

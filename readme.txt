NetPulse — Instalační příručka
Architektura
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

Struktura projektu
netpulse/
├── backend/
│   ├── main.py       ← FastAPI app, všechny endpointy, lifespan
│   ├── scanner.py    ← async ICMP ping engine (icmplib)
│   ├── scheduler.py  ← APScheduler, background scan loop
│   ├── db.py         ← asyncpg, všechny DB operace
│   ├── auth.py       ← JWT + API klíče + bcrypt
│   └── models.py     ← Pydantic modely
│
├── frontend/
│   ├── app.py              ← hlavní stránka, login, metriky
│   ├── api_client.py       ← HTTP klient + require_auth()
│   └── pages/
│       ├── 1_dashboard.py  ← mapa IP, tabulka hostů
│       ├── 2_grafy.py      ← RTT trend, uptime bar, scatter
│       ├── 3_log.py        ← výpadky, poslední výsledky
│       └── 4_nastaveni.py  ← config, IP rozsahy, uživatelé
│
├── shared/
│   └── schema.sql    ← PostgreSQL schéma + views
│
├── docker-compose.yml
├── Dockerfile.backend
├── Dockerfile.frontend
├── requirements.txt
└── INSTALL.md   
np_996daf27fc3512463d141c9538e8ea8a  (172.28.10.0/24) 176.74.141.0/24
support / lubik123.

root@atom:~/netpulse# docker compose cp backend/init_admin.py backend:/app/init_admin.py
WARN[0000] /root/netpulse/docker-compose.yml: `version` is obsolete
[+] Copying 1/0
 ✔ netpulse-backend-1 copy backend/init_admin.py to netpulse-backend-1:/app/init_admin.py Copied                                          0.1s
root@atom:~/netpulse# docker compose exec backend python init_admin.py
WARN[0000] /root/netpulse/docker-compose.yml: `version` is obsolete
Připojuji se k DB: postgresql://netpulse:netpulse_secret@db/netp...
Aktuální stav: 1 uživatelů, 0 API klíčů

Zadej uživatelské jméno admina [admin]: admin
Zadej heslo (min. 8 znaků): admin123

Uživatel 'admin' aktualizován (heslo změněno, role = admin)

============================================================
✅ HOTOVO — uložte si tyto údaje:
============================================================
  Uživatel : admin
  Heslo    : admin123
  API klíč : np_xXdAdwhiG1pqqPou5Zkm4zs5irLMTRsimykQMWSdvK0
============================================================
⚠️  API klíč se zobrazí pouze jednou!

Přihlášení přes UI: http://localhost:8501
API docs:           http://localhost:8000/docs
root@atom:~/netpulse#

docker exec -it netpulse-backend-1 python3 -c '
import asyncio
import os
import auth
import db

async def create_first_admin():
    # Načtení URL z prostředí (používáme DATABASE_URL podle tvého compose)
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("Chyba: DATABASE_URL nebyla nalezena.")
        return

    # Inicializace poolu pomocí tvé funkce v db.py
    pool = await db.init_pool(db_url)
    
    username = "admin"
    password = "admin123"
    
    # Použijeme tvou funkci hash_password z auth.py
    pw_hash = auth.hash_password(password)
    
    async with pool.acquire() as conn:
        # Tabulka se ve tvém db.py jmenuje api_users
        await conn.execute("""
            INSERT INTO api_users (username, password_hash, role)
            VALUES ($1, $2, $3)
            ON CONFLICT (username) DO NOTHING
        """, username, pw_hash, "admin")
        
    print(f"\n✅ Admin vytvořen v tabulce api_users!")
    print(f"Uživatel: {username}")
    print(f"Heslo:    {password}\n")

if __name__ == "__main__":
    asyncio.run(create_first_admin())
'

Uživatel klikne TEST
    → Streamlit (frontend) volá client.run_discovery(device_id)
        → HTTP POST /devices/{id}/discovery
            → FastAPI (backend) zavolá discovery.run_discovery(ip)
                → discovery.py provede ARP, rDNS, port scan
                    → výsledky zapíše do PostgreSQL
                        → vrátí JSON odpověď
    → Streamlit zobrazí výsledky


Klíč Bfo7vpyswMPI8F-4tV3t8FwvONJmGJP5VxaaTKzZp2s= je platný Fernet klíč (AES-128-CBC). 
Ulož si ho na bezpečné místo — pokud ho změníš, existující zašifrovaná hesla v DB přestanou fungovat.

# Zastaví kontejnery
docker compose down

# Sestaví vše znovu bez použití mezipaměti
docker compose build --no-cache backend

# Spustí vše znovu na pozadí
docker compose up -d

# Kontrola zda kontejnery běží
docker ps

# Test, zda frontend vidí backend (musí vrátit status 200 nebo JSON)
docker exec -it netpulse-frontend-1 curl http://backend:8000/health  

# 1. Zastavit pouze frontend
docker compose stop frontend

# Zastaví a smaže kontejner (data uvnitř frontendu nejsou důležitá)
docker rm -f netpulse-frontend-1

# 2. Smazat starý image frontendu, aby se musel postavit znovu
docker rmi netpulse-frontend

# 3. Spustit rebuild frontendu bez použití mezipaměti (cache)
docker compose build --no-cache frontend

# 4. Znovu spustit
docker compose up -d frontend   

docker compose restart frontend backend

docker compose up -d --build backend
 docker compose build --no-cache frontend

Architektura po přechodu
┌─────────────────────────────────────────────────────┐
│                    Prohlížeč                        │
│              Next.js (port 3000)                    │
│    React komponenty + TanStack Table + SWR          │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP/REST (JWT token)
┌─────────────────────▼───────────────────────────────┐
│              FastAPI backend (port 8000)             │
│   Všechny stávající endpointy zachovány             │
└─────────────────────┬───────────────────────────────┘
                      │ asyncpg
┌─────────────────────▼───────────────────────────────┐
│              PostgreSQL (port 5433)                  │
└─────────────────────────────────────────────────────┘

Technologický stack React frontendu
OblastKnihovnaDůvodFrameworkNext.js 14 (App Router)SSR, routing, API proxyUI komponentyshadcn/ui + Tailwind CSSKrásné, přizpůsobitelné, bez vendor lock-inTabulkyTanStack Table v8Sorting, filtering, virtualizace, row actions — přesně co potřebuješData fetchingSWR nebo TanStack QueryCache, revalidace, optimistic updatesFormulářeReact Hook Form + ZodValidace, inline editaceGrafyRechartsRTT trendy, uptime grafyAuthJWT v cookie/localStorageStávající backend endpointyReal-timeWebSocket nebo pollingLive scan statusIconsLucide ReactKonzistentní ikonky

Struktura projektu
netpulse/
├── backend/                 ← beze změny
│   ├── main.py
│   ├── db.py
│   ├── scanner.py
│   └── ...
├── frontend-react/          ← NOVÉ REACT
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
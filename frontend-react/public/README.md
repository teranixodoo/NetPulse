# NetPulse — Uživatelská a administrátorská příručka

## Obsah

1. [Co je NetPulse](#1-co-je-netpulse)
2. [Architektura](#2-architektura)
3. [Instalace a spuštění](#3-instalace-a-spuštění)
4. [Přihlášení a uživatelé](#4-přihlášení-a-uživatelé)
5. [Dashboard](#5-dashboard)
6. [Evidence zařízení](#6-evidence-zařízení)
7. [IP Adresy (Hosts)](#7-ip-adresy-hosts)
8. [Grafy RTT](#8-grafy-rtt)
9. [Sítě (Sites)](#9-sítě-sites)
10. [IP Rozsahy](#10-ip-rozsahy)
11. [Neznámé sítě](#11-neznámé-sítě)
12. [Network Awareness — MAC inventář](#12-network-awareness--mac-inventář)
13. [Přihlašovací profily](#13-přihlašovací-profily)
14. [Scan — Ping monitoring](#14-scan--ping-monitoring)
15. [Discovery — Identifikace zařízení](#15-discovery--identifikace-zařízení)
16. [Poll — Sběr dat ze zařízení](#16-poll--sběr-dat-ze-zařízení)
17. [Backup — Zálohy konfigurace](#17-backup--zálohy-konfigurace)
18. [Zálohy (přehled)](#18-zálohy-přehled)
19. [Lokace](#19-lokace)
20. [Mapy](#20-mapy)
21. [Log výpadků](#21-log-výpadků)
22. [Log změn](#22-log-změn)
23. [Nastavení](#23-nastavení)
24. [Konfigurace (číselníky)](#24-konfigurace-číselníky)
25. [System Logs](#25-system-logs)
26. [API a přístup pro externí systémy](#26-api-a-přístup-pro-externí-systémy)

---

## 1. Co je NetPulse

NetPulse je síťový monitoring a správa zařízení navržený pro firemní sítě s MikroTik infrastrukturou. Systém kombinuje:

- **Ping monitoring** — pravidelné pingování všech IP adres ve sledovaných rozsazích, měření RTT a dostupnosti
- **Discovery** — automatická identifikace zařízení (hostname, výrobce, porty, HTTP, TLS, SNMP)
- **Poll** — hlubší sběr dat ze zařízení (uptime, rozhraní, ARP tabulky, DHCP lease, routing, systémové informace)
- **Backup** — automatické zálohování konfigurace MikroTik routerů ve formátu .rsc
- **Network Awareness** — sledování MAC adres v síti, detekce nových zařízení a změn IP

Systém je určen správcům sítě, kteří potřebují přehled o tom, co se v síti děje, aniž by museli pravidelně kontrolovat každé zařízení ručně.

---

## 2. Architektura

```
┌─────────────────────────────────────────────────────────────┐
│  PROHLÍŽEČ — Next.js / React frontend  :3000                │
│  • Dashboard, Evidence zařízení, IP Adresy, Grafy           │
│  • Network Awareness, Scan, Discovery, Poll, Backup         │
│  • Nastavení, Konfigurace, Lokace, Mapy, Logy               │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP REST API (JSON)
                        │ Bearer JWT / X-API-Key
┌───────────────────────▼─────────────────────────────────────┐
│  FastAPI Backend  :8000                                     │
│  • REST API — všechny operace                               │
│  • APScheduler — ping scan, discovery, poll, backup         │
│  • icmplib — ICMP ping (privileged)                         │
│  • fping — volitelný rychlejší scanner                      │
│  • routeros_api — MikroTik API komunikace                   │
│  • asyncssh — SSH přístup k zařízením                       │
│  • pysnmp — SNMP dotazy                                     │
└───────────────────────┬─────────────────────────────────────┘
                        │ asyncpg
┌───────────────────────▼─────────────────────────────────────┐
│  PostgreSQL 16  :5433                                       │
│  • ping_results, devices, ip_ranges, sites                  │
│  • mac_inventory, mac_events                                │
│  • backups, credentials, locations, app_config              │
└─────────────────────────────────────────────────────────────┘
```

Backend běží v režimu `network_mode: host` — přímý přístup k síti pro ICMP ping a SNMP (UDP).

---

## 3. Instalace a spuštění

### Požadavky
- Docker + Docker Compose
- Linux server s přímým přístupem do sledovaných sítí
- Doporučeno: 2+ CPU, 4 GB RAM, 20 GB disk

### Rychlý start

```bash
# 1. Přejdi do adresáře projektu
cd ~/netpulse

# 2. Nastav proměnné prostředí
cp .env.example .env
# Uprav .env — nastav POSTGRES_PASSWORD, JWT_SECRET, DB_ENCRYPTION_KEY, BACKEND_URL

# 3. Spusť celý stack
docker compose up -d

# 4. Vytvoř prvního admin uživatele
docker compose exec backend python init_admin.py

# 5. Otevři v prohlížeči
http://<IP_SERVERU>:3000
```

### Klíčové proměnné prostředí (.env)

| Proměnná | Popis |
|---|---|
| `POSTGRES_PASSWORD` | Heslo k PostgreSQL databázi |
| `JWT_SECRET` | Tajný klíč pro JWT tokeny (min. 32 znaků) |
| `DB_ENCRYPTION_KEY` | Klíč pro šifrování hesel přihlašovacích profilů |
| `BACKEND_URL` | URL backendu dostupná z frontendu (např. `http://10.221.0.65:8000`) |

### Porty

| Port | Služba |
|---|---|
| 3000 | Next.js frontend (hlavní webové rozhraní) |
| 8000 | FastAPI backend (REST API) |
| 5433 | PostgreSQL (externě, pro přímý přístup) |
| 8501 | Starý Streamlit frontend (souběžně, bude odstraněn) |

---

## 4. Přihlášení a uživatelé

### Přihlášení
Systém používá JWT autentizaci. Po přihlášení (uživatelské jméno + heslo) dostane prohlížeč Bearer token platný po dobu session.

### Role uživatelů
- **admin** — plný přístup, správa uživatelů, zápis do konfigurace
- **user** — čtení dat, ruční triggery (scan, discovery, poll), bez správy uživatelů a konfigurace

### Správa uživatelů
Sekce **Uživatelé** (menu vlevo) umožňuje adminovi:
- Přidat nového uživatele (jméno, heslo, role)
- Změnit heslo nebo roli
- Smazat uživatele
- Vygenerovat API klíč pro přístup z externích systémů

### API klíče
Každý uživatel může mít API klíč (X-API-Key hlavička) pro přístup z externích systémů bez JWT tokenu. Klíče jsou zobrazeny pouze při vytvoření.

---

## 5. Navigace a rozhraní

### Levé menu
Aplikace má levé navigační menu se všemi sekcemi. Menu lze **skrýt a zobrazit** kliknutím na malé tlačítko `◀ / ▶` přilepené k pravému okraji panelu — hlavní obsah se automaticky rozšíří na celou šířku. Stav menu se ukládá do `localStorage` a přežije refresh stránky.

### Dashboard

Hlavní přehledová stránka zobrazuje aktuální stav celé sítě na první pohled.

### Metriky nahoře
- **Celkem IP** — počet sledovaných IP adres v aktivních rozsazích
- **Online** — počet IP odpovídajících na ping (zelená)
- **Offline** — počet IP neodpovídajících (červená)
- **Uptime %** — průměrná dostupnost za posledních 24 hodin

### Tabulka hostů
Přehled všech IP adres s aktuálním stavem, posledním RTT a výpadky. Kliknutím na IP se zobrazí detail s grafem RTT trendu.

### Graf
RTT trend pro vybrané IP za zvolené časové období.

---

## 6. Evidence zařízení

Centrální seznam všech síťových zařízení evidovaných v systému — routery, switche, přístupové body, kamery, servery, klientská zařízení atd.

### Co se eviduje
Každé zařízení má:
- **Hostname** — název zařízení
- **Alias** — přezdívka (volitelná, zobrazuje se místo hostname)
- **IP adresa** — primární IP
- **MAC adresa** — fyzická adresa
- **Typ zařízení** — z číselníku (Router, Switch, AP, Kamera, ...)
- **Výrobce** — z číselníku nebo zjištěno automaticky
- **Uživatel/zákazník** — komu zařízení patří
- **Lokace** — kde se fyzicky nachází (ze stromové struktury lokací)
- **Přihlašovací profily** — přiřazené kredenciály pro poll/backup/discovery

### Karty statistik
- Celkem zařízení / Online / Offline / S umístněním

### Filtry
- Fulltext (hostname, IP, alias, MAC, výrobce)
- Stav (online/offline/vše)
- Bez IP (zařízení bez přiřazené IP adresy)
- Typ zařízení
- Uživatel/zákazník
- **Lokace** — fulltext prohledává celou hierarchii lokací včetně nadřazených. Hledání "Hybešova" najde všechna zařízení v jakékoliv podlokaci budovy Hybešova 46. Hledání "Suterén" najde jen zařízení v suterénu.
- Výrobce
- Export do CSV

### Sloupec Lokace
Zobrazuje **celou cestu hierarchií** — např. `Bubeníčkova 30 Brno > Suterén`. Najetím myší (tooltip) se zobrazí plná cesta.

### Přidání zařízení bez IP
Zařízení lze zaregistrovat i bez IP adresy — scanner nebo discovery ji doplní automaticky jakmile zařízení začne odpovídat. Formulář nabízí dvě možnosti:
- **Ze seznamu** — výběr z IP adres které scanner již zaznamenal (online/offline filtr)
- **Zadat ručně** — libovolná IP adresa
- **Bez IP** — zařízení se uloží bez IP, přiřadit ji lze kdykoliv v detailu

### Detail zařízení (panel vpravo)
Po kliknutí na zařízení se otevře boční panel se záložkami:

**Základní údaje**
- Editace všech atributů zařízení
- Toggle "Cron Poll" — zapíná/vypíná automatický poll pro toto zařízení
- Toggle "Backup" — zapíná/vypíná automatický backup

**Discovery**
- Ruční spuštění discovery pro dané zařízení
- Výsledky posledního discovery: hostname, MAC, výrobce, otevřené porty, HTTP server, TLS certifikát, SNMP info

**Poll**
- Ruční spuštění pollu
- Výsledky posledního pollu: uptime, verze firmware, model, rozhraní, ARP záznamy, DHCP leases, routing table
- Historie pollů

**Backup**
- Ruční spuštění zálohy
- Seznam záloh zařízení s datem, velikostí, stažením

**IP adresy**
- Přehled IP adres které zařízení vidí v síti (z ARP/DHCP pollingu)
- Historie přiřazení IP k MAC adresám

### Přidání zařízení
Tlačítko "+ Registrovat nové zařízení" otevře formulář:
1. Hostname (povinné)
2. IP adresa
3. MAC adresa
4. Typ, výrobce, uživatel, lokace
5. Přiřazení přihlašovacích profilů

---

## 7. IP Adresy (Hosts)

Přehled všech IP adres sledovaných ping scanem — nezávisle na evidenci zařízení.

### Rozdíl oproti Evidence zařízení
Evidence zařízení obsahuje *ručně registrovaná* zařízení. IP Adresy zobrazují *všechny* IP adresy ze sledovaných rozsahů, včetně těch které nejsou v evidenci.

### Sloupce
- IP adresa (kliknutelná — detail s grafem RTT)
- Hostname (z DNS nebo discovery)
- Stav (online/offline)
- RTT (poslední naměřená odezva v ms)
- Uptime % (za posledních 24h)
- Počet výpadků (za posledních 24h)
- Poslední scan
- Zařízení (odkaz na evidenci, pokud existuje)

### Filtr
- Fulltext (IP, hostname)
- Stav (online/offline)
- Rozsah (podle IP rozsahu)

---

## 8. Grafy RTT

Vizualizace RTT trendu pro libovolnou IP adresu nebo zařízení.

### Jak používat
1. Vyber IP adresu nebo zařízení z dropdown menu
2. Zvol časové období (1h, 6h, 24h, 7 dní, 30 dní)
3. Graf zobrazí průběh RTT v čase

### Interpretace grafu
- **Zelená čára** — RTT v ms (nižší = lepší)
- **Červené body/oblasti** — výpadky (IP neodpovídala)
- **Skoky** — síťové problémy, přetížení linky

---

## 9. Sítě (Sites)

Logické skupiny IP rozsahů — umožňují organizovat síť podle lokalit, zákazníků nebo účelu.

### Příklad struktury
```
Site: V6 Hybešova
  ├── IP Range: 172.28.15.0/24 (Patro 1)
  ├── IP Range: 172.28.21.0/24 (Patro 2)
  └── IP Range: 172.28.27.0/24 (WiFi)

Site: Nemocnice
  ├── IP Range: 10.101.111.0/24
  └── IP Range: 10.101.112.0/24
```

### Správa
- Přidat / přejmenovat / smazat site
- Každý IP rozsah je přiřazen právě jednomu site

---

## 10. IP Rozsahy

Definice síťových rozsahů které NetPulse sleduje ping scanem.

### Co definuje rozsah
- **Síť** — CIDR notace (např. `172.28.15.0/24`)
- **Popis/label** — srozumitelný název
- **Site** — ke které lokalitě patří
- **Scan enabled** — zda se rozsah pinguje (lze vypnout bez smazání)

### Validace při vytváření a úpravě rozsahu

Při každém uložení rozsahu systém automaticky provede:

**Blokující chyby (nelze uložit):**
- **Nevalidní CIDR notace** — formát musí být např. `172.28.15.0/24`. Neplatné výrazy jako `172.28.15/24` nebo `abc` jsou odmítnuty.
- **Duplicitní rozsah** — stejný CIDR (`172.28.15.0/24`) již v databázi existuje, bez ohledu na site. Každý rozsah musí být unikátní.

**Varování (lze přeskočit):**
- **Překryv v rámci stejného site** — nový rozsah se překrývá s existujícím rozsahem ve stejném site (jeden obsahuje druhý). Systém zobrazí varování a zeptá se zda chcete uložit přesto. Překryv mezi různými sites je povolen — různé sites mohou mít stejné adresní prostory (různé VRF, NAT segmenty).

**Automatická normalizace:**
- Pokud je zadána IP s nastaveným hostovým bitem (např. `172.28.15.5/24`), systém automaticky normalizuje na síťovou adresu (`172.28.15.0/24`). Normalizace se zobrazí jako varování v dialogu.

### Proxy MikroTik
Každý rozsah může mít přiřazený **proxy MikroTik** pro ARP scan. Místo přímého pingu backend dotazuje MikroTik router v dané síti přes API a získá aktuální ARP tabulku. Tím lze sledovat i zařízení za NATem nebo na oddělených segmentech.

**Režimy proxy:**
- `auto` — systém automaticky vybere nejlepší proxy
- `manual` — explicitně vybraný MikroTik
- `direct` — přímý ping bez proxy

### Proxy badge
V tabulce rozsahů je zobrazena barevná badge s aktuálním proxy zařízením a jeho stavem.

### Mazání rozsahu
Před smazáním systém zobrazí přehled dopadu:
- Počet evidovaných zařízení v rozsahu (nebudou smazána, ale přestanou být skenována)
- Počet evidovaných IP adres v rozsahu
- Historická ping data zůstanou zachována i po smazání rozsahu

---

## 11. Neznámé sítě

Automaticky detekované sítě, které se objevily v ARP datech MikroTik routerů ale nejsou definovány jako sledovaný IP rozsah.

### K čemu slouží
- Upozornění na nové subnety v síti
- Podklad pro přidání nových rozsahů do monitoringu

### Akce
- Zobrazení IP adres v neznámé síti
- Přidání jako nový IP rozsah jedním kliknutím
- Ignorování (smazání ze seznamu)

---

## 12. Network Awareness — MAC inventář

Přehled všech MAC adres detekovaných v síti prostřednictvím ARP tabulek MikroTik routerů.

### K čemu slouží
- Víte co reálně vidí váš router v síti — nejen co máte evidováno
- Detekce neznámých/neevidovaných zařízení
- Sledování změn IP adres (přiřazení DHCP)
- Online/offline stav MAC adres v reálném čase

### Metriky nahoře
- **Celkem MAC** — celkový počet unikátních MAC adres
- **Online** — aktuálně viditelné v ARP tabulce
- **Nové (7 dní)** — poprvé zaznamenané za posledních 7 dní
- **Neevidované** — nemají přiřazené zařízení v evidenci

### Záložka Inventář

Kompletní seznam MAC adres se sloupci:
- Stav (zelená tečka = online, šedá = offline)
- **MAC adresa** + badge "nové" (7 dní)
- **IP adresa** — poslední zjištěná IP
- **Vendor** — výrobce zjištěný z OUI tabulky
- **Zařízení** — odkaz na evidenci zařízení (pokud přiřazeno)
- **Proxy** — MikroTik ze kterého bylo zjištěno
- **Poprvé viděno** / **Naposledy** — s datem, časem a vteřinami

**Filtry:**
- Výběr MikroTiku (proxy device)
- Vyhledávání (MAC, IP, vendor)
- Všechna zařízení / Se zařízením / Bez zařízení
- 🆕 Nové MAC — jen nově detekované (7 dní)
- ⚠️ Neevidované — jen bez záznamu v evidenci

**Rychlá akce "Přidat"**
U každého neevidovaného MAC je tlačítko pro rychlé přidání do evidence zařízení — formulář bude předvyplněn MAC, IP a vendorem.

**Stránkování:** 256 záznamů na stránku

### Záložka Události

Chronologický přehled změn v síti, seskupený podle MAC adresy.

**Typy událostí:**
- 🆕 **Nové** — MAC poprvé zaznamenán v síti
- 🔄 **Změna IP** — MAC dostal jinou IP adresu (DHCP přiřazení)
- 📶 **Online** — MAC se vrátil do sítě po výpadku
- 📴 **Offline** — MAC přestal být viditelný (15+ minut)

**Seskupení po MAC:**
Každý řádek představuje jednu MAC adresu s přehledem:
- MAC adresa
- Poslední IP
- Typ aktivity (badge: Změna IP / Offline / Nové)
- Poslední změna (datum + čas + vteřiny)
- Počet událostí
- Zařízení (evidované)
- Proxy (MikroTik)

Kliknutím se skupina rozbalí a zobrazí jednotlivé události.

**Filtry událostí:**
- Časové okno (6h / 24h / 72h / 7 dní)
- Typ aktivity
- Vyhledávání podle MAC nebo IP

### Jak funguje synchronizace
Po každém Poll cyklu (každých 6 minut) systém:
1. Načte ARP tabulku z MikroTiku
2. Porovná se stavem v `mac_inventory`
3. Detekuje nové MAC, změny IP, přechody online/offline
4. Zapíše události do `mac_events`

### Ruční sync
Tlačítko "Sync MAC" (po výběru konkrétního MikroTiku) okamžitě spustí synchronizaci bez čekání na automatický cyklus.

---

## 13. Přihlašovací profily

Uložené přístupové údaje pro komunikaci se zařízeními — používají se při Discovery, Poll a Backup.

### Typy přihlašovacích profilů

| Typ | Použití |
|---|---|
| `api` | MikroTik RouterOS API (port 8728/8729) |
| `ssh` | SSH přístup (MikroTik i Linux) |
| `snmp` | SNMP v1/v2c/v3 |
| `http` | HTTP/HTTPS základní autentizace |

### Atributy profilu
- **Název** — srozumitelný identifikátor
- **Typ** (api / ssh / snmp / http)
- **Uživatelské jméno**
- **Heslo** — šifrováno v databázi pomocí DB_ENCRYPTION_KEY
- **SNMP community** (pro SNMP typ)
- **Port** (volitelný, výchozí dle typu)
- **Priorita** — při pollu se vyzkouší více profilů, vyšší priorita = první pokus
- **Výrobce** — pokud nastaveno, profil se použije přednostně pro zařízení daného výrobce

### Přiřazení k zařízení
Profily se přiřazují zařízením v detailu zařízení. Jedno zařízení může mít více profilů — systém zkusí každý dokud se nepřihlásí.

### Bezpečnost
Hesla jsou šifrována symetrickým klíčem (DB_ENCRYPTION_KEY) a nikdy se nezobrazují v API odpovědích ani v UI. Klíč musí být nastaven před prvním použitím — při změně klíče jsou stará hesla nečitelná.

---

## 14. Scan — Ping monitoring

Základní funkce NetPulse — pravidelné pingování všech IP adres ve sledovaných rozsazích.

### Co dělá
1. Vezme všechny aktivní IP rozsahy
2. Vygeneruje seznam IP adres (s výjimkou vyloučených IP)
3. Pinguje každou IP (ICMP echo request)
4. Uloží výsledek (online/offline, RTT) do databáze
5. Detekuje výpadky (přechod online→offline a zpět)

### Metody skenování
- **icmplib** (výchozí) — nativní Python ICMP, nevyžaduje fping
- **fping** — externího nástroj, rychlejší pro velké rozsahy (pokud je nainstalován)

Backend běží s `network_mode: host` a `cap_add: NET_RAW` pro privilegované ICMP.

### Proxy ARP scan
Pokud má rozsah nastavenou proxy, scan proběhne přes MikroTik API místo přímého pingu:
1. Načte ARP tabulku z MikroTiku → seznam IP které router vidí
2. Doplní přímým pingem IP které v ARP chybí (mohou být offline)

### Parametry (Nastavení → Scan)
| Parametr | Výchozí | Popis |
|---|---|---|
| Interval scanu | 300 s | Jak často se pinguje (5 minut) |
| Počet pingů na IP | 3 | Kolikrát se každá IP pingne |
| Timeout pingu | 1000 ms | Maximální čekání na odpověď |
| Max. souběžných pingů | 100 | Paralelismus (vyšší = rychlejší, více RAM/CPU) |
| RTT práh pro alert | 0 ms | Při překročení se loguje varování (0 = vypnuto) |
| Email pro alerty | — | Kam posílat notifikace (zatím rezervováno) |

### Retence dat
Výsledky pingů se ukládají po dobu nastavenou v "Retence dat (dny)" — výchozí 30 dní. Starší záznamy automatický cleanup smaže.

### Vyloučení IP ze scanu (Scan Exclusions)
V záložce "Scan Exclusions" (Nastavení) lze přidat IP adresy které se nemají pingovat — např. broadcast adresy, gateway, management IP.

### Ruční scan
Tlačítko "Spustit scan" v Nastavení → záložka Scan okamžitě spustí scan bez čekání na interval.

### Historie scanů
Stránka **Historie scanů** zobrazuje log proběhlých scan jobů s datem, počtem IP, dobou trvání a výsledkem.

---

## 15. Discovery — Identifikace zařízení

Discovery sbírá podrobné informace o online zařízeních — více než jen "odpovídá na ping".

### Co Discovery zjišťuje (vrstvy)

| Vrstva | Co dělá |
|---|---|
| **rDNS** | Reverzní DNS lookup — hostname ze záznamu PTR |
| **ARP** | MAC adresa ze systémové ARP tabulky |
| **OUI** | Výrobce zařízení z MAC adresy (OUI databáze) |
| **Port scan** | Otevřené TCP porty (22, 23, 80, 443, 8080, 8728, 8729...) |
| **Banner** | Textový banner na otevřených portech (SSH verze, FTP banner...) |
| **HTTP** | HTTP/HTTPS fingerprinting — server header, title stránky, status kód |
| **TLS** | Certifikát — CN, SAN domény, vydavatel, platnost |
| **SNMP** | sysDescr, sysName, sysUpTime, sysContact, sysLocation |

### Výsledky discovery
Po dokončení se do záznamu zařízení uloží:
- Hostname (z rDNS nebo SNMP sysName)
- MAC adresa
- Výrobce (z OUI)
- Seznam otevřených portů
- HTTP server a title
- TLS Common Name a platnost
- SNMP popis systému

### Podmínky spuštění
- Discovery se spouští pouze pro zařízení která jsou **online** (odpovídají na ping)
- Volitelně: přeskočit zařízení která mají čerstvý poll (nastavení "Přeskočit zařízení s pollem")
- Volitelně: pouze online zařízení (nastavení "Pouze online zařízení")

### Automatický scheduler
V Nastavení → záložka Discovery lze nastavit:
- **Zapnout/vypnout** automatický discovery
- **Interval** — jak často (doporučeno 3600 s = 1 hodina)
- **Pouze online** — přeskočit offline zařízení
- **Přeskočit polled** — přeskočit zařízení s čerstvým pollem (poll zjistil data přesněji)

### Ruční discovery
- Tlačítko v Nastavení → záložka Discovery spustí discovery pro všechna zařízení
- Tlačítko v detailu zařízení spustí discovery pro jedno konkrétní zařízení

---

## 16. Poll — Sběr dat ze zařízení

Poll je hlubší dotazování konkrétních zařízení pro získání provozních dat — uptime, rozhraní, ARP, DHCP, routing, systémové info.

### Rozdíl mezi Scan, Discovery a Poll

| | Scan | Discovery | Poll |
|---|---|---|---|
| **Co dělá** | Ping — online/offline | Identifikace | Provozní data |
| **Pro koho** | Všechny IP v rozsazích | Registrovaná zařízení | Registrovaná zařízení s přihl. profilem |
| **Metoda** | ICMP ping | TCP, HTTP, SNMP, DNS | API, SNMP, SSH |
| **Výsledek** | RTT, dostupnost | Hostname, porty, vendor | Uptime, rozhraní, ARP, DHCP, routing |
| **Interval** | Každých 5 min | Každou hodinu | Každých 6 min (konfigurovatelné) |

### Metody pollu

**1. MikroTik API (nejlepší pro MikroTik)**
Připojí se přes RouterOS API (port 8728 nebo 8729 SSL) a získá:
- Uptime systému
- Verzi RouterOS
- Model zařízení
- Sériové číslo
- Volnou/celkovou paměť RAM
- Volné místo na disku
- Teplotu (pokud zařízení podporuje)
- Zatížení CPU
- Seznam rozhraní (název, IP, MAC, stav link, rychlost)
- ARP tabulku (IP ↔ MAC ↔ interface)
- DHCP leases (IP ↔ MAC ↔ hostname ↔ čas vypršení)
- Sousední zařízení (CDP/LLDP Neighbor list) — základ pro topologii

**2. SNMP (univerzální)**
Dotazuje zařízení přes SNMP v1/v2c/v3 a získá:
- sysDescr (popis systému)
- sysName (hostname)
- sysUpTime (uptime)
- sysContact, sysLocation
- Seznam rozhraní (ifTable) — stav, rychlost, MAC, IP
- ARP tabulku (ipNetToMediaTable)
- Vlastní IP adresy (ipAddrTable)

**3. SSH (pro MikroTik a Linux)**
- MikroTik: spustí `/system resource print`, `/interface print`, `/ip arp print`
- Linux: `uptime`, `ip addr`, `ip arp`, `df -h`
- Generic: pokusí se o základní příkazy

**4. HTTP**
Pokusí se připojit na HTTP/HTTPS port a získat základní info.

### Výběr metody
Systém automaticky vyzkouší dostupné přihlašovací profily podle priority a typu výrobce. Použije první který uspěje.

### MAC inventory sync
Po každém úspěšném pollu MikroTiku systém automaticky aktualizuje MAC inventář (Network Awareness) — porovná ARP tabulku s uloženými záznamy a detekuje změny.

### Cron Poll (per zařízení)
V detailu zařízení (záložka Základní údaje) je toggle **"Cron Poll"**:
- ✅ Zapnuto — zařízení je zahrnuto do automatického poll scheduleru
- ⬜ Vypnuto — automatický poll toto zařízení přeskakuje (ruční poll stále funguje)

### Nastavení poll scheduleru
V Nastavení → záložka Poll:
- **Zapnout/vypnout** automatický poll scheduler
- **Interval** — jak často (výchozí 360 s = 6 minut)

### Výsledky pollu
V detailu zařízení záložka Poll:
- Datum a čas posledního pollu
- Použitá metoda (api/snmp/ssh)
- Uptime, verze, model
- Seznam rozhraní s IP, MAC a stavem
- ARP záznamy (IP ↔ MAC ↔ interface)
- DHCP leases
- Graf history pollů

---

## 17. Backup — Zálohy konfigurace

Automatické zálohování konfigurace MikroTik routerů ve formátu `.rsc` (RouterOS export).

### Co se zálohuje
Konfigurace MikroTik routeru — výstup příkazu `/export verbose`. Soubor obsahuje celou konfiguraci: interfaces, IP adresy, routing, firewall, DHCP, bridge, VPN atd.

### Metody zálohy

**Přes MikroTik API**
1. Připojí se přes RouterOS API
2. Spustí `/export verbose`
3. Stáhne textový výstup
4. Uloží jako `.rsc` soubor s timestampem

**Přes SSH**
1. Připojí se přes SSH
2. Spustí `export verbose` na CLI
3. Stáhne výstup

Systém automaticky zkusí API a v případě neúspěchu přepne na SSH.

### Formát souboru
```
<hostname>_<YYYYMMDD_HHMMSS>.rsc
Příklad: V6_NETINET_ROUTER_20260611_214500.rsc
```

### Kde jsou zálohy uloženy
Na serveru v Docker volume `backup_data` → `/backups/<device_uuid>/`. Zálohy jsou persistentní — přežijí restart kontejneru.

### Podmínky zálohy
V Nastavení → záložka Backup lze nastavit:
- **Pouze online** — nezálohovat zařízení která neodpovídají na ping
- **Pouze zařízení s úspěšným pollem** — nezálohovat zařízení kde poll selhal (zařízení pravděpodobně nedostupné přes API/SSH)

### Automatický scheduler
- **Zapnout/vypnout** automatický backup
- **Interval** — jak často (výchozí 86400 s = 1 den)
- **Čas spuštění** — v kolik hodin denně (např. `02:00` = v noci)
- Pro interval ≥ 24h se použije přesný CronTrigger (backup vždy ve stejný čas)
- Pro kratší interval se použije IntervalTrigger od nastaveného času

### Per-zařízení zapnutí/vypnutí
V Nastavení → záložka Backup je seznam všech zařízení s přepínačem zapnutí zálohy. Stejný toggle je i v detailu zařízení.

### Ruční záloha
- Tlačítko "Zálohovat vše" v Nastavení → Backup
- Tlačítko "Zálohovat" v detailu konkrétního zařízení

---

## 18. Zálohy (přehled)

Stránka **Zálohy** zobrazuje všechny uložené zálohy konfigurace.

### Co se zobrazuje
- Zařízení (hostname)
- Datum a čas zálohy
- Velikost souboru
- Verze RouterOS (extrahovaná ze záhlaví exportu)
- Metoda zálohy (api / ssh)
- Stav (úspěch / chyba)

### Akce
- **Stáhnout** — stažení `.rsc` souboru do počítače
- **Smazat** — smazání zálohy ze serveru

### Statistiky
Karty nahoře: Celkem záloh / Úspěšné / Neúspěšné / Celková velikost

---

## 19. Lokace

Hierarchická stromová struktura fyzických umístění — budovy, patra, místnosti, rozvaděče.

### Struktura
Lokace tvoří strom s neomezenou hloubkou. Příklad:
```
Hybešova 46
  ├── Přízemí
  │   ├── Recepce — Rozvaděč R01
  │   └── Serverovna
  ├── 1. patro
  │   ├── Kancelář 101
  │   └── Kancelář 102
  └── Střecha
      └── AP sektorové

Václavská 6
  ├── Suterén
  └── Přízemí
```

### Typy lokací
Konfigurovatelné v Konfigurace → Typy lokací. Každý typ může mít emoji ikonu pro lepší orientaci.

### Zobrazení

**Stromové zobrazení** (Lokace strom)
Interaktivní strom s rozbalováním. Kliknutím na lokaci zobrazíte přiřazená zařízení.

**Tabulkové zobrazení** (Lokace tabulka)
Plochý seznam všech lokací s počty zařízení, možností filtrace a třídění.

### Přiřazení zařízení
Každé zařízení v evidenci může mít přiřazenou lokaci. Lokace pak zobrazuje počet a seznam zařízení.

---

## 20. Mapy

Vizuální zobrazení lokací a zařízení na geografické mapě nebo mapě areálu.

### Přepínač mapových podkladů

Obě mapy mají v pravém horním rohu přepínač podkladové vrstvy:
- **🗺️ Mapa** — OpenStreetMap, zoom až do 22 (dlaždice do 19, zbytek škálovaný)
- **🛰️ Satelit** — Esri World Imagery, satelitní snímky, zoom až do 23, zdarma bez API klíče

### Mapa lokací

Interaktivní geografická mapa (Leaflet) s markery lokací. Kliknutím na marker se zobrazí detail lokace a přiřazená zařízení.

**Levý panel** obsahuje:
- Vyhledávání lokací (geocoding přes Nominatim/OpenStreetMap)
- Filtr typů lokací
- Filtr stavu zařízení (vše / s offline / bez zařízení)
- Seskupování markerů (clustering)

**Vrstvy mapy** (levý panel — sekce "Vrstvy mapy"):
- **☑ Areál OLTEC (polygony + linie)** — výchozí zapnuto. Zobrazí polygony budov a obvod areálu z KML souboru.
- **☐ OLTEC — markery (body zájmu)** — výchozí vypnuto. Point prvky z KML (vstupní body, zajímavá místa).
- **☐ OLTEC — popisky** — výchozí vypnuto. Textové popisky uprostřed polygonů budov.

KML se načte pouze jednou při prvním zapnutí — přepínání vrstev pak probíhá okamžitě bez opětovného stahování.

### Mapa areálu (OLTEC)

Detailní mapa areálu Hybešova/Václavská načtená z KML souboru. Zobrazuje polygony budov s barevným odlišením, obvod areálu a markery lokací ze stromové evidence.

**Toolbar** (pravý horní roh):
- Přepínač 🗺️ Mapa / 🛰️ Satelit
- Tlačítko Popisky — zobrazí/skryje textové popisky budov

**Technicky:** KML soubor je uložen v `shared/maps/oltec.kml` a servírován přes Next.js API endpoint `/api/maps/[filename]`. Barvy polygonů jsou konvertovány z KML formátu ABGR na CSS hex.

### Přidání vlastní mapy
```bash
# Zkopíruj KML soubor do shared složky
cp novy_soubor.kml ~/netpulse/shared/maps/novy_soubor.kml
# Soubor je ihned dostupný přes /api/maps/novy_soubor.kml
# Restart není potřeba
```

---

## 21. Log výpadků

Chronologický přehled všech detekovaných výpadků — přechodů online→offline a zpět.

### Co se zaznamenává
- IP adresa
- Čas začátku výpadku
- Čas obnovení
- Délka výpadku
- Hostname (pokud znám)
- Zařízení (odkaz na evidenci, pokud existuje)

### Filtry
- Časové období
- IP adresa nebo hostname
- Minimální délka výpadku (filtrování krátkých fluktuací)

### Statistiky
- Celkový počet výpadků za zvolené období
- Nejpostiženější IP adresy
- Průměrná délka výpadku

---

## 22. Log změn

Přehled změn konfigurace zařízení zjištěných porovnáním výsledků pollů nebo discovery.

### Co se sleduje
- Změna IP adresy
- Změna hostname
- Změna verze firmware
- Změna systémových parametrů

### Zobrazení
Chronologický seznam s hodnotou před a po změně.

---

## 23. Nastavení

Centrální správa všech schedulerů a systémových parametrů. Přístupné přes menu vlevo.

### Záložka Scan

**Aktuální stav scanu**
- Karta "Stav" — Probíhá / Čeká
- Karta "Celkem scanů" — počet dokončených scan jobů
- Karta "Celkem IP" — počet sledovaných IP adres
- Tlačítko "Spustit scan" — okamžité spuštění

**Parametry scanu**
| Parametr | Výchozí | Popis |
|---|---|---|
| Interval scanu (s) | 300 | Perioda opakování (min 10s, max 86400s) |
| Počet pingů na IP | 3 | Kolik ICMP requestů se pošle (průměr = RTT) |
| Timeout pingu (ms) | 1000 | Timeout na jeden ping (při překročení = packet loss) |
| Max. souběžných pingů | 100 | Paralelní vlákna (100 = 100 IP najednou) |
| RTT práh pro alert (ms) | 0 | Logování varování při vysokém RTT (0 = vypnuto) |
| Email pro alerty | — | Příjemce alertů |

**Retence dat ping výsledků**
| Parametr | Výchozí | Popis |
|---|---|---|
| Retence dat (dny) | 30 | Záznamy starší než X dní se smažou |

**Automatický cleanup**
| Parametr | Výchozí | Popis |
|---|---|---|
| Cleanup zapnut | ✅ | Automatické mazání starých dat |
| Počet dní pro zachování dat | 30 | Retence MAC events a ping results |
| Čas spuštění | 02:00 | V kolik hodin cleanup proběhne |

**Scan Exclusions**
Seznam IP adres vyloučených z ping scanu. Typicky:
- Broadcast adresy (`.0`, `.255`)
- Management IP routerů (pokud nechcete sledovat)
- Testovací IP adresy

### Záložka Discovery

| Parametr | Výchozí | Popis |
|---|---|---|
| Automatický discovery | ✅ | Zapnutí/vypnutí scheduleru |
| Interval discovery (s) | 3600 | Perioda (doporučeno 1-4 hodiny) |
| Pouze online zařízení | ✅ | Přeskočit zařízení bez odpovědi na ping |
| Přeskočit zařízení s pollem | ✅ | Přeskočit zařízení kde poll proběhl (poll dat je více) |

### Záložka Poll

| Parametr | Výchozí | Popis |
|---|---|---|
| Automatický poll scheduler | ✅ | Zapnutí/vypnutí scheduleru |
| Interval pollu (s) | 360 | Perioda (výchozí 6 minut) |

Pozn.: Poll se spustí pouze pro zařízení s aktivním "Cron Poll" přepínačem a přiřazeným přihlašovacím profilem.

### Záložka Backup

| Parametr | Výchozí | Popis |
|---|---|---|
| Automatický backup scheduler | ✅ | Zapnutí/vypnutí scheduleru |
| Interval zálohy (s) | 86400 | Perioda (výchozí 1 den) |
| Čas spuštění | — | Při intervalu ≥ 24h: přesný čas denní zálohy |
| Pouze online zařízení | ✅ | Nezálohovat offline zařízení |
| Pouze zařízení s úspěšným pollem | ✅ | Nezálohovat zařízení kde poll selhal |

**Tabulka zařízení** — přehled všech zařízení s:
- Online/offline stav
- Poll proběhl (ikona hodin)
- Backup zapnut/vypnut (přepínač)

Tlačítko "Zálohovat vše" spustí zálohu všech povolených zařízení okamžitě.

### Záložka System Info

Přehled verzí komponent:
- Backend (FastAPI + asyncpg)
- Frontend (Next.js 14 / React 18)
- Scanner (icmplib)
- Backup (asyncssh / RouterOS export)
- Databáze (PostgreSQL)

Tlačítko "Smazat orphan záznamy" — ruční vyčištění osiřelých ping_results bez přiřazeného rozsahu.

### Záložka Nápověda

Zobrazuje tuto příručku přímo v aplikaci — formátovaný Markdown s nadpisy, tabulkami, kódovými bloky a seznamy. Obsah je načítán ze souboru `README.md` umístěného ve složce `frontend-react/public/`.

**Aktualizace nápovědy** — stačí překopírovat nový `README.md` do `~/netpulse/frontend-react/public/README.md` bez nutnosti rebuildu frontendu. Soubory ve složce `public` jsou servírovány staticky.

---

## 24. Konfigurace (číselníky)

Editovatelné číselníky pro kategorizaci zařízení a lokací.

### Typy zařízení
Kategorie pro pole "Typ" v evidenci zařízení. Příklady:
- Router, Switch, AP, Kamera, Server, PC, Tiskárna, UPS, ...

Každý typ má: ID (interní klíč), Název (zobrazovaný), Pořadí, Aktivní.

### Typy lokací
Kategorie pro hierarchii lokací. Každý typ může mít emoji ikonu. Příklady:
- 🏢 Budova, 🏬 Patro, 🚪 Místnost, 🗄️ Rozvaděč, 📡 Střecha, ...

### Správa číselníků
- Přidat novou položku (ID + Název + Ikona + Pořadí)
- Editovat existující (přejmenování, ikona, pořadí)
- Deaktivovat (zachování v historii, ale nezobrazuje se v nových záznamech)
- Smazat (pouze pokud není použita)

---

## 25. System Logs

Protokol interních událostí backendu — chyby, varování, informační zprávy.

### Co se loguje
- Starty a zastavení schedulerů
- Výsledky scan/discovery/poll/backup jobů
- Chyby připojení k zařízením
- Varování o výpadcích
- Informace o cleanup operacích

### Filtry
- Úroveň (DEBUG / INFO / WARNING / ERROR / CRITICAL)
- Zdrojový modul (scheduler, poller, scanner, backup, ...)
- Časové období
- Fulltext hledání

### Statistiky
- Počty logů dle úrovně za posledních 24h
- Graf výskytu chyb v čase

### Cleanup logů
V systémovém nastavení lze nastavit retenci systémových logů (výchozí 30 dní). Ruční cleanup je dostupný tlačítkem.

---

## 26. API a přístup pro externí systémy

NetPulse poskytuje REST API pro integraci s externími systémy.

### Autentizace

**JWT Bearer Token**
```bash
# Přihlášení
curl -X POST http://IP:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"heslo"}'

# Odpověď: {"access_token": "eyJ..."}

# Použití tokenu
curl http://IP:8000/hosts \
  -H "Authorization: Bearer eyJ..."
```

**API Key**
```bash
curl http://IP:8000/hosts \
  -H "X-API-Key: váš-api-klíč"
```

### Klíčové endpointy

| Endpoint | Metoda | Popis |
|---|---|---|
| `/health` | GET | Stav backendu |
| `/hosts` | GET | Statistiky všech sledovaných IP |
| `/hosts/{ip}/stats` | GET | Detail jedné IP (RTT, uptime, výpadky) |
| `/hosts/{ip}/rtt-trend` | GET | Graf RTT v čase |
| `/devices` | GET | Seznam evidovaných zařízení |
| `/scan/trigger` | POST | Spustit okamžitý scan |
| `/scan/status` | GET | Stav aktuálního scanu |
| `/ranges` | GET/POST/PUT/DELETE | Správa IP rozsahů |
| `/mac/stats` | GET | Statistiky MAC inventáře |
| `/mac/inventory` | GET | MAC inventář s filtry |
| `/mac/events` | GET | Historie MAC událostí |
| `/backups` | GET | Seznam záloh |
| `/backups/{id}/download` | GET | Stažení zálohy |
| `/config` | GET/PUT | Čtení/zápis konfigurace |

### Swagger dokumentace
Interaktivní API dokumentace dostupná na:
```
http://<IP_SERVERU>:8000/docs
```

---

## Rychlý průvodce pro nového správce

1. **Po instalaci** → Přihlás se, vytvoř přihlašovací profily (API/SSH pro MikroTiky)

2. **Přidej sítě** → Sítě → Přidat site → IP Rozsahy → Přidat rozsah pro každý subnet

3. **Přidej zařízení** → Evidence zařízení → Registrovat → Přiřaď přihlašovací profily

4. **Nastav proxy** → IP Rozsahy → Pro každý range vyber proxy MikroTik (který router daný segment vidí)

5. **Spusť první scan** → Nastavení → Scan → Spustit scan → počkej pár minut

6. **Pusť discovery** → Nastavení → Discovery → Spustit discovery → zjistí hostname, porty, vendor

7. **Pusť poll** → V detailu každého MikroTiku zapni "Cron Poll" → Nastavení → Poll → zkontroluj že scheduler běží

8. **Nastav backup** → V Nastavení → Backup → zapni pro MikroTiky → nastav čas zálohy

9. **Sleduj Network Awareness** → Po prvním poll cyklu se naplní MAC inventář → zkontroluj neevidovaná zařízení

10. **Pravidelně kontroluj** → Dashboard (přehled), Log výpadků (co bylo offline), Zálohy (úspěšnost)

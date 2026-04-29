# frontend/pages/4_nastaveni.py — Kompletní správa nastavení

import streamlit as st
from api_client import require_auth, ApiError

st.set_page_config(page_title="Nastavení — NetPulse", page_icon="⚙️", layout="wide")
client = require_auth()

st.title("⚙️ Nastavení")

# ---------------------------------------------------------------------------
# Načti aktuální konfiguraci a rozsahy
# ---------------------------------------------------------------------------
try:
    cfg    = client.get_config()
    ranges = client.get_ranges()
except ApiError as e:
    if e.status_code == 403:
        st.error("Pro správu nastavení je potřeba admin oprávnění.")
        st.stop()
    st.error(f"Chyba: {e.detail}")
    st.stop()

# ---------------------------------------------------------------------------
# TAB 1: Obecná konfigurace
# ---------------------------------------------------------------------------
tab_cfg, tab_ranges, tab_db, tab_users = st.tabs([
    "⚙ Obecná konfigurace", "🌐 IP rozsahy", "🗄 Databáze", "👤 Uživatelé"
])

with tab_cfg:
    st.subheader("Parametry scanu")

    with st.form("config_form"):
        col1, col2 = st.columns(2)

        with col1:
            scan_interval = st.number_input(
                "Interval scanu (sekundy)",
                min_value = 10, max_value = 86400,
                value     = int(cfg.get("scan_interval_s", 300)),
                step      = 10,
                help      = "Jak často se provádí automatický ping scan",
            )
            ping_count = st.number_input(
                "Počet pingů na IP",
                min_value = 1, max_value = 10,
                value     = int(cfg.get("ping_count", 3)),
                help      = "Počet ICMP paketů odeslaných na každou IP",
            )
            ping_timeout = st.number_input(
                "Timeout pingu (ms)",
                min_value = 100, max_value = 10000,
                value     = int(cfg.get("ping_timeout_ms", 1000)),
                step      = 100,
            )

        with col2:
            max_concurrent = st.number_input(
                "Max. souběžných pingů",
                min_value = 1, max_value = 1000,
                value     = int(cfg.get("max_concurrent", 128)),
                help      = "Vyšší hodnota = rychlejší scan, větší zatížení sítě",
            )
            retention_days = st.number_input(
                "Uchování dat (dny)",
                min_value = 1, max_value = 365,
                value     = int(cfg.get("retention_days", 30)),
            )
            alert_rtt = st.number_input(
                "Alert práh RTT (ms)",
                min_value = 0.0, max_value = 10000.0,
                value     = float(cfg.get("alert_rtt_ms", 100)),
                step      = 10.0,
                help      = "RTT nad touto hodnotou spustí alert",
            )

        st.subheader("Alerty")
        alert_email = st.text_input(
            "Email pro alerty",
            value       = cfg.get("alert_email", ""),
            placeholder = "admin@example.com",
        )

        if st.form_submit_button("💾 Uložit konfiguraci", type="primary"):
            updates = {
                "scan_interval_s": str(scan_interval),
                "ping_count":      str(ping_count),
                "ping_timeout_ms": str(ping_timeout),
                "max_concurrent":  str(max_concurrent),
                "retention_days":  str(retention_days),
                "alert_rtt_ms":    str(alert_rtt),
                "alert_email":     alert_email,
            }
            try:
                client.update_config(updates)
                st.success("✅ Konfigurace uložena! Scheduler restartován.")
                st.rerun()
            except ApiError as e:
                st.error(f"Chyba: {e.detail}")

    st.divider()

    # Zobraz aktuální konfiguraci jako read-only tabulku
    st.subheader("Aktuální hodnoty v databázi")
    cfg_display = {
        "scan_interval_s":  f"{cfg.get('scan_interval_s')} s",
        "ping_count":       cfg.get("ping_count"),
        "ping_timeout_ms":  f"{cfg.get('ping_timeout_ms')} ms",
        "max_concurrent":   cfg.get("max_concurrent"),
        "retention_days":   f"{cfg.get('retention_days')} dní",
        "alert_rtt_ms":     f"{cfg.get('alert_rtt_ms')} ms",
        "alert_email":      cfg.get("alert_email") or "—",
    }
    for k, v in cfg_display.items():
        col_k, col_v = st.columns([1, 2])
        col_k.code(k)
        col_v.write(v)


# ---------------------------------------------------------------------------
# TAB 2: IP rozsahy
# ---------------------------------------------------------------------------
with tab_ranges:
    st.subheader("Spravované IP rozsahy")

    if ranges:
        for rng in ranges:
            with st.expander(f"**{rng['label']}** — `{rng['network']}` {'✅' if rng['active'] else '⏸'}"):
                with st.form(f"range_{rng['id']}"):
                    c1, c2, c3 = st.columns([2, 2, 1])
                    new_label   = c1.text_input("Název", value=rng["label"],   key=f"lbl_{rng['id']}")
                    new_network = c2.text_input("CIDR",  value=rng["network"], key=f"net_{rng['id']}")
                    new_active  = c3.checkbox("Aktivní", value=rng["active"],  key=f"act_{rng['id']}")

                    bc1, bc2 = st.columns(2)
                    if bc1.form_submit_button("💾 Uložit"):
                        try:
                            client.update_range(rng["id"], new_label, new_network, new_active)
                            st.success("Uloženo")
                            st.rerun()
                        except ApiError as e:
                            st.error(e.detail)

                    if bc2.form_submit_button("🗑 Smazat", type="secondary"):
                        try:
                            client.delete_range(rng["id"])
                            st.success("Smazáno")
                            st.rerun()
                        except ApiError as e:
                            st.error(e.detail)
    else:
        st.info("Zatím žádné IP rozsahy")

    st.divider()
    st.subheader("Přidat nový rozsah")

    with st.form("add_range"):
        c1, c2, c3 = st.columns([2, 2, 1])
        new_lbl = c1.text_input("Název", placeholder="Kancelář")
        new_net = c2.text_input("CIDR",  placeholder="192.168.1.0/24")
        new_act = c3.checkbox("Aktivní", value=True)

        if st.form_submit_button("➕ Přidat", type="primary"):
            if not new_lbl or not new_net:
                st.error("Vyplň název i CIDR")
            else:
                try:
                    client.add_range(new_lbl, new_net, new_act)
                    st.success(f"Rozsah {new_net} přidán!")
                    st.rerun()
                except ApiError as e:
                    st.error(f"Chyba: {e.detail}")


# ---------------------------------------------------------------------------
# TAB 3: Databáze
# ---------------------------------------------------------------------------
with tab_db:
    st.subheader("Parametry připojení k PostgreSQL")
    st.info(
        "DB URL se nastavuje přes environment proměnnou `NETPULSE_DB_URL` "
        "nebo v souboru `.env`. Nelze měnit za běhu z bezpečnostních důvodů.",
        icon="ℹ️",
    )

    st.code(
        "# .env nebo systemd Environment=\n"
        "NETPULSE_DB_URL=postgresql://user:pass@localhost:5432/netpulse\n\n"
        "# Docker Compose\n"
        "environment:\n"
        "  - NETPULSE_DB_URL=postgresql://netpulse:netpulse@db/netpulse",
        language="yaml",
    )

    st.subheader("Inicializace schématu")
    st.code(
        "psql $NETPULSE_DB_URL < shared/schema.sql",
        language="bash",
    )

    st.subheader("Záloha dat")
    st.code(
        "pg_dump -t ping_results -t ip_ranges -t app_config $NETPULSE_DB_URL > backup.sql",
        language="bash",
    )


# ---------------------------------------------------------------------------
# TAB 4: Uživatelé
# ---------------------------------------------------------------------------
with tab_users:
    st.subheader("Správa uživatelů API")

    st.markdown("""
    **Role:**
    - `viewer` — čtení dat (GET endpointy)
    - `admin` — vše včetně správy konfigurace a uživatelů
    """)

    with st.form("create_user"):
        st.write("**Vytvořit nového uživatele**")
        c1, c2, c3 = st.columns(3)
        u_name = c1.text_input("Uživatelské jméno")
        u_pass = c2.text_input("Heslo (min. 8 znaků)", type="password")
        u_role = c3.selectbox("Role", ["viewer", "admin"])

        if st.form_submit_button("➕ Vytvořit uživatele", type="primary"):
            if not u_name or len(u_pass) < 8:
                st.error("Vyplň jméno a heslo (min. 8 znaků)")
            else:
                try:
                    # POST /auth/users
                    import requests, os
                    token = st.session_state.get("token", "")
                    r = requests.post(
                        f"{os.getenv('NETPULSE_API_URL','http://localhost:8000')}/auth/users",
                        json    = {"username": u_name, "password": u_pass, "role": u_role},
                        headers = {"Authorization": f"Bearer {token}"},
                        timeout = 10,
                    )
                    if r.ok:
                        st.success(f"Uživatel **{u_name}** ({u_role}) vytvořen!")
                    else:
                        st.error(r.json().get("detail", r.text))
                except Exception as e:
                    st.error(str(e))

    st.divider()

    st.subheader("Generovat API klíč")
    with st.form("gen_api_key"):
        desc = st.text_input("Popis klíče", placeholder="Grafana dashboard")
        if st.form_submit_button("🔑 Vygenerovat"):
            try:
                import requests, os
                token = st.session_state.get("token", "")
                r = requests.post(
                    f"{os.getenv('NETPULSE_API_URL','http://localhost:8000')}/auth/api-keys",
                    json    = {"description": desc},
                    headers = {"Authorization": f"Bearer {token}"},
                    timeout = 10,
                )
                if r.ok:
                    data = r.json()
                    st.success("API klíč vygenerován!")
                    st.code(data["api_key"])
                    st.warning("⚠️ Zkopíruj klíč nyní — zobrazí se pouze jednou!")
                else:
                    st.error(r.json().get("detail", r.text))
            except Exception as e:
                st.error(str(e))

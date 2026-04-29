# frontend/app.py

import streamlit as st
from api_client import require_auth, API_BASE

# set_page_config MUSÍ být první a JEDINÉ volání — nesmí být i v require_auth()
st.set_page_config(
    page_title            = "NetPulse",
    page_icon             = "📡",
    layout                = "wide",
    initial_sidebar_state = "expanded",
)

# require_auth() zobrazí login formulář pokud není token, jinak vrátí klienta
client = require_auth()

# ---------------------------------------------------------------------------
# Sidebar
# ---------------------------------------------------------------------------
with st.sidebar:
    st.markdown("## 📡 NetPulse")
    st.caption(f"API: `{API_BASE}`")

    if client.health():
        st.success("Backend online", icon="✅")
    else:
        st.error("Backend nedostupný", icon="❌")

    st.divider()

    # get_status() — bezpečné, nikdy nevyvolá st.stop()
    status = client.get_status()
    if status.get("running"):
        prog  = status.get("progress", 0) or 0
        done  = status.get("done_ips", 0)
        total = status.get("total_ips", 0)
        st.info(f"⟳ Scan probíhá... {done}/{total}")
        st.progress(prog / 100)
    else:
        last = status.get("last_scan") or "—"
        if last != "—":
            last = str(last)[:19].replace("T", " ")
        st.caption(f"Poslední scan: {last}")
        st.caption(f"Celkem scanů: {status.get('scan_count', 0)}")

    if st.button("▶ Skenovat nyní", width="stretch"):
        try:
            client.trigger_scan()
            st.success("Scan zahájen!")
            st.rerun()
        except Exception as e:
            st.error(str(e))

    st.divider()

    username = st.session_state.get("username", "—")
    st.caption(f"Přihlášen: **{username}**")
    if st.button("Odhlásit se", width="stretch"):
        for key in ["token", "api_key", "username"]:
            st.session_state.pop(key, None)
        st.rerun()

# ---------------------------------------------------------------------------
# Hlavní stránka
# ---------------------------------------------------------------------------
st.title("📡 NetPulse — Network Monitor")
st.caption("Vyberte stránku v levém panelu navigace.")

col1, col2, col3, col4 = st.columns(4)

try:
    hosts = client.get_hosts()
    if hosts:
        alive    = sum(1 for h in hosts if h.get("currently_alive"))
        dead     = len(hosts) - alive
        rtt_vals = [h["avg_rtt_ms"] for h in hosts if h.get("avg_rtt_ms") is not None]
        avg_rtt  = sum(rtt_vals) / len(rtt_vals) if rtt_vals else 0.0
        up_vals  = [h["uptime_pct"] for h in hosts if h.get("uptime_pct") is not None]
        avg_up   = sum(up_vals) / len(up_vals) if up_vals else 0.0

        col1.metric("Online hostů",    alive)
        col2.metric("Offline hostů",   dead)
        col3.metric("Průměrný RTT",    f"{avg_rtt:.1f} ms")
        col4.metric("Průměrný uptime", f"{avg_up:.1f} %")
    else:
        st.info("Žádná data — spusť první scan tlačítkem v postranním panelu.")
except Exception as e:
    st.warning(f"Nelze načíst přehled: {e}")

st.info("👈 Přejdi na stránky **Dashboard**, **Grafy RTT**, **Log** nebo **Nastavení**.")

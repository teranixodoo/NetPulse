# frontend/pages/3_log.py — Log událostí a výpadků

import streamlit as st
import pandas as pd
from datetime import datetime
from api_client import require_auth

st.set_page_config(page_title="Log — NetPulse", page_icon="📋", layout="wide")
client = require_auth()

st.title("📋 Log událostí")

# ---------------------------------------------------------------------------
# Filtry
# ---------------------------------------------------------------------------
col1, col2, col3 = st.columns(3)
with col1:
    hours = st.selectbox("Zobrazit za posledních", [1, 6, 12, 24, 48, 168],
                         index=3, format_func=lambda h: f"{h} hodin")
with col2:
    ip_filter = st.text_input("Filtrovat IP", placeholder="192.168.1.")
with col3:
    show_only_offline = st.checkbox("Jen výpadky", value=False)

# ---------------------------------------------------------------------------
# Výpadky
# ---------------------------------------------------------------------------
st.subheader("Detekované výpadky")

try:
    outages = client.get_outages(hours=hours)
    if outages:
        df_o = pd.DataFrame(outages)
        df_o["started_at"] = pd.to_datetime(df_o["started_at"])

        if ip_filter:
            df_o = df_o[df_o["ip"].str.contains(ip_filter, na=False)]

        df_o_show = df_o.copy()
        df_o_show["started_at"] = df_o_show["started_at"].dt.strftime("%d.%m.%Y %H:%M:%S")
        df_o_show = df_o_show.rename(columns={
            "ip": "IP adresa",
            "started_at": "Čas výpadku",
        })

        st.error(f"Nalezeno {len(df_o)} výpadků za posledních {hours}h", icon="🔴")
        st.dataframe(df_o_show[["IP adresa", "Čas výpadku"]],
                     width="stretch", height=300)

        csv = df_o_show.to_csv(index=False).encode("utf-8")
        st.download_button("⬇ Export výpadků CSV", csv, "outages.csv", "text/csv")
    else:
        st.success(f"Žádné výpadky za posledních {hours} hodin 🎉", icon="✅")
except Exception as e:
    st.error(f"Chyba: {e}")

st.divider()

# ---------------------------------------------------------------------------
# Poslední výsledky — live přehled
# ---------------------------------------------------------------------------
if not show_only_offline:
    st.subheader("Poslední výsledky pingů")

    try:
        latest = client.get_latest(limit=2000)
        if latest:
            df_l = pd.DataFrame(latest)
            df_l["scanned_at"] = pd.to_datetime(df_l["scanned_at"])

            if ip_filter:
                df_l = df_l[df_l["ip"].str.contains(ip_filter, na=False)]

            # Formátování
            df_l["scanned_at_fmt"] = df_l["scanned_at"].dt.strftime("%H:%M:%S")
            df_l["stav"] = df_l["is_alive"].map({True: "✅ online", False: "❌ offline"})
            df_l["rtt_fmt"] = df_l["rtt_ms"].apply(
                lambda v: f"{v:.1f} ms" if v is not None else "—"
            )
            df_l["loss_fmt"] = df_l["packet_loss"].apply(
                lambda v: f"{v*100:.0f}%" if v is not None else "—"
            )

            st.dataframe(
                df_l[["ip", "stav", "rtt_fmt", "loss_fmt", "scanned_at_fmt"]]
                    .rename(columns={
                        "ip": "IP",
                        "stav": "Stav",
                        "rtt_fmt": "RTT",
                        "loss_fmt": "Packet loss",
                        "scanned_at_fmt": "Čas scanu",
                    }),
                width="stretch",
                height=500,
            )
        else:
            st.info("Žádná data — spusť scan.")
    except Exception as e:
        st.error(f"Nelze načíst výsledky: {e}")

# ---------------------------------------------------------------------------
# Auto-refresh
# ---------------------------------------------------------------------------
st.divider()
col_r1, col_r2 = st.columns([1, 4])
with col_r1:
    auto_refresh = st.checkbox("Auto-refresh každých 30s")
with col_r2:
    if auto_refresh:
        st.caption("Stránka se automaticky obnovuje")
        import time
        time.sleep(30)
        st.rerun()

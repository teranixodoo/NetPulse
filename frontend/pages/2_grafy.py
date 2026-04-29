# frontend/pages/2_grafy.py — RTT grafy a výpadky

import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from api_client import require_auth

st.set_page_config(page_title="Grafy RTT — NetPulse", page_icon="📈", layout="wide")
client = require_auth()

st.title("📈 Grafy RTT a statistiky")

# ---------------------------------------------------------------------------
# RTT trend pro konkrétní IP
# ---------------------------------------------------------------------------
st.subheader("RTT trend")

col1, col2, col3 = st.columns([2, 1, 1])
with col1:
    ip_input = st.text_input("IP adresa", placeholder="192.168.1.1")
with col2:
    hours = st.selectbox("Časové okno", [1, 6, 12, 24, 48, 168], index=3, format_func=lambda h: f"{h}h")
with col3:
    limit = st.number_input("Max. bodů", min_value=50, max_value=2000, value=500, step=50)

if ip_input:
    try:
        trend = client.get_rtt_trend(ip_input.strip(), hours=hours, limit=limit)
        points = trend.get("points", [])

        if not points:
            st.info(f"Žádná data pro {ip_input} za posledních {hours}h")
        else:
            df_trend = pd.DataFrame(points)
            df_trend["ts"] = pd.to_datetime(df_trend["ts"])
            df_trend = df_trend[df_trend["alive"] == True]  # jen živé body

            if df_trend.empty:
                st.warning("IP byla celé období offline")
            else:
                fig = px.line(
                    df_trend, x="ts", y="rtt_ms",
                    title=f"RTT trend — {ip_input}",
                    labels={"ts": "Čas", "rtt_ms": "RTT (ms)"},
                    template="plotly_white",
                )
                fig.update_traces(line_color="#185FA5", line_width=1.5)
                fig.update_layout(hovermode="x unified", height=350)
                st.plotly_chart(fig, width="stretch")

                # Mini statistiky
                mc1, mc2, mc3, mc4 = st.columns(4)
                mc1.metric("Min RTT",  f"{df_trend['rtt_ms'].min():.1f} ms")
                mc2.metric("Max RTT",  f"{df_trend['rtt_ms'].max():.1f} ms")
                mc3.metric("Avg RTT",  f"{df_trend['rtt_ms'].mean():.1f} ms")
                mc4.metric("Měření",   len(points))

    except Exception as e:
        st.error(f"Chyba: {e}")

st.divider()

# ---------------------------------------------------------------------------
# Uptime přehled — všechny IP (top offline)
# ---------------------------------------------------------------------------
st.subheader("Uptime přehled — top problémové IP")

try:
    hosts = client.get_hosts()
    if hosts:
        df_h = pd.DataFrame(hosts).sort_values("uptime_pct")
        df_h = df_h[df_h["checks"] >= 2]  # ignoruj jednorázová měření

        # Top 20 nejhorších
        df_worst = df_h.head(20)

        fig_bar = px.bar(
            df_worst,
            x    = "ip",
            y    = "uptime_pct",
            color = "uptime_pct",
            color_continuous_scale = ["#E24B4A", "#EF9F27", "#639922"],
            range_color = [0, 100],
            title = "Uptime % — 20 nejhorších IP (24h)",
            labels = {"ip": "IP adresa", "uptime_pct": "Uptime %"},
            template = "plotly_white",
        )
        fig_bar.update_layout(height=400, xaxis_tickangle=-45)
        fig_bar.add_hline(y=99, line_dash="dash", line_color="green",  annotation_text="99%")
        fig_bar.add_hline(y=90, line_dash="dash", line_color="orange", annotation_text="90%")
        st.plotly_chart(fig_bar, width="stretch")

except Exception as e:
    st.error(f"Nelze načíst data: {e}")

st.divider()

# ---------------------------------------------------------------------------
# Scatter: RTT vs. Packet loss
# ---------------------------------------------------------------------------
st.subheader("RTT vs. Packet loss")

try:
    hosts = client.get_hosts()
    if hosts:
        df_s = pd.DataFrame(hosts).dropna(subset=["avg_rtt_ms"])
        fig_sc = px.scatter(
            df_s,
            x     = "avg_rtt_ms",
            y     = "avg_loss_pct",
            hover_name = "ip",
            color = "uptime_pct",
            color_continuous_scale = ["#E24B4A", "#EF9F27", "#639922"],
            title = "RTT (ms) vs. Packet loss % — každý bod = jedna IP",
            labels = {"avg_rtt_ms": "Průměrný RTT (ms)", "avg_loss_pct": "Packet loss %"},
            template = "plotly_white",
        )
        fig_sc.update_layout(height=400)
        st.plotly_chart(fig_sc, width="stretch")
except Exception as e:
    st.error(f"Nelze načíst data: {e}")

st.divider()

# ---------------------------------------------------------------------------
# Výpadky
# ---------------------------------------------------------------------------
st.subheader("Výpadky")

hours_out = st.selectbox("Výpadky za posledních:", [6, 12, 24, 48, 168],
                          index=2, format_func=lambda h: f"{h} hodin", key="out_hours")
try:
    outages = client.get_outages(hours=hours_out)
    if outages:
        df_o = pd.DataFrame(outages)
        df_o["started_at"] = pd.to_datetime(df_o["started_at"]).dt.strftime("%d.%m. %H:%M:%S")
        st.dataframe(df_o[["ip", "started_at"]], width="stretch")
    else:
        st.success(f"Žádné výpadky za posledních {hours_out} hodin 🎉")
except Exception as e:
    st.error(f"Chyba: {e}")

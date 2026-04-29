# frontend/pages/1_dashboard.py

import ipaddress
import streamlit as st
import pandas as pd
from api_client import require_auth

st.set_page_config(page_title="Dashboard — NetPulse", page_icon="🗺️", layout="wide")
client = require_auth()

st.title("🗺️ Dashboard — mapa sítě")

# ---------------------------------------------------------------------------
# Načtení dat
# ---------------------------------------------------------------------------
try:
    hosts   = client.get_hosts()
    devices = client.get_devices()
    ranges  = client.get_ranges()
except Exception as e:
    st.error(f"Chyba při načítání dat: {e}")
    st.stop()

if not hosts:
    st.warning("Žádná data — spusť scan v postranním panelu.")
    st.stop()

# ---------------------------------------------------------------------------
# Pomocné funkce
# ---------------------------------------------------------------------------
def safe_ip(ip_str: str) -> ipaddress.IPv4Address:
    try:
        return ipaddress.ip_address(str(ip_str).split("/")[0])
    except Exception:
        return ipaddress.ip_address("0.0.0.0")

# Mapování IP → zařízení
ip_to_device: dict[str, dict] = {}
for d in devices:
    ip_clean = str(d.get("ip", "")).split("/")[0]
    if ip_clean:
        ip_to_device[ip_clean] = d

def get_device_label(ip: str) -> str:
    dev = ip_to_device.get(ip)
    if not dev:
        return ""
    parts = []
    if dev.get("alias"):
        parts.append(dev["alias"])
    elif dev.get("hostname"):
        parts.append(dev["hostname"])
    if dev.get("device_type") and dev["device_type"] not in ("unknown", ""):
        parts.append(f"({dev['device_type']})")
    return " ".join(parts)

# ---------------------------------------------------------------------------
# Globální metriky
# ---------------------------------------------------------------------------
alive_hosts   = [h for h in hosts if h.get("currently_alive")]
dead_hosts    = [h for h in hosts if not h.get("currently_alive")]
valid_rtts    = [h["avg_rtt_ms"] for h in alive_hosts if h.get("avg_rtt_ms") is not None]
valid_uptimes = [h["uptime_pct"]  for h in hosts       if h.get("uptime_pct")  is not None]
avg_rtt = sum(valid_rtts)    / len(valid_rtts)    if valid_rtts    else 0.0
avg_up  = sum(valid_uptimes) / len(valid_uptimes) if valid_uptimes else 0.0

c1, c2, c3, c4, c5 = st.columns(5)
c1.metric("Online",     len(alive_hosts))
c2.metric("Offline",    len(dead_hosts))
c3.metric("Celkem",     len(hosts))
c4.metric("Avg RTT",    f"{avg_rtt:.1f} ms")
c5.metric("Avg uptime", f"{avg_up:.1f} %")

st.divider()

# ---------------------------------------------------------------------------
# IP rozsahy — každý v expanderu se statistikami a mapou
# ---------------------------------------------------------------------------
rc1, rc2 = st.columns([4, 1])
rc1.subheader("IP rozsahy — mapa sítě")
with rc2:
    if st.button("➕ Přidat rozsah", width="stretch"):
        st.session_state["show_add_range"] = True

# ---- Formulář přidání rozsahu ----
if st.session_state.get("show_add_range"):
    with st.form("add_range_form"):
        ar1, ar2, ar3 = st.columns([2, 3, 1])
        with ar1:
            new_label = st.text_input("Název", placeholder="LAN Sklad")
        with ar2:
            new_network = st.text_input("Síť (CIDR)", placeholder="10.30.30.0/24")
        with ar3:
            new_active = st.checkbox("Aktivní", value=True)
        save_range, cancel_range = st.columns(2)
        if save_range.form_submit_button("💾 Uložit", type="primary"):
            if not new_label or not new_network:
                st.error("Název a síť jsou povinné")
            else:
                # Normalizace: pokud chybí maska, přidáme /32 (single host)
                import ipaddress as _ipa
                net_input = new_network.strip()
                if "/" not in net_input:
                    net_input = net_input + "/32"
                try:
                    _ipa.ip_network(net_input, strict=False)  # validace
                except ValueError:
                    st.error(f"Neplatná síť: `{net_input}` — zadejte platnou IP nebo CIDR")
                    st.stop()
                try:
                    client.add_range(new_label, net_input, new_active)
                    st.success(f"Rozsah **{new_label}** (`{net_input}`) přidán!")
                    st.session_state["show_add_range"] = False
                    st.rerun()
                except Exception as e:
                    st.error(f"Chyba: {e}")
        if cancel_range.form_submit_button("✖ Zrušit"):
            st.session_state["show_add_range"] = False
            st.rerun()

active_ranges = [r for r in ranges if r.get("active")]

if not active_ranges:
    st.info("Nejsou definovány žádné aktivní IP rozsahy. Klikni na **➕ Přidat rozsah**.")
else:
    for rng in active_ranges:
        net_str = rng["network"]
        label   = rng["label"]

        # Filtr hostů patřících do tohoto rozsahu
        try:
            net_obj        = ipaddress.ip_network(net_str, strict=False)
            hosts_in_range = [
                h for h in hosts
                if safe_ip(h["ip"]) in net_obj
            ]
        except Exception:
            hosts_in_range = []

        # Statistiky rozsahu
        total    = len(hosts_in_range)
        alive_n  = sum(1 for h in hosts_in_range if h.get("currently_alive"))
        dead_n   = total - alive_n
        rtt_vals = [h["avg_rtt_ms"] for h in hosts_in_range
                    if h.get("currently_alive") and h.get("avg_rtt_ms") is not None]
        up_vals  = [h["uptime_pct"] for h in hosts_in_range if h.get("uptime_pct") is not None]
        r_rtt    = sum(rtt_vals) / len(rtt_vals) if rtt_vals else None
        r_up     = sum(up_vals)  / len(up_vals)  if up_vals  else None

        # Ikona stavu rozsahu
        if total == 0:
            range_icon = "⚫"
        elif dead_n == 0:
            range_icon = "🟢"
        elif alive_n == 0:
            range_icon = "🔴"
        else:
            range_icon = "🟡"

        # Popisek expanderu — vše důležité na jednom řádku
        rtt_part = f"  ·  RTT {r_rtt:.1f} ms" if r_rtt is not None else ""
        up_part  = f"  ·  uptime {r_up:.1f} %" if r_up is not None else ""
        exp_label = (
            f"{range_icon}  **{label}**  `{net_str}`"
            f"  —  {alive_n} online / {dead_n} offline z {total}{rtt_part}{up_part}"
        )

        with st.expander(exp_label, expanded=False):

            # ---- Statistické karty uvnitř expanderu ----
            sc1, sc2, sc3, sc4, sc5 = st.columns(5)
            sc1.metric("Online",    alive_n)
            sc2.metric("Offline",   dead_n)
            sc3.metric("Celkem",    total)
            sc4.metric("Avg RTT",   f"{r_rtt:.1f} ms" if r_rtt is not None else "—")
            sc5.metric("Avg uptime",f"{r_up:.1f} %"   if r_up  is not None else "—")

            st.divider()

            # ---- Vizuální mapa ----
            if not hosts_in_range:
                st.info(f"V rozsahu {net_str} nejsou žádná data ze skenování.")
            else:
                cells_html = []
                for h in sorted(hosts_in_range, key=lambda h: safe_ip(h["ip"])):
                    ip      = str(h["ip"]).split("/")[0]
                    alive_  = h.get("currently_alive", False)
                    rtt     = h.get("avg_rtt_ms")
                    uptime  = h.get("uptime_pct") or 0.0
                    dev     = ip_to_device.get(ip)
                    dev_lbl = (dev.get("alias") or dev.get("hostname", "")) if dev else ""

                    if not alive_:
                        bg, fg = "#F09595", "#501313"
                    elif rtt and rtt > 50:
                        bg, fg = "#FAC775", "#412402"
                    else:
                        bg, fg = "#C0DD97", "#173404"

                    last_oct = ip.split(".")[-1]
                    rtt_txt  = f"{rtt:.1f} ms" if rtt is not None else "—"
                    dev_line = f"\nZařízení: {dev_lbl}" if dev_lbl else ""
                    title    = f"{ip}\nRTT: {rtt_txt}\nUptime: {uptime:.1f}%{dev_line}"
                    border   = "2px solid #185FA5" if dev else "none"

                    cells_html.append(
                        f'<div title="{title}" style="'
                        f'display:inline-block;width:38px;height:38px;margin:2px;'
                        f'background:{bg};color:{fg};border-radius:6px;'
                        f'font-size:10px;font-weight:600;text-align:center;line-height:38px;'
                        f'font-family:monospace;cursor:default;border:{border}">'
                        f'{last_oct}</div>'
                    )

                st.markdown(
                    '<div style="line-height:1.2">' + "".join(cells_html) + "</div>",
                    unsafe_allow_html=True,
                )
                st.caption(
                    "🟢 online  🟡 RTT >50 ms  🔴 offline  │  "
                    "rámeček = registrované zařízení"
                )

            # ---- Správa rozsahu ----
            st.divider()
            em1, em2, em3 = st.columns([3, 1, 1])
            with em1:
                st.caption(f"ID rozsahu: {rng['id']}  |  Síť: `{net_str}`")
            with em2:
                if st.button("✏️ Upravit", key=f"edit_rng_{rng['id']}"):
                    st.session_state[f"edit_range"] = rng["id"]
            with em3:
                if st.button("🗑 Smazat", key=f"del_rng_{rng['id']}", type="secondary"):
                    st.session_state[f"del_range"] = rng["id"]

            # Potvrzení smazání
            if st.session_state.get("del_range") == rng["id"]:
                st.warning(f"Opravdu smazat rozsah **{label}** (`{net_str}`)? Tato akce je nevratná.")
                dc1, dc2 = st.columns(2)
                if dc1.button("✅ Ano, smazat", key=f"confirm_del_{rng['id']}", type="primary"):
                    try:
                        client.delete_range(rng["id"])
                        st.success("Rozsah smazán.")
                        st.session_state.pop("del_range", None)
                        st.rerun()
                    except Exception as e:
                        st.error(f"Chyba: {e}")
                if dc2.button("✖ Zrušit", key=f"cancel_del_{rng['id']}"):
                    st.session_state.pop("del_range", None)
                    st.rerun()

            # Editační formulář
            if st.session_state.get("edit_range") == rng["id"]:
                with st.form(f"edit_range_{rng['id']}"):
                    import ipaddress as _ipa
                    ef1, ef2, ef3 = st.columns([2, 3, 1])
                    with ef1:
                        e_label = st.text_input("Název", value=rng["label"])
                    with ef2:
                        e_net = st.text_input("Síť (CIDR)", value=rng["network"])
                    with ef3:
                        e_active = st.checkbox("Aktivní", value=rng.get("active", True))
                    es1, es2 = st.columns(2)
                    if es1.form_submit_button("💾 Uložit", type="primary"):
                        net_edit = e_net.strip()
                        if "/" not in net_edit:
                            net_edit += "/32"
                        try:
                            _ipa.ip_network(net_edit, strict=False)
                            client.update_range(rng["id"], e_label, net_edit, e_active)
                            st.success("Rozsah aktualizován!")
                            st.session_state.pop("edit_range", None)
                            st.rerun()
                        except ValueError:
                            st.error(f"Neplatná síť: `{net_edit}`")
                        except Exception as e:
                            st.error(f"Chyba: {e}")
                    if es2.form_submit_button("✖ Zrušit"):
                        st.session_state.pop("edit_range", None)
                        st.rerun()

# ---------------------------------------------------------------------------
# Detailní výpis IP — sloupec Zařízení + filtry
# ---------------------------------------------------------------------------
st.subheader("Detailní výpis IP")

df = pd.DataFrame(hosts)
numeric_cols = ["uptime_pct", "avg_rtt_ms", "min_rtt_ms", "max_rtt_ms", "avg_loss_pct"]
df[numeric_cols] = df[numeric_cols].fillna(0)
df["ip_clean"]     = df["ip"].apply(lambda x: str(x).split("/")[0])
df["device_label"] = df["ip_clean"].apply(get_device_label)

# ---- Filtry ----
st.markdown("**Filtry**")
f1, f2, f3, f4, f5 = st.columns([2, 1, 1, 1, 1])

with f1:
    search_ip = st.text_input("🔍 IP adresa", placeholder="10.30.")
with f2:
    status_filter = st.selectbox("Stav", ["Vše", "✅ Online", "❌ Offline"])
with f3:
    dev_types = sorted({
        d.get("device_type", "")
        for d in devices
        if d.get("device_type") and d["device_type"] not in ("unknown", "")
    })
    type_filter = st.selectbox("Typ zařízení", ["Vše"] + dev_types)
with f4:
    uptime_min = st.number_input("Uptime % min", min_value=0, max_value=100, value=0, step=5)
with f5:
    only_registered = st.checkbox("Jen registrovaná")

df_f = df.copy()
if search_ip:
    df_f = df_f[df_f["ip_clean"].str.contains(search_ip, na=False)]
if status_filter == "✅ Online":
    df_f = df_f[df_f["currently_alive"] == True]
elif status_filter == "❌ Offline":
    df_f = df_f[df_f["currently_alive"] == False]
if type_filter != "Vše":
    ips_of_type = {
        str(d.get("ip", "")).split("/")[0]
        for d in devices if d.get("device_type") == type_filter
    }
    df_f = df_f[df_f["ip_clean"].isin(ips_of_type)]
if uptime_min > 0:
    df_f = df_f[df_f["uptime_pct"] >= uptime_min]
if only_registered:
    df_f = df_f[df_f["device_label"] != ""]

# ---- Řazení ----
sr1, sr2 = st.columns([2, 1])
with sr1:
    sort_col = st.selectbox(
        "Řadit podle",
        ["IP adresa", "Uptime %", "RTT avg (ms)", "Packet loss %", "Zařízení"],
    )
with sr2:
    sort_asc = st.radio("Směr", ["↑ Vzestupně", "↓ Sestupně"], horizontal=True) == "↑ Vzestupně"

sort_map = {
    "IP adresa":     "ip_num",
    "Uptime %":      "uptime_pct",
    "RTT avg (ms)":  "avg_rtt_ms",
    "Packet loss %": "avg_loss_pct",
    "Zařízení":      "device_label",
}
df_f["ip_num"] = df_f["ip_clean"].apply(lambda x: int(safe_ip(x)))
df_f = df_f.sort_values(sort_map[sort_col], ascending=sort_asc)

# ---- Tabulka ----
st.caption(f"Zobrazeno {len(df_f)} z {len(df)} záznamů")

display_map = {
    "ip_clean":        "IP adresa",
    "device_label":    "Zařízení",
    "currently_alive": "Online",
    "uptime_pct":      "Uptime %",
    "avg_rtt_ms":      "RTT avg (ms)",
    "min_rtt_ms":      "RTT min (ms)",
    "max_rtt_ms":      "RTT max (ms)",
    "avg_loss_pct":    "Packet loss %",
    "checks":          "Měření",
    "last_check":      "Poslední scan",
}
df_show = df_f[[c for c in display_map if c in df_f.columns]].rename(columns=display_map)

if "Poslední scan" in df_show.columns:
    df_show["Poslední scan"] = (
        pd.to_datetime(df_show["Poslední scan"], utc=True, errors="coerce")
        .dt.tz_convert("Europe/Prague")
        .dt.strftime("%d.%m. %H:%M:%S")
    )

def color_uptime(val):
    if val >= 99: return "background-color:#C0DD97;color:#173404"
    if val >= 90: return "background-color:#FAC775;color:#412402"
    return "background-color:#F09595;color:#501313"

def color_alive(val):
    return "color:#27500A;font-weight:600" if val else "color:#A32D2D;font-weight:600"

def color_device(val):
    return "color:#185FA5;font-weight:500" if val else "color:#888780"

st.dataframe(
    df_show.style
        .map(color_uptime,  subset=["Uptime %"])
        .map(color_alive,   subset=["Online"])
        .map(color_device,  subset=["Zařízení"])
        .format({
            "RTT avg (ms)":  "{:.1f}",
            "RTT min (ms)":  "{:.1f}",
            "RTT max (ms)":  "{:.1f}",
            "Packet loss %": "{:.1f}",
            "Uptime %":      "{:.1f}",
        }, na_rep="0.0"),
    width="stretch",
    height=520,
)

csv = df_show.to_csv(index=False).encode("utf-8")
st.download_button("⬇ Exportovat CSV", csv, "netpulse_hosts.csv", "text/csv")
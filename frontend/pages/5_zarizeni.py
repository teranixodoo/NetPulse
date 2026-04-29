# frontend/pages/5_zarizeni.py — Evidence zařízení

import streamlit as st
import pandas as pd
import ipaddress as _ipa
import datetime as _dt
from api_client import require_auth

st.set_page_config(page_title="Zařízení — NetPulse", page_icon="🖥️", layout="wide")
client = require_auth()

st.title("🖥️ Evidence zařízení")

# ---- Globální CSS úpravy ----
st.markdown("""
<style>
/* Toolbar selectboxy — kompaktnější */
div[data-testid="stSelectbox"] > div > div {
    min-height: 36px;
}
/* Tabulka — hustší řádky */
div[data-testid="stDataFrame"] table td,
div[data-testid="stDataFrame"] table th {
    padding: 5px 10px !important;
    font-size: 13px !important;
}
/* Stav ikona — centrovaná */
div[data-testid="stDataFrame"] table td:first-child {
    text-align: center;
    font-size: 14px !important;
}
/* Vybraný řádek — modrý nádech */
div[data-testid="stDataFrame"] table tr[aria-selected="true"] td {
    background: rgba(24, 95, 165, 0.08) !important;
}
/* Bulk lišta */
div[data-testid="stColumns"] .bulk-row {
    background: #fef9ec;
    border-radius: 8px;
    padding: 6px 12px;
}
/* Přidat zařízení — tlačítko výraznější */
div[data-testid="stButton"] button[kind="primary"] {
    font-weight: 500;
}
</style>
""", unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Načtení dat
# ---------------------------------------------------------------------------
try:
    devices     = client.get_devices()
    hosts       = client.get_hosts()
    credentials = client.get_credentials()
except Exception as e:
    st.error(f"Nepodařilo se načíst data: {e}")
    st.stop()

tab_dev, tab_cred, tab_link = st.tabs([
    "📋 Zařízení", "🔐 Přihlašovací profily", "🔗 Přiřazení profilů"
])

# ---------------------------------------------------------------------------
# Pomocné funkce
# ---------------------------------------------------------------------------
host_map_all = {str(h["ip"]).split("/")[0]: h for h in hosts}
assigned_ips = set(str(d["ip"]).split("/")[0] for d in devices)
TYPE_OPTS    = ["Router", "Switch", "AP", "Server", "IP Kamera", "Počítač", "Jiné"]

def fmt_dt(val) -> str:
    if not val:
        return "—"
    try:
        dt = _dt.datetime.fromisoformat(str(val).replace("Z", "+00:00"))
        return dt.strftime("%d.%m. %H:%M")
    except Exception:
        return str(val)[:16]

def build_device_df(device_list, host_map) -> pd.DataFrame:
    rows = []
    for d in device_list:
        ip_str    = str(d["ip"]).split("/")[0]
        hi        = host_map.get(ip_str, {})
        alive     = hi.get("currently_alive")
        uptime    = hi.get("uptime_pct", 0) or 0
        rtt       = hi.get("avg_rtt_ms")
        last_scan = hi.get("last_check")
        status    = "🟢" if alive is True else ("🔴" if alive is False else "⚫")
        rows.append({
            "_id":        d["id"],
            "Stav":       status,  # 🟢 🔴 ⚫
            "Hostname":   d.get("hostname") or "—",
            "Alias":      d.get("alias") or "—",
            "IP adresa":  ip_str,
            "Typ":        d.get("device_type") or "—",
            "Výrobce":    d.get("vendor") or "—",
            "MAC":        str(d.get("mac") or "—"),
            "Sériové č.": d.get("serial_number") or "—",
            "Uptime %":   f"{uptime:.0f} %" if uptime else "—",
            "RTT (ms)":   f"{rtt:.1f}" if rtt else "—",
            "Last scan":  fmt_dt(last_scan),
            "Vytvořeno":  fmt_dt(d.get("created_at")),
            "Profily":    ", ".join(c["name"] for c in d.get("credentials", [])) or "—",
        })
    return pd.DataFrame(rows)

# ---------------------------------------------------------------------------
# TAB 1: Zařízení
# ---------------------------------------------------------------------------
with tab_dev:

    # -----------------------------------------------------------------------
    # TOOLBAR: filtry + tlačítko přidat
    # -----------------------------------------------------------------------
    tc1, tc2, tc3, tc4, tc5, tc6 = st.columns([3, 1.5, 1.5, 1.5, 0.1, 1.5])

    with tc1:
        f_search = st.text_input("", placeholder="🔍  hostname, IP, alias, MAC, výrobce…",
                                  label_visibility="collapsed", key="dev_search")
    with tc2:
        f_type = st.selectbox("", ["Vše — typ"] + TYPE_OPTS,
                               label_visibility="collapsed", key="dev_type_f")
    with tc3:
        vendors = sorted({d.get("vendor") for d in devices if d.get("vendor")})
        f_vendor = st.selectbox("", ["Vše — výrobce"] + vendors,
                                 label_visibility="collapsed", key="dev_vendor_f")
    with tc4:
        f_status = st.selectbox("", ["Vše — stav", "🟢 Online", "🔴 Offline", "⚫ Neznámý"],
                                 label_visibility="collapsed", key="dev_status_f")
    with tc6:
        add_clicked = st.button("➕ Přidat zařízení", use_container_width=True, type="primary")
        if add_clicked:
            st.session_state["show_add_device"] = not st.session_state.get("show_add_device", False)

    # -----------------------------------------------------------------------
    # FORMULÁŘ: přidat zařízení (collapsible)
    # -----------------------------------------------------------------------
    if st.session_state.get("show_add_device"):
        with st.container(border=True):
            st.markdown("**➕ Registrovat nové zařízení**")

            # Sestavení IP options
            def build_add_ip_options():
                opts = []
                for ip_s, hi in sorted(host_map_all.items(),
                                       key=lambda x: _ipa.ip_address(x[0])):
                    if ip_s in assigned_ips:
                        continue
                    alive_h = hi.get("currently_alive")
                    icon    = "✅" if alive_h is True else "❌"
                    up      = hi.get("uptime_pct", 0) or 0
                    rtt_v   = hi.get("avg_rtt_ms")
                    rtt_s   = f"  {rtt_v:.1f} ms" if rtt_v else ""
                    opts.append(f"{icon} {ip_s}  |  uptime {up:.0f}%{rtt_s}")
                return opts

            ip_opts = build_add_ip_options()

            col_f1, col_f2 = st.columns([1, 2])
            with col_f1:
                sf_status = st.radio("Zobrazit IP:", ["Vše", "Jen online ✅", "Jen offline ❌"],
                                      horizontal=True, key="add_ip_filter")
            with col_f2:
                sf_search = st.text_input("🔍 Hledat IP", placeholder="10.30.",
                                           key="add_ip_search")

            filtered_opts = [
                o for o in ip_opts
                if (sf_status == "Vše"
                    or (sf_status == "Jen online ✅" and o.startswith("✅"))
                    or (sf_status == "Jen offline ❌" and o.startswith("❌")))
                and (not sf_search or sf_search in o)
            ]

            with st.form("add_device_form"):
                fa1, fa2, fa3 = st.columns(3)
                with fa1:
                    if filtered_opts:
                        sel_lbl = st.selectbox("IP adresa", filtered_opts)
                        add_ip  = sel_lbl.split("|")[0].strip().lstrip("✅❌").strip()
                    else:
                        st.selectbox("IP adresa", ["— žádné dostupné —"], disabled=True)
                        add_ip = ""
                    add_hostname = st.text_input("Hostname", placeholder="core-switch-01")
                with fa2:
                    add_type  = st.selectbox("Typ", TYPE_OPTS)
                    add_alias = st.text_input("Alias", placeholder="Hlavní switch")
                with fa3:
                    add_vendor = st.text_input("Výrobce", placeholder="Cisco")
                    add_mac    = st.text_input("MAC", placeholder="AA:BB:CC:DD:EE:FF")

                add_serial = st.text_input("Sériové číslo", placeholder="")
                add_desc   = st.text_area("Poznámka", height=60)

                sb1, sb2 = st.columns([1, 5])
                if sb1.form_submit_button("💾 Uložit", type="primary"):
                    if not add_ip or not add_hostname:
                        st.error("IP a hostname jsou povinné")
                    else:
                        try:
                            client.add_device({
                                "ip": add_ip, "hostname": add_hostname,
                                "device_type": add_type, "alias": add_alias or None,
                                "mac": add_mac or None, "vendor": add_vendor or None,
                                "serial_number": add_serial or None,
                                "description": add_desc,
                            })
                            st.success(f"Zařízení {add_hostname} uloženo!")
                            st.session_state["show_add_device"] = False
                            st.rerun()
                        except Exception as e:
                            st.error(f"Chyba: {e}")
                if sb2.form_submit_button("✖ Zrušit"):
                    st.session_state["show_add_device"] = False
                    st.rerun()

    # -----------------------------------------------------------------------
    # DataFrame + filtry
    # -----------------------------------------------------------------------
    df_dev = build_device_df(devices, host_map_all) if devices else pd.DataFrame()

    if not df_dev.empty:
        df_f = df_dev.copy()

        if f_search:
            mask = (
                df_f["Hostname"].str.contains(f_search, case=False, na=False) |
                df_f["Alias"].str.contains(f_search, case=False, na=False) |
                df_f["IP adresa"].str.contains(f_search, case=False, na=False) |
                df_f["MAC"].str.contains(f_search, case=False, na=False) |
                df_f["Výrobce"].str.contains(f_search, case=False, na=False)
            )
            df_f = df_f[mask]
        if f_type != "Vše — typ":
            df_f = df_f[df_f["Typ"] == f_type]
        if f_vendor != "Vše — výrobce":
            df_f = df_f[df_f["Výrobce"] == f_vendor]
        if f_status == "🟢 Online":
            df_f = df_f[df_f["Stav"] == "🟢"]
        elif f_status == "🔴 Offline":
            df_f = df_f[df_f["Stav"] == "🔴"]
        elif f_status == "⚫ Neznámý":
            df_f = df_f[df_f["Stav"] == "⚫"]

        # ---- Hromadné akce ----
        bulk_ids = st.session_state.get("bulk_selected_ids", set())

        # ---- Počítadlo ----
        st.caption(f"Zobrazeno {len(df_f)} z {len(df_dev)} zařízení"
                   + (f" · **{len(bulk_ids)} vybráno**" if bulk_ids else ""))

        # ---- Tabulka ----
        DISP_COLS = ["Stav", "Hostname", "Alias", "IP adresa", "Typ",
                     "Výrobce", "MAC", "Sériové č.", "Uptime %",
                     "RTT (ms)", "Last scan", "Vytvořeno", "Profily"]

        event = st.dataframe(
            df_f[DISP_COLS],
            hide_index          = True,
            use_container_width = True,
            height              = min(420, 42 + len(df_f) * 36),
            on_select           = "rerun",
            selection_mode      = "single-row",
            column_config       = {
                "Stav":       st.column_config.TextColumn("",        width=40),
                "Hostname":   st.column_config.TextColumn("Hostname",width=160),
                "Alias":      st.column_config.TextColumn("Alias",   width=130),
                "IP adresa":  st.column_config.TextColumn("IP",      width=120),
                "Typ":        st.column_config.TextColumn("Typ",     width=100),
                "Výrobce":    st.column_config.TextColumn("Výrobce", width=110),
                "MAC":        st.column_config.TextColumn("MAC",     width=150),
                "Sériové č.": st.column_config.TextColumn("S/N",     width=90),
                "Uptime %":   st.column_config.TextColumn("Uptime",  width=70),
                "RTT (ms)":   st.column_config.TextColumn("RTT",     width=65),
                "Last scan":  st.column_config.TextColumn("Scan",    width=90),
                "Vytvořeno":  st.column_config.TextColumn("Vytvořeno",width=95),
                "Profily":    st.column_config.TextColumn("Profily", width=180),
            },
        )

        # Checkbox pro bulk výběr (simulace přes multiselect pod tabulkou)
        # ---- Bulk akce (zobrazí se jen při výběru) ----
        if bulk_ids:
            bc1, bc2, bc3, bc4, bc5 = st.columns([2.5, 1.5, 1.8, 1.5, 1.2])
            bc1.markdown(
                f'<div style="padding:6px 0;color:var(--color-text-warning);font-weight:500">'
                f'☑ {len(bulk_ids)} vybráno</div>', unsafe_allow_html=True)
            if bc2.button("🗑 Smazat", key="bulk_del", type="secondary"):
                errors = []
                for did in bulk_ids:
                    try:
                        client.delete_device(did)
                    except Exception as e:
                        errors.append(str(e))
                if errors:
                    st.error("Chyby: " + "; ".join(errors))
                else:
                    st.success(f"Smazáno {len(bulk_ids)} zařízení")
                st.session_state["bulk_selected_ids"] = set()
                st.rerun()
            if bc3.button("🔍 Discovery", key="bulk_disc"):
                with st.spinner("Spouštím discovery…"):
                    results = []
                    for did in bulk_ids:
                        dev = next((d for d in devices if d["id"] == did), None)
                        ip  = str(dev["ip"]).split("/")[0] if dev else "?"
                        hi  = host_map_all.get(ip, {})
                        if not hi.get("currently_alive"):
                            results.append(f"⏭ {ip} — offline, přeskočeno")
                            continue
                        try:
                            res   = client.run_discovery(did)
                            patch = res.get("patch_applied", {})
                            results.append(f"✅ {ip} — {patch or 'žádné změny'}")
                        except Exception as e:
                            results.append(f"❌ {ip} — {e}")
                for r in results:
                    st.caption(r)
                st.session_state["bulk_selected_ids"] = set()
                st.rerun()
            csv_bulk = df_f[df_f["_id"].isin(bulk_ids)].drop(columns=["_id"]).to_csv(index=False).encode()
            bc4.download_button("⬇ CSV", csv_bulk, "export.csv", "text/csv", key="bulk_csv")
            if bc5.button("✖ Zrušit", key="bulk_cancel"):
                st.session_state["bulk_selected_ids"] = set()
                st.rerun()

        with st.expander("☑ Hromadný výběr zařízení", expanded=False):
            all_ids    = list(df_f["_id"])
            all_labels = [f"{row['Hostname']} ({row['IP adresa']})"
                          for _, row in df_f.iterrows()]
            sel_labels = st.multiselect(
                "Vyberte zařízení pro hromadné akce:",
                options=all_labels,
                default=[all_labels[i] for i, did in enumerate(all_ids) if did in bulk_ids],
                key="bulk_ms",
            )
            new_bulk = {all_ids[all_labels.index(l)] for l in sel_labels}
            if new_bulk != bulk_ids:
                st.session_state["bulk_selected_ids"] = new_bulk
                st.rerun()

        # -----------------------------------------------------------------------
        # DETAIL PANEL — otevře se po kliknutí na řádek
        # -----------------------------------------------------------------------
        sel_rows = event.selection.rows if hasattr(event, "selection") else []

        if sel_rows:
            sel_idx  = df_f.index[sel_rows[0]]
            sel_did  = int(df_f.loc[sel_idx, "_id"])
            edit_dev = next((d for d in devices if d["id"] == sel_did), None)

            if edit_dev:
                ip_str    = str(edit_dev["ip"]).split("/")[0]
                hi        = host_map_all.get(ip_str, {})
                alive     = hi.get("currently_alive")
                uptime    = hi.get("uptime_pct", 0) or 0
                rtt       = hi.get("avg_rtt_ms")
                alive_badge = "🟢 online" if alive is True else ("🔴 offline" if alive is False else "⚫ neznámý")

                st.divider()

                # Záhlaví detail panelu
                dh1, dh2 = st.columns([5, 1])
                with dh1:
                    st.markdown(
                        f"### {edit_dev['hostname']}  "
                        f"<span style='font-size:14px;font-weight:400;color:var(--color-text-secondary)'>"
                        f"`{ip_str}` · {alive_badge} · uptime {uptime:.0f} %"
                        f"{'  · RTT ' + str(round(rtt,1)) + ' ms' if rtt else ''}"
                        f"</span>",
                        unsafe_allow_html=True,
                    )
                with dh2:
                    if st.button("✕ Zavřít detail", key="close_detail"):
                        st.rerun()

                ep = st.tabs(["📝 Základní údaje", "🌐 IP adresa",
                               "🔐 Přihl. profily", "📋 Discovery"])

                # ---- Tab 0: Základní údaje ----
                with ep[0]:
                    with st.form(f"edit_basic_{sel_did}"):
                        ec1, ec2 = st.columns(2)
                        with ec1:
                            e_hn     = st.text_input("Hostname",    value=edit_dev.get("hostname") or "")
                            e_alias  = st.text_input("Alias",       value=edit_dev.get("alias") or "")
                            e_mac    = st.text_input("MAC adresa",  value=str(edit_dev.get("mac") or ""))
                        with ec2:
                            curr_t   = edit_dev.get("device_type", "Jiné")
                            t_idx    = TYPE_OPTS.index(curr_t) if curr_t in TYPE_OPTS else 6
                            e_type   = st.selectbox("Typ zařízení", TYPE_OPTS, index=t_idx)
                            e_vendor = st.text_input("Výrobce / platforma",
                                                      value=edit_dev.get("vendor") or "")
                            e_serial = st.text_input("Sériové číslo",
                                                      value=edit_dev.get("serial_number") or "")
                        e_desc = st.text_area("Poznámka", value=edit_dev.get("description") or "",
                                               height=70)

                        bf1, bf2, bf3 = st.columns([2, 2, 1])
                        save_b   = bf1.form_submit_button("💾 Uložit změny", type="primary")
                        cancel_b = bf2.form_submit_button("✖ Zrušit")
                        delete_b = bf3.form_submit_button("🗑 Smazat")

                    if save_b:
                        try:
                            client.update_device(sel_did, {
                                "ip": ip_str, "hostname": e_hn,
                                "device_type": e_type, "alias": e_alias or None,
                                "mac": e_mac or None, "vendor": e_vendor or None,
                                "serial_number": e_serial or None, "description": e_desc,
                            })
                            st.success("✅ Uloženo")
                            st.rerun()
                        except Exception as e:
                            st.error(f"Chyba: {e}")
                    if cancel_b:
                        st.rerun()
                    if delete_b:
                        try:
                            client.delete_device(sel_did)
                            st.success("Zařízení smazáno")
                            st.rerun()
                        except Exception as e:
                            st.error(f"Chyba: {e}")

                # ---- Tab 1: IP adresa ----
                with ep[1]:
                    def _ip_opts_for(current_ip):
                        opts, idx = [], 0
                        for s, hi2 in sorted(host_map_all.items(),
                                             key=lambda x: _ipa.ip_address(x[0])):
                            is_cur   = (s == current_ip)
                            is_taken = (s in assigned_ips and not is_cur)
                            if is_taken:
                                continue
                            icon2 = "✅" if hi2.get("currently_alive") else "❌"
                            up2   = hi2.get("uptime_pct", 0) or 0
                            rtt2  = hi2.get("avg_rtt_ms")
                            suf   = "  ← aktuální" if is_cur else ""
                            lbl   = f"{icon2} {s}  |  uptime {up2:.0f}%{'  '+str(round(rtt2,1))+' ms' if rtt2 else ''}{suf}"
                            if is_cur:
                                idx = len(opts)
                            opts.append(lbl)
                        return opts, idx

                    ip_opts2, ip_idx2 = _ip_opts_for(ip_str)
                    with st.form(f"edit_ip_{sel_did}"):
                        if ip_opts2:
                            sel_ip_lbl = st.selectbox("Nová IP adresa", ip_opts2,
                                                       index=ip_idx2, key=f"ip_sel2_{sel_did}")
                            new_ip = sel_ip_lbl.split("|")[0].strip().lstrip("✅❌⚫").strip()
                        else:
                            st.warning("Žádné dostupné IP")
                            new_ip = ip_str
                            st.selectbox("IP adresa", ["—"], disabled=True)
                        if st.form_submit_button("💾 Uložit IP", type="primary"):
                            try:
                                client.update_device(sel_did, {
                                    "ip": new_ip,
                                    "hostname": edit_dev.get("hostname"),
                                    "device_type": edit_dev.get("device_type"),
                                    "alias": edit_dev.get("alias"),
                                    "mac": edit_dev.get("mac"),
                                    "vendor": edit_dev.get("vendor"),
                                    "serial_number": edit_dev.get("serial_number"),
                                    "description": edit_dev.get("description"),
                                })
                                st.success(f"IP změněna na {new_ip}")
                                st.rerun()
                            except Exception as e:
                                st.error(f"Chyba: {e}")

                # ---- Tab 2: Přihlašovací profily ----
                with ep[2]:
                    current_cred_ids = {c["id"] for c in edit_dev.get("credentials", [])}
                    with st.form(f"edit_creds_{sel_did}"):
                        if credentials:
                            cred_labels = [f"{c['id']} — {c['name']} ({c['auth_type']})"
                                           for c in credentials]
                            cred_ids    = [c["id"] for c in credentials]
                            defaults    = [cred_labels[i] for i, cid in enumerate(cred_ids)
                                           if cid in current_cred_ids]
                            sel_labels  = st.multiselect("Přiřazené profily", cred_labels,
                                                          default=defaults,
                                                          key=f"cred_ms_{sel_did}")
                            new_cid     = {cred_ids[cred_labels.index(l)] for l in sel_labels}
                        else:
                            st.info("Žádné profily — přidejte v záložce 🔐 Přihlašovací profily")
                            new_cid = current_cred_ids

                        if st.form_submit_button("💾 Uložit profily", type="primary"):
                            try:
                                for cid in new_cid - current_cred_ids:
                                    client.link_credential(sel_did, cid)
                                for cid in current_cred_ids - new_cid:
                                    client.unlink_credential(sel_did, cid)
                                st.success("Profily aktualizovány!")
                                st.rerun()
                            except Exception as e:
                                st.error(f"Chyba: {e}")

                # ---- Tab 3: Discovery ----
                with ep[3]:
                    has_creds = len(edit_dev.get("credentials", [])) > 0
                    is_online = alive is True

                    col_disc1, col_disc2 = st.columns([1, 3])
                    with col_disc1:
                        if is_online and not has_creds:
                            if st.button("🔍 Spustit TEST", type="primary",
                                         key=f"disc_{sel_did}"):
                                st.session_state[f"disc_run_{sel_did}"] = True
                        elif not is_online:
                            st.warning("Zařízení offline")
                        else:
                            st.info("Má přihl. profily")

                    if st.session_state.get(f"disc_run_{sel_did}"):
                        st.session_state[f"disc_run_{sel_did}"] = False
                        with st.spinner("🔍 Discovery probíhá…"):
                            try:
                                res   = client.run_discovery(sel_did)
                                patch = res.get("patch_applied", {})
                                rc1, rc2, rc3, rc4 = st.columns(4)
                                rc1.metric("Hostname", res.get("hostname") or "—")
                                rc2.metric("MAC",      res.get("mac")      or "—")
                                rc3.metric("Výrobce",  res.get("vendor")   or "—")
                                rc4.metric("Typ",      res.get("device_type") or "—")
                                if res.get("open_ports"):
                                    st.caption(f"Porty: {res['open_ports']}")
                                if patch:
                                    st.success("✅ Zapsáno: " + ", ".join(
                                        f"{k}={v}" for k, v in patch.items()))
                                    st.rerun()
                                else:
                                    st.info("Discovery proběhl — žádné nové údaje")
                            except Exception as e:
                                st.error(f"Discovery selhalo: {e}")

                    # Historie logů
                    try:
                        disc_logs = client.get_discovery_logs(sel_did, limit=10)
                    except Exception:
                        disc_logs = []

                    if disc_logs:
                        st.markdown("**📋 Historie testů**")
                        for log_e in disc_logs:
                            try:
                                dt2    = _dt.datetime.fromisoformat(
                                    str(log_e.get("tested_at","")).replace("Z","+00:00"))
                                dt_str = dt2.strftime("%d.%m.%Y %H:%M:%S")
                            except Exception:
                                dt_str = str(log_e.get("tested_at",""))[:19]
                            patch_i = log_e.get("patch_applied", {})
                            patch_s = (", ".join(f"{k}={v}" for k, v in patch_i.items())
                                       if patch_i else "žádné změny")
                            with st.expander(f"🕐 {dt_str}  —  {patch_s}"):
                                layers = log_e.get("layers", [])
                                if layers:
                                    rows_html = "".join(
                                        f"<tr>"
                                        f"<td style='padding:4px 10px;font-weight:500'>{l['layer']}</td>"
                                        f"<td style='padding:4px 10px;text-align:center'>"
                                        f"{'✅' if l.get('ok') else '❌'}</td>"
                                        f"<td style='padding:4px 10px;font-family:monospace'>"
                                        f"{l.get('result','—')}</td>"
                                        f"<td style='padding:4px 10px;color:#555'>"
                                        f"{l.get('note','')}</td></tr>"
                                        for l in layers
                                    )
                                    st.markdown(
                                        f"<table style='width:100%;border-collapse:collapse;"
                                        f"font-size:13px'><thead><tr style='background:#F0F2F6'>"
                                        f"<th style='padding:4px 10px;text-align:left'>Vrstva</th>"
                                        f"<th style='padding:4px 10px'>OK</th>"
                                        f"<th style='padding:4px 10px;text-align:left'>Hodnota</th>"
                                        f"<th style='padding:4px 10px;text-align:left'>Poznámka</th>"
                                        f"</tr></thead><tbody>{rows_html}</tbody></table>",
                                        unsafe_allow_html=True,
                                    )
                    else:
                        st.info("Zatím žádné discovery testy.")
    else:
        st.info("Zatím žádná registrovaná zařízení. Klikni na **➕ Přidat zařízení**.")

# ---------------------------------------------------------------------------
# TAB 2: Přihlašovací profily
# ---------------------------------------------------------------------------
with tab_cred:
    st.subheader("🔐 Trezor přihlašovacích profilů")
    st.caption("Hesla jsou šifrována (Fernet AES-128). Nikdy se neposílají zpět klientovi.")

    if credentials:
        rows = []
        for c in credentials:
            rows.append({
                "ID": c["id"], "Název": c["name"], "Typ": c["auth_type"],
                "Uživatel": c.get("username") or "—",
                "Port": c.get("port") or "výchozí",
            })
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

        del_id = st.selectbox("Smazat profil:",
                               options=["—"] + [f"{c['id']} — {c['name']}" for c in credentials])
        if del_id != "—" and st.button("🗑 Smazat vybraný profil", type="secondary"):
            cid = int(del_id.split("—")[0].strip())
            try:
                client.delete_credential(cid)
                st.success("Profil smazán")
                st.rerun()
            except Exception as e:
                st.error(str(e))
    else:
        st.info("Zatím žádné profily.")

    st.divider()
    st.subheader("➕ Přidat nový profil")

    with st.form("add_cred"):
        c1, c2 = st.columns(2)
        with c1:
            cred_name = st.text_input("Název profilu", placeholder="SSH-admin-sklad")
            auth_type = st.selectbox("Typ", ["ssh", "snmp", "api", "http"])
            username  = st.text_input("Uživatelské jméno")
        with c2:
            password = st.text_input("Heslo / klíč / community string", type="password")
            port     = st.number_input("Port (0 = výchozí)", min_value=0, max_value=65535, value=0)

        extra = {}
        if auth_type == "snmp":
            snmp_ver = st.selectbox("SNMP verze", ["2c", "3"])
            extra = {"snmp_version": snmp_ver}

        if st.form_submit_button("💾 Uložit profil", type="primary"):
            if not cred_name or not password:
                st.error("Název a heslo jsou povinné")
            else:
                try:
                    client.add_credential(
                        name=cred_name, auth_type=auth_type,
                        username=username or None, password=password,
                        port=port if port > 0 else None, extra_params=extra,
                    )
                    st.success(f"Profil '{cred_name}' uložen!")
                    st.rerun()
                except Exception as e:
                    st.error(f"Chyba: {e}")

# ---------------------------------------------------------------------------
# TAB 3: Přiřazení profilů k zařízením
# ---------------------------------------------------------------------------
with tab_link:
    st.subheader("🔗 Přiřazení přihlašovacích profilů k zařízením")
    st.caption("Jedno zařízení může mít více profilů (SSH + SNMP + API).")

    if not devices or not credentials:
        st.warning("Nejprve přidejte zařízení i přihlašovací profily.")
    else:
        dev_options  = {
            f"{d['id']} — {d['hostname']} ({str(d['ip']).split('/')[0]})": d["id"]
            for d in devices
        }
        cred_options = {
            f"{c['id']} — {c['name']} ({c['auth_type']})": c["id"]
            for c in credentials
        }

        with st.form("link_form"):
            sel_dev  = st.selectbox("Zařízení",  list(dev_options.keys()))
            sel_cred = st.selectbox("Profil",    list(cred_options.keys()))
            action   = st.radio("Akce", ["➕ Přiřadit", "➖ Odebrat"], horizontal=True)

            if st.form_submit_button("Provést", type="primary"):
                d_id = dev_options[sel_dev]
                c_id = cred_options[sel_cred]
                try:
                    if "Přiřadit" in action:
                        client.link_credential(d_id, c_id)
                        st.success("Profil přiřazen!")
                    else:
                        client.unlink_credential(d_id, c_id)
                        st.success("Přiřazení odebráno!")
                    st.rerun()
                except Exception as e:
                    st.error(f"Chyba: {e}")

        st.divider()
        st.subheader("Aktuální přiřazení")
        link_rows = []
        for d in devices:
            for c in d.get("credentials", []):
                link_rows.append({
                    "Zařízení": d["hostname"],
                    "IP":       str(d["ip"]).split("/")[0],
                    "Profil":   c["name"],
                    "Typ":      c["auth_type"],
                    "Uživatel": c.get("username") or "—",
                })
        if link_rows:
            st.dataframe(pd.DataFrame(link_rows), use_container_width=True, hide_index=True)
        else:
            st.info("Žádná přiřazení.")

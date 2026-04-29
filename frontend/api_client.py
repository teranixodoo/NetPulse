# frontend/api_client.py

from __future__ import annotations
import os
from typing import Optional
import requests
import streamlit as st

API_BASE = os.getenv("NETPULSE_API_URL", "http://backend:8000")


class ApiError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail      = detail
        super().__init__(f"API {status_code}: {detail}")


class NetPulseClient:
    def __init__(self, token: Optional[str] = None, api_key: Optional[str] = None):
        self.token   = token   or st.session_state.get("token")
        self.api_key = api_key or st.session_state.get("api_key")
        self.base    = API_BASE.rstrip("/")

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        elif self.api_key:
            h["X-API-Key"] = self.api_key
        return h

    def _get(self, path: str, params: dict = None) -> dict | list:
        try:
            r = requests.get(
                f"{self.base}{path}",
                headers = self._headers(),
                params  = params,
                timeout = 10,
            )
            if r.status_code == 401:
                st.error("🔒 Relace vypršela — přihlaste se znovu.")
                for key in ["token", "api_key", "username"]:
                    st.session_state.pop(key, None)
                st.rerun()
            if not r.ok:
                raise ApiError(r.status_code, r.json().get("detail", r.text))
            return r.json()
        except requests.exceptions.ConnectionError:
            raise ApiError(0, "Nepodařilo se připojit k backendu")

    def _post(self, path: str, data: dict = None) -> dict | list:
        r = requests.post(
            f"{self.base}{path}",
            headers = self._headers(),
            json    = data or {},
            timeout = 15,
        )
        if not r.ok:
            raise ApiError(r.status_code, r.json().get("detail", r.text))
        return r.json()

    def _put(self, path: str, data: dict) -> dict | list:
        r = requests.put(
            f"{self.base}{path}",
            headers = self._headers(),
            json    = data,
            timeout = 15,
        )
        if not r.ok:
            raise ApiError(r.status_code, r.json().get("detail", r.text))
        return r.json()

    def _delete(self, path: str) -> dict:
        r = requests.delete(
            f"{self.base}{path}",
            headers = self._headers(),
            timeout = 15,
        )
        if not r.ok:
            raise ApiError(r.status_code, r.json().get("detail", r.text))
        return r.json()

    # -----------------------------------------------------------------------
    # Auth
    # -----------------------------------------------------------------------
    def login(self, username: str, password: str) -> str:
        r = requests.post(
            f"{self.base}/auth/login",
            json    = {"username": username, "password": password},
            timeout = 10,
        )
        if not r.ok:
            raise ApiError(r.status_code, "Špatné jméno nebo heslo")
        return r.json()["access_token"]

    # -----------------------------------------------------------------------
    # Scan
    # -----------------------------------------------------------------------
    def get_status(self) -> dict:
        """
        Bezpečné volání — nikdy nevyvolá st.stop() ani st.error().
        Používej v sidebaru a všude kde nechceš přerušit rendering.
        """
        if not self.token and not self.api_key:
            return {"running": False, "is_scanning": False, "scan_count": 0}
        try:
            r = requests.get(
                f"{self.base}/scan/status",
                headers = self._headers(),
                timeout = 3,
            )
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return {"running": False, "is_scanning": False, "scan_count": 0}

    def trigger_scan(self) -> dict:
        return self._post("/scan/trigger")

    # -----------------------------------------------------------------------
    # Data
    # -----------------------------------------------------------------------
    def get_hosts(self, range_id: int = None) -> list:
        p = {"range_id": range_id} if range_id else {}
        return self._get("/hosts", params=p)

    def get_rtt_trend(self, host_id, days: int = 7, hours: Optional[int] = None) -> dict:
        p = {"days": days}
        if hours is not None:
            p["hours"] = hours
        return self._get(f"/hosts/{host_id}/rtt-trend", params=p)

    def get_outages(self, limit: int = 50, hours: int = 24) -> list:
        return self._get("/outages", params={"limit": limit, "hours": hours})

    def get_latest(self, limit: int = 100) -> list:
        return self._get("/results/latest", params={"limit": limit})

    # -----------------------------------------------------------------------
    # Konfigurace
    # -----------------------------------------------------------------------
    def get_config(self) -> dict:
        return self._get("/config")

    def update_config(self, cfg: dict) -> dict:
        return self._put("/config", cfg)
        
    # -----------------------------------------------------------------------
    # Credentials (trezor)
    # -----------------------------------------------------------------------
    def get_credentials(self) -> list:
        return self._get("/credentials")

    def add_credential(self, name: str, auth_type: str, username: str,
                       password: str, port: int = None, extra_params: dict = None) -> dict:
        return self._post("/credentials", {
            "name": name, "auth_type": auth_type, "username": username,
            "password": password, "port": port, "extra_params": extra_params or {}
        })

    def delete_credential(self, credential_id: int) -> dict:
        return self._delete(f"/credentials/{credential_id}")

    # -----------------------------------------------------------------------
    # Zařízení
    # -----------------------------------------------------------------------
    def get_devices(self) -> list:
        return self._get("/devices")

    def add_device(self, data: dict) -> dict:
        return self._post("/devices", data)

    def update_device(self, device_id: int, data: dict) -> dict:
        return self._put(f"/devices/{device_id}", data)

    def delete_device(self, device_id: int) -> dict:
        return self._delete(f"/devices/{device_id}")

    def get_discovery_logs(self, device_id: int, limit: int = 20) -> list:
        """Vrátí historii discovery testů pro zařízení."""
        return self._get(f"/devices/{device_id}/discovery-logs", params={"limit": limit})

    def run_discovery(self, device_id: int) -> dict:
        """Spustí discovery na zařízení — může trvat 5-15 sekund."""
        return self._post(f"/devices/{device_id}/discovery")

    def link_credential(self, device_id: int, credential_id: int) -> dict:
        return self._post(f"/devices/{device_id}/credentials/{credential_id}")

    def unlink_credential(self, device_id: int, credential_id: int) -> dict:
        return self._delete(f"/devices/{device_id}/credentials/{credential_id}")
        
    # -----------------------------------------------------------------------
    # IP rozsahy
    # -----------------------------------------------------------------------
    def get_ranges(self) -> list:
        return self._get("/ranges")

    def add_range(self, label: str, network: str, active: bool = True) -> dict:
        return self._post("/ranges", {"label": label, "network": network, "active": active})

    def update_range(self, range_id: int, label: str, network: str, active: bool) -> dict:
        return self._put(f"/ranges/{range_id}", {
            "label": label, "network": network, "active": active
        })

    def delete_range(self, range_id: int) -> dict:
        return self._delete(f"/ranges/{range_id}")
        
    def delete_orphaned_logs(self) -> dict:
        """Smaže logy pro IP adresy, které už nepatří do žádného rozsahu."""
        try:
            r = requests.delete(
                f"{self.base}/results/orphaned",
                headers = self._headers(),
                timeout = 60,  # Delší timeout pro velkou DB
            )
            if r.status_code == 200:
                return r.json()
            raise ApiError(r.status_code, r.json().get("detail", r.text))
        except Exception as e:
            if isinstance(e, ApiError): raise e
            raise Exception(f"Chyba spojení: {e}")    

    # -----------------------------------------------------------------------
    # System
    # -----------------------------------------------------------------------
    def health(self) -> bool:
        try:
            return requests.get(f"{self.base}/health", timeout=3).ok
        except Exception:
            return False


# ---------------------------------------------------------------------------
# Streamlit helper
# ---------------------------------------------------------------------------

def require_auth() -> NetPulseClient:
    """
    Ověří přihlášení. Pokud chybí token/api_key, zobrazí login a zastaví rendering.

    POZOR: Tato funkce NEVOLÁ st.set_page_config() — musí ho zavolat
    app.py jako úplně první příkaz před voláním require_auth().
    """
    if st.session_state.get("token") or st.session_state.get("api_key"):
        return NetPulseClient()

    # --- Login formulář ---
    st.title("🔒 NetPulse — Přihlášení")

    t1, t2 = st.tabs(["👤 Uživatel / heslo", "🔑 API klíč"])

    with t1:
        with st.form("login_user"):
            u = st.text_input("Uživatelské jméno")
            p = st.text_input("Heslo", type="password")
            if st.form_submit_button("Přihlásit se", type="primary"):
                if not u or not p:
                    st.error("Vyplňte jméno i heslo")
                else:
                    try:
                        token = NetPulseClient().login(u, p)
                        st.session_state["token"]    = token
                        st.session_state["username"] = u
                        st.rerun()
                    except ApiError as e:
                        st.error(f"Přihlášení selhalo: {e.detail}")
                    except Exception:
                        st.error("Backend není dostupný")

    with t2:
        with st.form("login_key"):
            key = st.text_input("Vložte API klíč (np_...)", type="password")
            if st.form_submit_button("Přihlásit se klíčem", type="primary"):
                if not key:
                    st.error("Vložte API klíč")
                else:
                    st.session_state["api_key"] = key
                    st.rerun()

    st.stop()
    return None  # nedosažitelné
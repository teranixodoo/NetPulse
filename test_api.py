import requests
import json

# Pokud běžíte přímo na serveru, zkuste localhost. 
# Pokud v kontejneru, zkuste http://backend:8000
URL = "http://127.0.0.1:8000/scan/status"

print(f"--- TEST NETPULSE API ---")
try:
    r = requests.get(URL, timeout=5)
    print(f"Status kód: {r.status_code}")
    print(f"Odpověď: {json.dumps(r.json(), indent=2)}")
except Exception as e:
    print(f"Chyba: {e}")

import requests

# Změňte URL, pokud váš backend běží na jiné adrese
URL = "http://backend:8000/scan/status" 
# Pokud testujete zevnitř kontejneru, použijte http://backend:8000/scan/status

try:
    print(f"Testuji spojení na: {URL}")
    # Zkuste to nejdříve bez klíče (mělo by hodit 401)
    r = requests.get(URL, timeout=5)
    print(f"Status kód: {r.status_code}")
    print(f"Odpověď: {r.text}")
except Exception as e:
    print(f"Chyba spojení: {e}")
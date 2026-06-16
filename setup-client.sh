#!/bin/bash
# NetPulse — nastavení HTTPS klienta (Linux)
# Zkopíruj rootCA.pem ze serveru a spusť tento skript
# Použití: bash setup-client.sh <IP_SERVERU>

set -e
SERVER_IP="${1:-10.221.0.65}"

echo "=== NetPulse klientské nastavení ==="
echo "IP serveru: $SERVER_IP"

# 1. Přidat do /etc/hosts
if grep -q "netpulse.local" /etc/hosts; then
  # Aktualizovat existující záznam
  sed -i "s/.*netpulse\.local.*/$SERVER_IP  netpulse.local/" /etc/hosts
  echo "[1/2] /etc/hosts aktualizován: $SERVER_IP  netpulse.local"
else
  echo "$SERVER_IP  netpulse.local" | tee -a /etc/hosts
  echo "[1/2] /etc/hosts přidán záznam: $SERVER_IP  netpulse.local"
fi

# 2. Instalace CA certifikátu
if [ ! -f "rootCA.pem" ]; then
  echo ""
  echo "CHYBA: soubor rootCA.pem nenalezen."
  echo "Zkopíruj CA certifikát ze serveru:"
  echo "  scp root@$SERVER_IP:~/.local/share/mkcert/rootCA.pem ."
  echo "Pak znovu spusť tento skript."
  exit 1
fi

# Systémový certstore (Chrome, curl, wget)
cp rootCA.pem /usr/local/share/ca-certificates/netpulse-ca.crt
update-ca-certificates
echo "[2/2] CA certifikát nainstalován do systému"

# Firefox (NSS)
if command -v certutil &>/dev/null; then
  for PROFILE in ~/.mozilla/firefox/*.default* ~/.mozilla/firefox/*.default-release*; do
    if [ -d "$PROFILE" ]; then
      certutil -A -n "NetPulse CA" -t "CT,," -i rootCA.pem -d "sql:$PROFILE" 2>/dev/null && \
        echo "       Firefox profil: $PROFILE — CA přidána"
    fi
  done
else
  echo ""
  echo "Poznámka: Firefox — přidej CA ručně:"
  echo "  Nastavení → Soukromí → Certifikáty → Importovat → rootCA.pem"
fi

echo ""
echo "=== Hotovo! ==="
echo "Otevři: https://netpulse.local:8443"

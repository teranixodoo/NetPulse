#!/bin/bash
# NetPulse HTTPS setup — spustit jednou na serveru
# Použití: bash setup-https.sh

set -e
NETPULSE_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$NETPULSE_DIR/traefik/certs"

echo "=== NetPulse HTTPS Setup ==="
echo "Adresář projektu: $NETPULSE_DIR"

# 1. Instalace mkcert
if ! command -v mkcert &>/dev/null; then
  echo ""
  echo "[1/3] Instalace mkcert..."
  if command -v apt-get &>/dev/null; then
    apt-get install -y libnss3-tools
    MKCERT_VERSION=$(curl -s https://api.github.com/repos/FiloSottile/mkcert/releases/latest | grep tag_name | cut -d'"' -f4)
    curl -sLo /usr/local/bin/mkcert "https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-amd64"
    chmod +x /usr/local/bin/mkcert
    echo "mkcert nainstalován: $(mkcert -version)"
  else
    echo "CHYBA: nepodporovaný systém. Nainstalujte mkcert ručně."
    exit 1
  fi
else
  echo "[1/3] mkcert již nainstalován: $(mkcert -version)"
fi

# 2. Vytvoření lokální CA
echo ""
echo "[2/3] Vytváření lokální CA..."
mkcert -install
CA_ROOT=$(mkcert -CAROOT)
echo "CA uložena v: $CA_ROOT"
echo "CA certifikát: $CA_ROOT/rootCA.pem"

# 3. Generování certifikátu pro netpulse.local
echo ""
echo "[3/3] Generování certifikátu pro netpulse.local..."
mkdir -p "$CERT_DIR"
cd "$CERT_DIR"
mkcert netpulse.local localhost 127.0.0.1

# Přejmenování na standardní názvy
mv netpulse.local+2.pem     cert.pem 2>/dev/null || mv netpulse.local+1.pem cert.pem 2>/dev/null || true
mv netpulse.local+2-key.pem key.pem  2>/dev/null || mv netpulse.local+1-key.pem key.pem 2>/dev/null || true

echo ""
echo "=== Hotovo! ==="
echo ""
echo "Certifikát:  $CERT_DIR/cert.pem"
echo "Privátní klíč: $CERT_DIR/key.pem"
echo "CA certifikát: $CA_ROOT/rootCA.pem"
echo ""
echo "--- Další kroky ---"
echo ""
echo "1. Spusť NetPulse:"
echo "   docker compose up -d"
echo ""
echo "2. Na každém klientském PC (Linux) spusť:"
echo "   bash $NETPULSE_DIR/setup-client.sh"
echo "   (nebo viz README.md sekce HTTPS)"
echo ""
echo "3. Otevři: https://netpulse.local:8443"

# Zjisti a nastav správnou Docker host gateway IP v dynamic.yml
echo ""
echo "--- Nastavení backend IP pro Traefik ---"
HOST_GW=$(ip route | grep docker | awk '{print $9}' | head -1)
if [ -z "$HOST_GW" ]; then
  HOST_GW="172.17.0.1"
fi
echo "Docker host gateway: $HOST_GW"
sed -i "s|http://172.17.0.1:8000|http://$HOST_GW:8000|g" "$NETPULSE_DIR/traefik/dynamic.yml"
echo "dynamic.yml aktualizován: backend → http://$HOST_GW:8000"

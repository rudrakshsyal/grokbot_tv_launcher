#!/bin/bash
# Glass Home: make a private local CA + an HTTPS certificate for the relay, so iPhone Safari treats the phone page as
# secure and allows the microphone (hold-to-talk recording). Uses the openssl/LibreSSL that ships with macOS.
#   Usage:  tools/make-certs.sh <mac-lan-ip> [extra-ip-or-hostname ...]
#   Output: relay/certs/{ca.crt,ca.key,server.crt,server.key} (keys mode 600, folder 700). The relay serves https on HTTPS_PORT (8788)
#           when certs/server.key + server.crt exist, and offers the CA at http://<mac-ip>:8787/ca.crt.
#   iPhone: open http://<mac-ip>:8787/ca.crt in Safari -> Allow download -> Settings > General > VPN & Device Management > install
#           "Glass Home Local CA" -> Settings > General > About > Certificate Trust Settings -> turn on full trust for it.
#           Then use https://<mac-ip>:8788/ and re-add it to the Home Screen.
#   Undo:   rm -rf relay/certs ; on the iPhone remove the profile in Settings > General > VPN & Device Management.
# The CA key never leaves the Mac. The CA is limited (name constraints) to the addresses you pass, so it can't vouch for other sites.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <mac-lan-ip> [more ips/hostnames]"; exit 1; }
DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR" && chmod 700 "$DIR" && cd "$DIR"
SAN=""; NC=""
for h in "$@"; do
  if [[ "$h" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SAN="$SAN,IP:$h"; NC="$NC,permitted;IP:$h/255.255.255.255"
  else SAN="$SAN,DNS:$h"; NC="$NC,permitted;DNS:$h"; fi
done
SAN="${SAN#,}"; NC="${NC#,}"
umask 077
if [ ! -s ca.key ]; then
  # plain req + x509 -extfile (no -addext) so it works with the LibreSSL in macOS as well as OpenSSL
  printf 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,%s\nsubjectKeyIdentifier=hash\n' "$NC" > ca.ext
  openssl req -new -newkey rsa:2048 -nodes -sha256 -keyout ca.key -out ca.csr -subj "/CN=Glass Home Local CA" 2>/dev/null
  openssl x509 -req -in ca.csr -signkey ca.key -days 3650 -sha256 -extfile ca.ext -out ca.crt 2>/dev/null
  rm -f ca.csr ca.ext
fi
cat > server.ext <<X
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
X
openssl req -newkey rsa:2048 -nodes -sha256 -keyout server.key -out server.csr -subj "/CN=$1" 2>/dev/null
# 825 days is the longest validity iOS accepts for TLS server certificates.
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile server.ext -out server.crt 2>/dev/null
rm -f server.csr server.ext ca.srl
chmod 600 ca.key server.key; chmod 644 ca.crt server.crt
echo "Made $DIR/server.crt for: $SAN (valid 825 days). Restart the relay, then install ca.crt on the iPhone (see the top of this script)."

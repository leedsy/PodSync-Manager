#!/bin/sh
set -eu

<<<<<<< HEAD
VERSION="0.6.2"
=======
VERSION="0.6.1"
>>>>>>> b17eaf044d337dd5855b1b278e4081aac87457e3

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run: sudo ./update.sh"
  exit 1
fi

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PODSYNC_DIR="/opt/podsync"
MANAGER_DIR="/opt/podsync-manager"

for required in "$PODSYNC_DIR/config.toml" "$MANAGER_DIR/.env"; do
  if [ ! -f "$required" ]; then
    echo "Existing installation not found ($required is missing)."
    echo "Run sudo ./setup.sh instead."
    exit 1
  fi
done

stamp="$(date +%Y%m%d-%H%M%S)"
cp "$PODSYNC_DIR/config.toml" "$PODSYNC_DIR/config.toml.pre-update-$stamp.bak"
cp "$MANAGER_DIR/.env" "$MANAGER_DIR/.env.pre-update-$stamp.bak"

echo "Updating application files only."
echo "Preserving config.toml, .env, data and db."

# Refresh code/container definitions. Never copy config.toml.example over the
# live config and never touch Podsync media/database directories.
cp "$SOURCE_DIR/podsync/Dockerfile" "$PODSYNC_DIR/Dockerfile"
cp "$SOURCE_DIR/podsync/docker-compose.yml" "$PODSYNC_DIR/docker-compose.yml"
cp "$SOURCE_DIR/podsync/postprocess-ipod-video.sh" "$PODSYNC_DIR/postprocess-ipod-video.sh"
chmod +x "$PODSYNC_DIR/postprocess-ipod-video.sh"

cp "$SOURCE_DIR/podsync-manager/Dockerfile" "$MANAGER_DIR/Dockerfile"
cp "$SOURCE_DIR/podsync-manager/docker-compose.yml" "$MANAGER_DIR/docker-compose.yml"
cp "$SOURCE_DIR/podsync-manager/package.json" "$MANAGER_DIR/package.json"
cp "$SOURCE_DIR/podsync-manager/server.js" "$MANAGER_DIR/server.js"
mkdir -p "$MANAGER_DIR/public"
cp "$SOURCE_DIR/podsync-manager/public/index.html" "$MANAGER_DIR/public/index.html"
cp "$SOURCE_DIR/podsync-manager/.env.example" "$MANAGER_DIR/.env.example"

set_env_value() {
  file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
lan_ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/ {print; exit}')"
[ -n "$lan_ip" ] || lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$lan_ip" ] && set_env_value "$MANAGER_DIR/.env" HOST_LAN_IP "$lan_ip"

OWNER="${SUDO_USER:-root}"
if id "$OWNER" >/dev/null 2>&1; then
  chown -R "$OWNER":"$OWNER" "$PODSYNC_DIR" "$MANAGER_DIR"
fi
chmod 600 "$MANAGER_DIR/.env"

cd "$PODSYNC_DIR"
docker compose build --pull
if grep -Eq '^\[feeds\.[^]]+\]' "$PODSYNC_DIR/config.toml"; then
  docker compose up -d
else
  docker compose create
  docker stop podsync >/dev/null 2>&1 || true
fi

cd "$MANAGER_DIR"
docker compose build --pull
docker compose up -d

echo
echo "Podsync Manager updated to v$VERSION."
echo "User configuration and media were preserved."
[ -n "$lan_ip" ] && echo "Open: http://$lan_ip:3000"

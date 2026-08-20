#!/bin/sh
set -eu

VERSION="0.6.2"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run: sudo ./setup.sh"
  exit 1
fi

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PODSYNC_DIR="/opt/podsync"
MANAGER_DIR="/opt/podsync-manager"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is not installed. Installing Docker Engine using Docker's official convenience installer..."
  command -v curl >/dev/null 2>&1 || { apt-get update && apt-get install -y curl; }
  tmp="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$tmp"
  sh "$tmp"
  rm -f "$tmp"
}

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required."
  exit 1
fi

mkdir -p "$PODSYNC_DIR/data" "$PODSYNC_DIR/db" "$MANAGER_DIR/data"

backup_if_exists() {
  file="$1"
  [ ! -f "$file" ] || cp "$file" "$file.pre-v$VERSION.bak"
}

set_env_value() {
  file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

if [ ! -f "$PODSYNC_DIR/config.toml" ]; then
  cp "$SOURCE_DIR/podsync/config.toml.example" "$PODSYNC_DIR/config.toml"
  chmod 644 "$PODSYNC_DIR/config.toml"
  echo "Created new $PODSYNC_DIR/config.toml"
else
  backup_if_exists "$PODSYNC_DIR/config.toml"
  echo "Preserved existing Podsync config."
fi

backup_if_exists "$PODSYNC_DIR/docker-compose.yml"
cp "$SOURCE_DIR/podsync/Dockerfile" "$PODSYNC_DIR/Dockerfile"
cp "$SOURCE_DIR/podsync/docker-compose.yml" "$PODSYNC_DIR/docker-compose.yml"
cp "$SOURCE_DIR/podsync/postprocess-ipod-video.sh" "$PODSYNC_DIR/postprocess-ipod-video.sh"
chmod +x "$PODSYNC_DIR/postprocess-ipod-video.sh"

if [ ! -f "$MANAGER_DIR/.env" ]; then
  admin_password="$(openssl rand -hex 10 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  session_secret="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cp "$SOURCE_DIR/podsync-manager/.env.example" "$MANAGER_DIR/.env"
  set_env_value "$MANAGER_DIR/.env" ADMIN_PASSWORD "$admin_password"
  set_env_value "$MANAGER_DIR/.env" SESSION_SECRET "$session_secret"
  chmod 600 "$MANAGER_DIR/.env"
  new_password="$admin_password"
else
  backup_if_exists "$MANAGER_DIR/.env"
  new_password=""
  echo "Preserved existing Manager .env."
fi

# Detect the host address here, outside Docker. The Manager container cannot
# reliably distinguish the host LAN address from its own Docker bridge address.
lan_ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/ {print; exit}')"
[ -n "$lan_ip" ] || lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$lan_ip" ] || lan_ip="server-ip"
set_env_value "$MANAGER_DIR/.env" HOST_LAN_IP "$lan_ip"

backup_if_exists "$MANAGER_DIR/docker-compose.yml"
cp "$SOURCE_DIR/podsync-manager/Dockerfile" "$MANAGER_DIR/Dockerfile"
cp "$SOURCE_DIR/podsync-manager/docker-compose.yml" "$MANAGER_DIR/docker-compose.yml"
cp "$SOURCE_DIR/podsync-manager/package.json" "$MANAGER_DIR/package.json"
cp "$SOURCE_DIR/podsync-manager/server.js" "$MANAGER_DIR/server.js"
mkdir -p "$MANAGER_DIR/public"
cp "$SOURCE_DIR/podsync-manager/public/index.html" "$MANAGER_DIR/public/index.html"
cp "$SOURCE_DIR/podsync-manager/.env.example" "$MANAGER_DIR/.env.example"

OWNER="${SUDO_USER:-root}"
if id "$OWNER" >/dev/null 2>&1; then
  chown -R "$OWNER":"$OWNER" "$PODSYNC_DIR" "$MANAGER_DIR"
fi
chmod 600 "$MANAGER_DIR/.env"

cd "$PODSYNC_DIR"
docker compose build --pull
if grep -Eq '^\[feeds\.[^]]+\]' "$PODSYNC_DIR/config.toml"; then
  docker compose up -d
  podsync_state="started"
else
  # Create the container so Manager can start it after the first feed is saved,
  # but do not run Podsync with an empty feeds table (upstream rejects that).
  docker compose create
  docker stop podsync >/dev/null 2>&1 || true
  podsync_state="waiting for first feed"
fi

cd "$MANAGER_DIR"
docker compose build --pull
docker compose up -d

echo
echo "Podsync Manager v$VERSION is running."
echo "Open: http://$lan_ip:3000"
echo "Podsync: $podsync_state"
if [ -n "$new_password" ]; then
  echo "Admin password: $new_password"
  echo "Save this password now. It is also stored in $MANAGER_DIR/.env"
else
  echo "Use your existing Manager admin password."
fi
echo
echo "Complete YouTube API, Google OAuth and RSS settings in Setup & Settings."

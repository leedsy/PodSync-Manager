#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run: sudo ./setup.sh"
  exit 1
fi

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PODSYNC_DIR="/opt/podsync"
MANAGER_DIR="/opt/podsync-manager"

need_docker=0
command -v docker >/dev/null 2>&1 || need_docker=1
if [ "$need_docker" -eq 1 ]; then
  echo "Docker is not installed. Installing Docker Engine using Docker's official convenience installer..."
  command -v curl >/dev/null 2>&1 || { apt-get update && apt-get install -y curl; }
  tmp="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$tmp"
  sh "$tmp"
  rm -f "$tmp"
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required."
  echo "Install the Docker Compose plugin, then run this setup again."
  exit 1
fi

mkdir -p "$PODSYNC_DIR/data" "$PODSYNC_DIR/db" "$MANAGER_DIR/data"

# Preserve user files. Only create config/.env when they do not already exist.
if [ ! -f "$PODSYNC_DIR/config.toml" ]; then
  cp "$SOURCE_DIR/podsync/config.toml.example" "$PODSYNC_DIR/config.toml"
  chmod 644 "$PODSYNC_DIR/config.toml"
  echo "Created new $PODSYNC_DIR/config.toml"
else
  cp "$PODSYNC_DIR/config.toml" "$PODSYNC_DIR/config.toml.pre-v0.6.0.bak"
  echo "Preserved existing Podsync config (backup: config.toml.pre-v0.6.0.bak)"
fi

[ ! -f "$PODSYNC_DIR/docker-compose.yml" ] || cp "$PODSYNC_DIR/docker-compose.yml" "$PODSYNC_DIR/docker-compose.yml.pre-v0.6.0.bak"
cp "$SOURCE_DIR/podsync/Dockerfile" "$PODSYNC_DIR/Dockerfile"
cp "$SOURCE_DIR/podsync/docker-compose.yml" "$PODSYNC_DIR/docker-compose.yml"
cp "$SOURCE_DIR/podsync/postprocess-ipod-video.sh" "$PODSYNC_DIR/postprocess-ipod-video.sh"
chmod +x "$PODSYNC_DIR/postprocess-ipod-video.sh"

if [ ! -f "$MANAGER_DIR/.env" ]; then
  admin_password="$(openssl rand -hex 10 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  session_secret="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cp "$SOURCE_DIR/podsync-manager/.env.example" "$MANAGER_DIR/.env"
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$admin_password/" "$MANAGER_DIR/.env"
  sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$session_secret/" "$MANAGER_DIR/.env"
  chmod 600 "$MANAGER_DIR/.env"
  new_password="$admin_password"
else
  cp "$MANAGER_DIR/.env" "$MANAGER_DIR/.env.pre-v0.6.0.bak"
  new_password=""
  echo "Preserved existing Manager .env (backup: .env.pre-v0.6.0.bak)"
fi

# Copy application files without overwriting the live .env or data.
[ ! -f "$MANAGER_DIR/docker-compose.yml" ] || cp "$MANAGER_DIR/docker-compose.yml" "$MANAGER_DIR/docker-compose.yml.pre-v0.6.0.bak"
cp "$SOURCE_DIR/podsync-manager/Dockerfile" "$MANAGER_DIR/Dockerfile"
cp "$SOURCE_DIR/podsync-manager/docker-compose.yml" "$MANAGER_DIR/docker-compose.yml"
cp "$SOURCE_DIR/podsync-manager/package.json" "$MANAGER_DIR/package.json"
cp "$SOURCE_DIR/podsync-manager/server.js" "$MANAGER_DIR/server.js"
mkdir -p "$MANAGER_DIR/public"
cp "$SOURCE_DIR/podsync-manager/public/index.html" "$MANAGER_DIR/public/index.html"
cp "$SOURCE_DIR/podsync-manager/.env.example" "$MANAGER_DIR/.env.example"

# Use the invoking user when possible so ordinary maintenance does not require root-owned source files.
OWNER="${SUDO_USER:-root}"
if id "$OWNER" >/dev/null 2>&1; then
  chown -R "$OWNER":"$OWNER" "$PODSYNC_DIR" "$MANAGER_DIR"
fi
chmod 600 "$MANAGER_DIR/.env"

cd "$PODSYNC_DIR"
docker compose build --pull
docker compose up -d
cd "$MANAGER_DIR"
docker compose build --pull
docker compose up -d

lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$lan_ip" ] || lan_ip="server-ip"

echo
echo "Podsync Manager v0.6.0 is running."
echo "Open: http://$lan_ip:3000"
if [ -n "$new_password" ]; then
  echo "Admin password: $new_password"
  echo "Save this password now. It is also stored in $MANAGER_DIR/.env"
else
  echo "Use your existing Manager admin password."
fi
echo
echo "Complete YouTube API, Google OAuth and RSS settings in Setup & Settings."

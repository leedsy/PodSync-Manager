# Podsync Manager Suite v0.6.0

A self-hosted web manager for turning selected YouTube subscriptions into private Podsync podcast feeds, including classic-iPod-compatible video post-processing.

## v0.6.0 highlights

- New **Setup & Settings** page in the web GUI.
- Reads/writes the existing `/opt/podsync/config.toml` and `/opt/podsync-manager/.env` files.
- Existing feed sections remain intact; no SQL server and no new configuration database are introduced.
- API keys/secrets are masked in the UI and blank secret fields mean “keep the existing value”.
- Safe timestamped backups plus `.bak` copies before config changes.
- First-run setup warning when YouTube API, Google device OAuth or RSS base URL is missing.
- System diagnostics for Podsync, yt-dlp, FFmpeg, Node/Deno and the FFmpeg iPod muxer.
- Two per-feed iPod video presets: **Classic iPod High Quality (640×480)** and **Maximum Compatibility (320×240)**.
- Existing v0.5.3 feeds without a preset argument continue to use Classic High by default.
- GitHub-friendly `setup.sh` for fresh installs and safe upgrades.

## Fresh install

On an Ubuntu/Debian-style Linux server:

```bash
git clone <your-repository-url>
cd podsync-manager
sudo ./setup.sh
```

The installer prints the Manager URL and a generated admin password. Open the URL, sign in, then complete **Setup & Settings** in the browser.

## Existing v0.5.x installation

Upload/extract this release and run:

```bash
cd podsync-suite-v0.6.0
sudo ./setup.sh
```

The script preserves and backs up:

- `/opt/podsync/config.toml`
- `/opt/podsync-manager/.env`
- existing media under `/opt/podsync/data`
- the Podsync database under `/opt/podsync/db`
- Manager state under `/opt/podsync-manager/data`

It updates the application/container definitions and rebuilds the containers.

## Important

The Manager intentionally does not store setup secrets in SQL. Podsync settings remain in `config.toml`; Manager runtime/OAuth settings remain in `.env`; the Manager's existing `data/state.json` continues to hold OAuth tokens, channel/feed mapping and UI defaults.

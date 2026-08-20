# Podsync Manager Suite v0.6.0

A self-hosted web manager for turning selected YouTube subscriptions into private Podsync podcast feeds, including classic-iPod-compatible video post-processing.

## v0.6.0 highlights

- New **Setup & Settings** page in the web GUI.
- Reads/writes the existing `/opt/podsync/config.toml` and `/opt/podsync-manager/.env` files.
- API keys/secrets are masked in the UI and blank secret fields mean “keep the existing value”.
- Safe timestamped backups plus `.bak` copies before config changes.

## Fresh install

On an Ubuntu/Debian-style Linux server:

```bash
git clone https://github.com/leedsy/PodSync-Manager.git
cd podsync-manager
sudo ./setup.sh
```

- Open your Browser:
```bash
http://<server-ip>:3000
```

Youtube API Required:
https://console.cloud.google.com/
- Enable Youtube API
- Create oAuth Client ID and Secret
- Application type: TVs and Limited Input devices (This bypasses the need for a URI Redirect)

The installer prints the Manager URL and a generated admin password. Open the URL, sign in, then complete **Setup & Settings** in the browser.


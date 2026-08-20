# Podsync Manager v0.6.1

## Updates
- Bug-fix release focused on clean installs and diagnostics.
- Podsync no longer crash-loops on a fresh install with zero feeds.
- Manager reports `waiting for first feed`, `running`, `restarting`, and stopped states correctly.
- Host LAN IP is detected by setup/update on the host rather than using the Manager container bridge address.
- New subscription rows inherit the configured Scan/Keep defaults instead of briefly showing 0/0.
- yt-dlp diagnostics support Podsync's historical `youtube-dl` executable naming/path and can fall back to the startup log version.
- Runtime probes are shown as `not checked` while Podsync is intentionally waiting/stopped.
- Adds `update.sh` for safe code-only upgrades while preserving `config.toml`, `.env`, media and database files.



# v0.6.0 release notes

## Main change
Configuration can now be completed and maintained in the Podsync Manager web GUI rather than by editing files during installation.

## Compatibility
This release is designed as an in-place upgrade from the working v0.5.3 layout. `setup.sh` does not replace an existing Podsync `config.toml` or Manager `.env`; it creates pre-upgrade backups before updating application files.

## Storage model
No SQL server is added. Existing files remain the source of truth:

- `/opt/podsync/config.toml` — Podsync server, tokens and feeds
- `/opt/podsync-manager/.env` — Manager login, Google OAuth and RSS base URL
- `/opt/podsync-manager/data/state.json` — existing Manager OAuth tokens/mappings/defaults

## Video
The proven FFmpeg iPod muxer pipeline remains. The postprocessor now accepts an optional preset argument. No argument defaults to the existing 640x480 Classic High mode, preserving old feed behaviour.

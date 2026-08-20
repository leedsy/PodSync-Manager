import express from "express";
import session from "express-session";
import TOML from "@iarna/toml";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const app = express();

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PODSYNC_CONTAINER = process.env.PODSYNC_CONTAINER || "podsync";
const CONFIG_PATH = process.env.PODSYNC_CONFIG_PATH || "/podsync/config.toml";
const DATA_DIR = process.env.PODSYNC_DATA_DIR || "/podsync/data";
const MANAGER_DATA_DIR = process.env.MANAGER_DATA_DIR || "/manager-data";
const MANAGER_ENV_PATH = process.env.MANAGER_ENV_PATH || "/manager-host/.env";
const STATE_PATH = path.join(MANAGER_DATA_DIR, "state.json");
const HOST_LAN_IP = String(process.env.HOST_LAN_IP || "").trim();

await fsp.mkdir(MANAGER_DATA_DIR, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 1000 * 60 * 60 * 12 }
}));

function safeSlug(input) {
  return String(input || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "feed";
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function parseEnvText(raw) {
  const result = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function readEnvFile() {
  try {
    const raw = await fsp.readFile(MANAGER_ENV_PATH, "utf8");
    return { raw, obj: parseEnvText(raw) };
  } catch {
    return { raw: "", obj: {} };
  }
}

function envValue(envObj, key) {
  return envObj[key] ?? process.env[key] ?? "";
}

function updateEnvText(raw, patch) {
  const lines = String(raw || "").split(/\r?\n/);
  const seen = new Set();
  const out = lines.map(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !(m[1] in patch)) return line;
    seen.add(m[1]);
    return `${m[1]}=${String(patch[m[1]] ?? "").replace(/[\r\n]/g, "")}`;
  });
  for (const [key, value] of Object.entries(patch)) {
    if (!seen.has(key)) out.push(`${key}=${String(value ?? "").replace(/[\r\n]/g, "")}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

async function atomicWrite(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, content, { mode });
  await fsp.rename(tmp, filePath);
}

async function backupFile(filePath, raw, label) {
  const dir = path.join(MANAGER_DATA_DIR, "backups");
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fsp.writeFile(path.join(dir, `${label}-${stamp}`), raw, { mode: 0o600 });
  try { await fsp.writeFile(`${filePath}.bak`, raw, { mode: 0o600 }); } catch {}
}

async function writeEnvPatch(patch) {
  const { raw } = await readEnvFile();
  const next = updateEnvText(raw, patch);
  await backupFile(MANAGER_ENV_PATH, raw, "manager-env.bak");
  await atomicWrite(MANAGER_ENV_PATH, next, 0o600);
}

async function readState() {
  try { return JSON.parse(await fsp.readFile(STATE_PATH, "utf8")); }
  catch { return { google: null, managedFeeds: {}, feedSettings: {}, ui: {}, deviceAuth: null }; }
}
async function writeState(state) {
  await atomicWrite(STATE_PATH, JSON.stringify(state, null, 2) + "\n", 0o600);
}
async function readConfig() {
  const raw = await fsp.readFile(CONFIG_PATH, "utf8");
  return { raw, obj: TOML.parse(raw) };
}
async function writeConfig(obj, oldRaw) {
  const next = TOML.stringify(obj);
  TOML.parse(next); // validate generated TOML before touching the live file
  await backupFile(CONFIG_PATH, oldRaw, "config.toml.bak");
  // Podsync bind-mounts config.toml as a single file. Write in place so the
  // running container keeps seeing the same inode; a rename could leave a
  // single-file bind mount pointing at the old file until recreation.
  await fsp.writeFile(CONFIG_PATH, next, { mode: 0o644 });
}
async function docker(args, timeout = 30000) {
  return execFileAsync("docker", args, { timeout, maxBuffer: 5 * 1024 * 1024 });
}
function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  res.status(401).json({ error: "Not signed in" });
}
async function fileExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function mediaDirStats(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    let count = 0, bytes = 0;
    for (const x of entries) {
      if (!x.isFile() || !/\.(mp3|m4a|aac|ogg|opus|webm|mp4)$/i.test(x.name)) continue;
      count++;
      try { bytes += (await fsp.stat(path.join(dir, x.name))).size; } catch {}
    }
    return { count, bytes };
  } catch { return { count: 0, bytes: 0 }; }
}

function parsePeriodMs(value) {
  const s = String(value || '').trim();
  let total = 0, matched = false;
  const re = /(\d+(?:\.\d+)?)([smhd])/gi;
  let m;
  while ((m = re.exec(s))) {
    matched = true;
    const n = Number(m[1]);
    total += n * ({ s:1000, m:60000, h:3600000, d:86400000 })[m[2].toLowerCase()];
  }
  return matched ? total : null;
}

function validManagedFeedId(feedId) {
  return /^[a-z0-9][a-z0-9-]{0,49}$/.test(String(feedId || ''));
}
function channelIdFromUrl(url) {
  const m = String(url || "").match(/youtube\.com\/channel\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}
function videoPresetFromConfig(cfg) {
  const cmd = cfg?.post_episode_download?.[0]?.command;
  return Array.isArray(cmd) && cmd[1] === "max-compat" ? "max-compat" : "classic-high";
}
function configSettingsForFeed(feedId, cfg) {
  const mediaType = cfg?.format === "video" ? "video" : "audio";
  return {
    feedId,
    podcastTitle: String(cfg?.custom?.title || cfg?.custom?.author || feedId),
    pageSize: Number(cfg?.page_size || 20),
    keepLast: Number(cfg?.clean?.keep_last || 20),
    updatePeriod: String(cfg?.update_period || "2h"),
    mediaType,
    videoPreset: mediaType === "video" ? videoPresetFromConfig(cfg) : "classic-high",
    filenameTemplate: String(cfg?.filename_template || "{{pub_date}}_{{title}}_{{id}}")
  };
}
async function removeFeedFiles(feedId) {
  if (!validManagedFeedId(feedId)) throw new Error(`Refusing to delete unsafe feed id: ${feedId}`);
  await fsp.rm(path.join(DATA_DIR, `${feedId}.xml`), { force: true });
  await fsp.rm(path.join(DATA_DIR, feedId), { recursive: true, force: true });
}
function isLikelyContainerAddress(address) {
  return /^172\.(1[6-9]|2\d|3[01])\./.test(String(address || ""));
}
function detectLanIps() {
  const result = [];
  const seen = new Set();
  if (HOST_LAN_IP && !seen.has(HOST_LAN_IP)) {
    result.push({ name: "host", address: HOST_LAN_IP, preferred: true });
    seen.add(HOST_LAN_IP);
  }
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const x of entries || []) {
      if (x.family !== "IPv4" || x.internal || seen.has(x.address)) continue;
      if (isLikelyContainerAddress(x.address)) continue;
      result.push({ name, address: x.address, preferred: false });
      seen.add(x.address);
    }
  }
  return result;
}
function hasConfiguredFeeds(cfg) {
  return !!(cfg?.feeds && Object.keys(cfg.feeds).length);
}
async function containerState() {
  try {
    const { stdout } = await docker(["inspect", "-f", "{{.State.Running}}|{{.State.Status}}|{{.State.Restarting}}", PODSYNC_CONTAINER]);
    const [running, status, restarting] = stdout.trim().split("|");
    return { exists: true, running: running === "true", status: status || "unknown", restarting: restarting === "true" };
  } catch {
    return { exists: false, running: false, status: "not-created", restarting: false };
  }
}
async function reconcilePodsync(cfg, { restartIfRunning = false } = {}) {
  const hasFeeds = hasConfiguredFeeds(cfg);
  const state = await containerState();
  if (!hasFeeds) {
    if (state.running || state.restarting) {
      try { await docker(["stop", PODSYNC_CONTAINER], 60000); } catch {}
    }
    return { action: "waiting", state: await containerState() };
  }
  if (!state.exists) throw new Error("Podsync container has not been created. Run setup.sh or update.sh once.");
  if (state.running && restartIfRunning) {
    await docker(["restart", PODSYNC_CONTAINER], 60000);
    return { action: "restarted", state: await containerState() };
  }
  if (!state.running) {
    await docker(["start", PODSYNC_CONTAINER], 60000);
    return { action: "started", state: await containerState() };
  }
  return { action: "unchanged", state };
}
function secretHint(value) {
  const s = String(value || "");
  return s ? `Configured${s.length > 4 ? ` (ends ${s.slice(-4)})` : ""}` : "Not configured";
}
async function runtimeSettings() {
  const { obj: envObj } = await readEnvFile();
  const { obj: cfg } = await readConfig();
  const rssBaseUrl = normalizeBaseUrl(envValue(envObj, "RSS_BASE_URL") || cfg?.server?.hostname || "");
  return {
    envObj,
    cfg,
    rssBaseUrl,
    googleClientId: envValue(envObj, "GOOGLE_CLIENT_ID"),
    googleClientSecret: envValue(envObj, "GOOGLE_CLIENT_SECRET"),
    adminPassword: envValue(envObj, "ADMIN_PASSWORD")
  };
}
async function refreshGoogleToken(state) {
  const rs = await runtimeSettings();
  if (!state.google?.refresh_token) throw new Error("YouTube is not connected");
  if (!(rs.googleClientId && rs.googleClientSecret)) throw new Error("Google device OAuth credentials are not configured");
  if (state.google.access_token && state.google.expires_at > Date.now() + 60000) return state.google.access_token;
  const body = new URLSearchParams({
    client_id: rs.googleClientId,
    client_secret: rs.googleClientSecret,
    refresh_token: state.google.refresh_token,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.error || "Could not refresh Google token");
  state.google.access_token = data.access_token;
  state.google.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  await writeState(state);
  return data.access_token;
}

app.post("/api/login", async (req, res) => {
  try {
    const rs = await runtimeSettings();
    if (!rs.adminPassword) return res.status(500).json({ error: "ADMIN_PASSWORD is not configured" });
    const supplied = String(req.body?.password || "");
    const a = Buffer.from(supplied);
    const b = Buffer.from(rs.adminPassword);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: "Incorrect password" });
    req.session.authed = true;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/logout", requireAuth, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json({ authed: !!req.session?.authed }));

app.get("/api/status", requireAuth, async (req, res) => {
  const { obj: cfg } = await readConfig();
  const hasFeeds = hasConfiguredFeeds(cfg);
  const stateInfo = await containerState();
  const container = {
    ...stateInfo,
    waitingForFeed: !hasFeeds,
    displayStatus: !hasFeeds ? "waiting for first feed" : (stateInfo.restarting ? "restarting" : stateInfo.status)
  };
  let disk = null;
  try {
    const s = await fsp.statfs(DATA_DIR);
    disk = { total: s.blocks*s.bsize, free: s.bavail*s.bsize, used: (s.blocks-s.bfree)*s.bsize };
  } catch {}
  const state = await readState();
  const rs = await runtimeSettings();
  res.json({
    container, disk, hasFeeds,
    googleConnected: !!state.google?.refresh_token,
    deviceOAuthConfigured: !!(rs.googleClientId && rs.googleClientSecret),
    rssBaseUrl: rs.rssBaseUrl
  });
});

app.get("/api/logs", requireAuth, async (req, res) => {
  try {
    const { stdout, stderr } = await docker(["logs", "--tail", "200", PODSYNC_CONTAINER]);
    res.json({ logs: [stdout, stderr].filter(Boolean).join("\n") });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/restart", requireAuth, async (req, res) => {
  try {
    const { obj: cfg } = await readConfig();
    if (!hasConfiguredFeeds(cfg)) return res.status(409).json({ error: "Podsync is waiting for the first feed. Add a subscription before starting it." });
    const result = await reconcilePodsync(cfg, { restartIfRunning: true });
    res.json({ ok: true, action: result.action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/update-now", requireAuth, async (req, res) => {
  try {
    const { obj: cfg } = await readConfig();
    if (!hasConfiguredFeeds(cfg)) return res.status(409).json({ error: "No feeds are configured yet." });
    await reconcilePodsync(cfg, { restartIfRunning: true });
    res.json({ ok: true, message: "Podsync restarted; all configured feeds will be checked now." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Setup / Settings */
app.get("/api/setup", requireAuth, async (req, res) => {
  try {
    const rs = await runtimeSettings();
    const state = await readState();
    const token = Array.isArray(rs.cfg?.tokens?.youtube) ? rs.cfg.tokens.youtube[0] : rs.cfg?.tokens?.youtube;
    const defaults = {
      pageSize: 5,
      keepLast: 10,
      updatePeriod: "2h",
      filenameTemplate: "{{pub_date}}_{{title}}_{{id}}",
      mediaType: "audio",
      videoPreset: "classic-high",
      ...(state.ui?.defaults || {})
    };
    const complete = !!(token && rs.googleClientId && rs.googleClientSecret && rs.rssBaseUrl);
    res.json({
      complete,
      youtubeApiKeyConfigured: !!token,
      youtubeApiKeyHint: secretHint(token),
      googleClientId: rs.googleClientId,
      googleClientSecretConfigured: !!rs.googleClientSecret,
      googleClientSecretHint: secretHint(rs.googleClientSecret),
      rssBaseUrl: rs.rssBaseUrl,
      serverPort: Number(rs.cfg?.server?.port || 8080),
      serverHostname: String(rs.cfg?.server?.hostname || ""),
      lanIps: detectLanIps(),
      hostLanIp: HOST_LAN_IP,
      hasFeeds: hasConfiguredFeeds(rs.cfg),
      defaults
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/setup", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { raw, obj } = await readConfig();
    const state = await readState();
    let configChanged = false;

    obj.server ||= {};
    obj.tokens ||= {};
    obj.downloader ||= {};

    if (String(body.youtubeApiKey || "").trim()) {
      obj.tokens.youtube = String(body.youtubeApiKey).trim();
      configChanged = true;
    }

    const rssBaseUrl = normalizeBaseUrl(body.rssBaseUrl || body.serverHostname || "");
    if (rssBaseUrl) {
      let u;
      try { u = new URL(rssBaseUrl); } catch { throw new Error("RSS base URL must be a valid http:// or https:// URL"); }
      if (!["http:", "https:"].includes(u.protocol)) throw new Error("RSS base URL must use http:// or https://");
      obj.server.hostname = rssBaseUrl;
      configChanged = true;
    }

    obj.downloader.self_update = true;

    if (configChanged) await writeConfig(obj, raw);

    const envPatch = {};
    if (body.googleClientId !== undefined) envPatch.GOOGLE_CLIENT_ID = String(body.googleClientId || "").trim();
    if (String(body.googleClientSecret || "").trim()) envPatch.GOOGLE_CLIENT_SECRET = String(body.googleClientSecret).trim();
    if (rssBaseUrl) envPatch.RSS_BASE_URL = rssBaseUrl;
    if (Object.keys(envPatch).length) await writeEnvPatch(envPatch);

    const d = body.defaults || {};
    state.ui ||= {};
    state.ui.defaults = {
      pageSize: Math.max(1, Math.min(50, Number(d.pageSize || 5))),
      keepLast: Math.max(1, Number(d.keepLast || 10)),
      updatePeriod: String(d.updatePeriod || "2h"),
      filenameTemplate: String(d.filenameTemplate || "{{pub_date}}_{{title}}_{{id}}"),
      mediaType: d.mediaType === "video" ? "video" : "audio",
      videoPreset: d.videoPreset === "max-compat" ? "max-compat" : "classic-high"
    };
    await writeState(state);

    let podsyncAction = "unchanged";
    if (configChanged) {
      const result = await reconcilePodsync(obj, { restartIfRunning: true });
      podsyncAction = result.action;
    }
    const message = !hasConfiguredFeeds(obj)
      ? "Settings saved. Podsync will start automatically after you add the first feed."
      : (podsyncAction === "restarted" ? "Settings saved and Podsync restarted." : "Settings saved.");
    res.json({ ok: true, message, podsyncAction });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/diagnostics", requireAuth, async (req, res) => {
  const checks = [];
  let cfg = null;
  try {
    cfg = (await readConfig()).obj;
    checks.push({ name: "config.toml", level: "ok", ok: true, value: "valid TOML" });
  } catch (e) {
    checks.push({ name: "config.toml", level: "error", ok: false, value: e.message });
  }

  const hasFeeds = hasConfiguredFeeds(cfg);
  const c = await containerState();
  if (!hasFeeds) {
    checks.unshift({ name: "Podsync container", level: "skip", ok: true, value: "waiting for first feed" });
  } else if (c.restarting || c.status === "restarting") {
    checks.unshift({ name: "Podsync container", level: "error", ok: false, value: "restarting" });
  } else if (c.running) {
    checks.unshift({ name: "Podsync container", level: "ok", ok: true, value: "running" });
  } else {
    checks.unshift({ name: "Podsync container", level: "error", ok: false, value: c.status || "stopped" });
  }

  try {
    const rs = await runtimeSettings();
    const token = Array.isArray(rs.cfg?.tokens?.youtube) ? rs.cfg.tokens.youtube[0] : rs.cfg?.tokens?.youtube;
    checks.push({ name: "YouTube API key", level: token ? "ok" : "error", ok: !!token, value: token ? "configured" : "missing" });
    checks.push({ name: "Google device OAuth", level: (rs.googleClientId && rs.googleClientSecret) ? "ok" : "error", ok: !!(rs.googleClientId && rs.googleClientSecret), value: (rs.googleClientId && rs.googleClientSecret) ? "configured" : "missing" });
    checks.push({ name: "RSS base URL", level: rs.rssBaseUrl ? "ok" : "error", ok: !!rs.rssBaseUrl, value: rs.rssBaseUrl || "missing" });
  } catch {}

  if (!hasFeeds) {
    for (const name of ["yt-dlp", "FFmpeg", "Node", "Deno", "iPod muxer"]) {
      checks.push({ name, level: "skip", ok: true, value: "not checked until Podsync starts" });
    }
    return res.json({ checks, lanIps: detectLanIps(), hasFeeds });
  }

  if (!c.running || c.restarting) {
    for (const name of ["yt-dlp", "FFmpeg", "Node", "Deno", "iPod muxer"]) {
      checks.push({ name, level: "skip", ok: true, value: `not checked while Podsync is ${c.status || "stopped"}` });
    }
    return res.json({ checks, lanIps: detectLanIps(), hasFeeds });
  }

  // Podsync may keep yt-dlp under its historical youtube-dl name/path. Try
  // common commands first, then fall back to the version Podsync logged.
  try {
    const { stdout } = await docker(["exec", PODSYNC_CONTAINER, "sh", "-c",
      "if command -v yt-dlp >/dev/null 2>&1; then yt-dlp --version; elif command -v youtube-dl >/dev/null 2>&1; then youtube-dl --version; elif [ -x /app/youtube-dl ]; then /app/youtube-dl --version; elif [ -x /usr/local/bin/youtube-dl ]; then /usr/local/bin/youtube-dl --version; else exit 127; fi"]);
    checks.push({ name: "yt-dlp", level: "ok", ok: true, value: stdout.trim() });
  } catch {
    try {
      const { stdout, stderr } = await docker(["logs", "--tail", "150", PODSYNC_CONTAINER]);
      const match = `${stdout}\n${stderr}`.match(/using youtube-dl\s+([^\s]+)/i);
      if (!match) throw new Error("version not found");
      checks.push({ name: "yt-dlp", level: "ok", ok: true, value: `${match[1]} (from Podsync startup log)` });
    } catch (e) {
      checks.push({ name: "yt-dlp", level: "error", ok: false, value: e.message });
    }
  }

  const probes = [
    ["FFmpeg", "ffmpeg -version | head -n 1", value => !!value],
    ["Node", "node --version 2>/dev/null || true", value => !!value],
    ["Deno", "deno --version 2>/dev/null | head -n 1 || true", value => !!value],
    ["iPod muxer", "ffmpeg -hide_banner -muxers 2>/dev/null | grep -q ' ipod ' && echo available || echo missing", value => value === "available"]
  ];
  for (const [name, command, test] of probes) {
    try {
      const { stdout } = await docker(["exec", PODSYNC_CONTAINER, "sh", "-c", command]);
      const value = stdout.trim() || "not installed";
      const ok = test(value);
      checks.push({ name, level: ok ? "ok" : "error", ok, value });
    } catch (e) {
      checks.push({ name, level: "error", ok: false, value: e.message });
    }
  }
  res.json({ checks, lanIps: detectLanIps(), hasFeeds });
});

/* Google device authorization flow */
app.post("/api/youtube/device/start", requireAuth, async (req, res) => {
  try {
    const rs = await runtimeSettings();
    if (!(rs.googleClientId && rs.googleClientSecret)) return res.status(400).json({ error: "Add Google device OAuth credentials in Setup first" });
    const body = new URLSearchParams({ client_id: rs.googleClientId, scope: "https://www.googleapis.com/auth/youtube.readonly" });
    const r = await fetch("https://oauth2.googleapis.com/device/code", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error_description || data.error || "Could not start Google device authorization");
    const state = await readState();
    state.deviceAuth = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_url: data.verification_url || data.verification_uri,
      expires_at: Date.now() + Number(data.expires_in || 1800) * 1000,
      interval: Number(data.interval || 5), status: "pending"
    };
    await writeState(state);
    res.json({ userCode: state.deviceAuth.user_code, verificationUrl: state.deviceAuth.verification_url, expiresIn: Number(data.expires_in || 1800), interval: state.deviceAuth.interval });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/youtube/device/poll", requireAuth, async (req, res) => {
  try {
    const state = await readState();
    const d = state.deviceAuth;
    if (!d?.device_code) return res.status(400).json({ error: "No device authorization is in progress" });
    if (Date.now() > d.expires_at) { state.deviceAuth = null; await writeState(state); return res.json({ status: "expired" }); }
    const rs = await runtimeSettings();
    const body = new URLSearchParams({ client_id: rs.googleClientId, client_secret: rs.googleClientSecret, code: d.device_code, grant_type: "http://oauth.net/grant_type/device/1.0" });
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const data = await r.json();
    if (!r.ok) {
      if (data.error === "authorization_pending") return res.json({ status: "pending", interval: d.interval });
      if (data.error === "slow_down") { d.interval = Math.min(30, Number(d.interval || 5) + 5); state.deviceAuth = d; await writeState(state); return res.json({ status: "pending", interval: d.interval }); }
      if (data.error === "access_denied") { state.deviceAuth = null; await writeState(state); return res.json({ status: "denied" }); }
      if (data.error === "expired_token") { state.deviceAuth = null; await writeState(state); return res.json({ status: "expired" }); }
      throw new Error(data.error_description || data.error || "Google token request failed");
    }
    state.google = { access_token: data.access_token, refresh_token: data.refresh_token || state.google?.refresh_token, expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 };
    state.deviceAuth = null;
    await writeState(state);
    res.json({ status: "connected" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/youtube/disconnect", requireAuth, async (req, res) => {
  const state = await readState();
  state.google = null; state.deviceAuth = null; await writeState(state); res.json({ ok: true });
});

app.get("/api/subscriptions", requireAuth, async (req, res) => {
  try {
    const state = await readState();
    const token = await refreshGoogleToken(state);
    let pageToken = "";
    const items = [];
    do {
      const u = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
      u.searchParams.set("part", "snippet,contentDetails"); u.searchParams.set("mine", "true"); u.searchParams.set("maxResults", "50");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || "YouTube API request failed");
      for (const x of data.items || []) {
        const sn = x.snippet || {}, rid = sn.resourceId || {}, thumbs = sn.thumbnails || {};
        const thumb = (thumbs.high || thumbs.medium || thumbs.default || {}).url || "";
        items.push({ channelId: rid.channelId, title: sn.title || rid.channelId, description: sn.description || "", thumbnail: thumb, totalItems: x.contentDetails?.totalItemCount ?? null });
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    items.sort((a,b)=>a.title.localeCompare(b.title));

    const { obj } = await readConfig();
    const configFeeds = obj.feeds || {};
    const managedFeeds = { ...(state.managedFeeds || {}) };
    const feedSettings = {};
    for (const [feedId, cfg] of Object.entries(configFeeds)) {
      const channelId = channelIdFromUrl(cfg?.url);
      if (!channelId) continue;
      if (!managedFeeds[channelId]) managedFeeds[channelId] = feedId;
      feedSettings[channelId] = configSettingsForFeed(feedId, cfg);
    }
    res.json({ items, managedFeeds, feedSettings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/feeds", requireAuth, async (req, res) => {
  try {
    const { obj } = await readConfig();
    const { rssBaseUrl } = await runtimeSettings();
    const feeds = [];
    for (const [feedId, cfg] of Object.entries(obj.feeds || {})) {
      const title = cfg?.custom?.title || cfg?.custom?.author || feedId;
      const artwork = cfg?.custom?.cover_art || "";
      const xmlPath = path.join(DATA_DIR, `${feedId}.xml`);
      const mediaDir = path.join(DATA_DIR, feedId);
      const xmlExists = await fileExists(xmlPath);
      const media = await mediaDirStats(mediaDir);
      let lastUpdatedAt = null;
      if (xmlExists) { try { lastUpdatedAt = (await fsp.stat(xmlPath)).mtime.toISOString(); } catch {} }
      const updatePeriod = String(cfg?.update_period || "");
      const periodMs = parsePeriodMs(updatePeriod);
      const nextCheckAt = lastUpdatedAt && periodMs ? new Date(new Date(lastUpdatedAt).getTime() + periodMs).toISOString() : null;
      feeds.push({
        feedId, title, artwork,
        rssUrl: rssBaseUrl ? `${rssBaseUrl}/${encodeURIComponent(feedId)}.xml` : `/${feedId}.xml`,
        xmlExists, episodeCount: media.count, mediaBytes: media.bytes, updatePeriod,
        mediaType: cfg?.format === "video" ? "video" : "audio",
        videoPreset: cfg?.format === "video" ? videoPresetFromConfig(cfg) : null,
        lastUpdatedAt, nextCheckAt
      });
    }
    feeds.sort((a,b)=>a.title.localeCompare(b.title));
    res.json({ feeds, rssBaseUrl, opmlUrl: rssBaseUrl ? `${rssBaseUrl}/podsync.opml` : "/podsync.opml", opmlExists: await fileExists(path.join(DATA_DIR, "podsync.opml")) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/apply", requireAuth, async (req, res) => {
  try {
    const selections = Array.isArray(req.body?.feeds) ? req.body.feeds : [];
    const defaults = req.body?.defaults || {};
    const deleteRemovedData = req.body?.deleteRemovedData === true;
    const { raw, obj } = await readConfig();
    const state = await readState();
    obj.feeds ||= {};
    const oldManaged = state.managedFeeds || {};
    const selectedChannels = new Set(selections.map(x=>x.channelId));
    const removedFeedIds = new Set();
    for (const [channelId, oldFeedId] of Object.entries(oldManaged)) {
      if (!selectedChannels.has(channelId)) { delete obj.feeds[oldFeedId]; removedFeedIds.add(oldFeedId); }
    }

    const newManaged = {}, newFeedSettings = {};
    for (const item of selections) {
      const feedId = safeSlug(item.feedId || oldManaged[item.channelId] || item.title);
      const oldFeedId = oldManaged[item.channelId];
      if (oldFeedId && oldFeedId !== feedId) { delete obj.feeds[oldFeedId]; removedFeedIds.add(oldFeedId); }
      const pageSize = Math.max(1, Math.min(50, Number(item.pageSize || defaults.pageSize || 5)));
      const keepLast = Math.max(1, Number(item.keepLast || defaults.keepLast || 10));
      const updatePeriod = String(item.updatePeriod || defaults.updatePeriod || "2h");
      const podcastTitle = String(item.podcastTitle || item.title || feedId);
      const coverArt = String(item.thumbnail || "");
      const requestedTemplate = String(item.filenameTemplate || defaults.filenameTemplate || "{{pub_date}}_{{title}}_{{id}}");
      const filenameTemplate = requestedTemplate.includes("{{id}}") ? requestedTemplate : "{{pub_date}}_{{title}}_{{id}}";
      const mediaType = item.mediaType === "video" ? "video" : "audio";
      const videoPreset = item.videoPreset === "max-compat" ? "max-compat" : "classic-high";
      const commonYtdlpArgs = ["--js-runtimes", "node", "--remote-components", "ejs:github", "--extractor-args", "youtube:player_client=web_embedded"];
      const feedConfig = {
        url: `https://www.youtube.com/channel/${item.channelId}`,
        page_size: pageSize, update_period: updatePeriod, quality: "high", opml: true,
        clean: { keep_last: keepLast }, filename_template: filenameTemplate,
        custom: { title: podcastTitle, author: item.title || podcastTitle, cover_art: coverArt, cover_art_quality: "high", lang: "en" }
      };
      if (mediaType === "video") {
        feedConfig.format = "video";
        feedConfig.max_height = videoPreset === "max-compat" ? 240 : 480;
        feedConfig.youtube_dl_args = commonYtdlpArgs;
        feedConfig.post_episode_download = [{ command: ["/usr/local/bin/postprocess-ipod-video.sh", videoPreset], timeout: 1800 }];
      } else {
        feedConfig.format = "audio";
        feedConfig.youtube_dl_args = commonYtdlpArgs.concat(["--embed-thumbnail", "--convert-thumbnails", "jpg", "--add-metadata"]);
      }
      obj.feeds[feedId] = feedConfig;
      newManaged[item.channelId] = feedId;
      newFeedSettings[item.channelId] = { feedId, podcastTitle, pageSize, keepLast, updatePeriod, mediaType, videoPreset, filenameTemplate };
    }
    obj.downloader ||= {}; obj.downloader.self_update = true;
    await writeConfig(obj, raw);

    const deletedData = [];
    if (deleteRemovedData) for (const feedId of removedFeedIds) { await removeFeedFiles(feedId); deletedData.push(feedId); }
    state.managedFeeds = newManaged;
    state.feedSettings = newFeedSettings;
    state.ui = { ...(state.ui || {}), defaults: { ...(state.ui?.defaults || {}), ...defaults } };
    await writeState(state);
    const podsync = await reconcilePodsync(obj, { restartIfRunning: true });
    res.json({ ok: true, managedFeeds: newManaged, removedFeedIds: [...removedFeedIds], deletedData, podsyncAction: podsync.action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static("public"));
app.listen(PORT, "0.0.0.0", ()=>console.log(`Podsync Manager v0.6.1 listening on :${PORT}`));

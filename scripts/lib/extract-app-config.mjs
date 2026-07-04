#!/usr/bin/env node
/**
 * Read Psysonic app config from WebKit localStorage + XDG dirs.
 * Emits key=value lines (passwords/secrets redacted; header values hashed).
 *
 * Usage: node scripts/lib/extract-app-config.mjs [--app-id ID] [--repo-root PATH]
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const out = { appId: process.env.PSYSONIC_APP_ID || '', repoRoot: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--app-id' && argv[i + 1]) {
      out.appId = argv[++i];
    } else if (argv[i] === '--repo-root' && argv[i + 1]) {
      out.repoRoot = argv[++i];
    }
  }
  return out;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function emitSection(name) {
  process.stdout.write(`\n[${name}]\n`);
}

function emit(key, value) {
  const v = String(value ?? '').replace(/\n/g, '\\n');
  process.stdout.write(`${key}=${v}\n`);
}

function readAppIdFromRepo(repoRoot) {
  const conf = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
  if (!fs.existsSync(conf)) return '';
  try {
    const j = JSON.parse(fs.readFileSync(conf, 'utf8'));
    return typeof j.identifier === 'string' ? j.identifier : '';
  } catch {
    return '';
  }
}

function xdgDataHome() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function xdgConfigHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function decodeWebKitValue(raw) {
  if (raw == null) return null;
  const buf = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : null;
  if (buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(buf.subarray(2));
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(buf.subarray(2));
    }
    // WebKit often stores UTF-16LE without BOM
    if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) {
      return new TextDecoder('utf-16le').decode(buf);
    }
    return buf.toString('utf8');
  }
  if (typeof raw === 'string') return raw;
  return String(raw);
}

function readLocalStorageRaw(dbPath, storageKey) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(storageKey);
    db.close();
    if (!row?.value) return null;
    return decodeWebKitValue(row.value);
  } catch {
    return null;
  }
}

function readLocalStorageKey(dbPath, storageKey) {
  const text = readLocalStorageRaw(dbPath, storageKey);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickLocalStorageFile(dataDir) {
  const dir = path.join(dataDir, 'localstorage');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.localstorage') && !f.includes('-wal') && !f.includes('-shm'))
    .map(f => path.join(dir, f));
  if (files.length === 0) return null;

  // Prefer packaged app origin over vite dev (1420) when both exist.
  const ranked = files.sort((a, b) => {
    const score = p => {
      const base = path.basename(p);
      if (base.includes('tauri_localhost')) return 0;
      if (base.includes('1420')) return 2;
      return 1;
    };
    return score(a) - score(b);
  });

  for (const file of ranked) {
    const auth = readLocalStorageKey(file, 'psysonic-auth');
    if (auth?.state?.servers?.length) return file;
  }
  return ranked[0];
}

function probeHttpReachability(rawUrl) {
  if (!rawUrl) return 'empty';
  const url = rawUrl.startsWith('http') ? rawUrl : `http://${rawUrl}`;
  const r = spawnSync(
    'curl',
    ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '5', '--max-time', '10', url],
    { encoding: 'utf8', timeout: 15000 },
  );
  if (r.error) return `error:${r.error.code ?? 'unknown'}`;
  if (r.status !== 0) return `curl_exit_${r.status}`;
  return `http_${r.stdout.trim() || '000'}`;
}

function dumpNetworkProbes(servers) {
  emitSection('app_network_probe');
  const seen = new Set();
  servers.forEach((srv, i) => {
    for (const [kind, raw] of [
      ['url', srv.url],
      ['alternateUrl', srv.alternateUrl],
    ]) {
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      emit(`probe.${i}.${kind}`, probeHttpReachability(raw));
      emit(`probe.${i}.${kind}_target`, raw);
    }
  });
  if (seen.size === 0) emit('probe_status', 'no server URLs configured');
}

function dumpServerProfiles(state) {
  const servers = state?.servers ?? [];
  emit('active_server_id', state?.activeServerId ?? '');
  emit('server_count', servers.length);
  servers.forEach((srv, i) => {
    const p = `server.${i}`;
    emit(`${p}.id`, srv.id ?? '');
    emit(`${p}.name`, srv.name ?? '');
    emit(`${p}.url`, srv.url ?? '');
    emit(`${p}.alternateUrl`, srv.alternateUrl ?? '');
    emit(`${p}.shareUsesLocalUrl`, srv.shareUsesLocalUrl === true ? 'true' : 'false');
    emit(`${p}.username`, srv.username ?? '');
    emit(`${p}.password_set`, srv.password ? 'yes' : 'no');
    emit(`${p}.password_sha256`, srv.password ? sha256(srv.password) : 'none');
    emit(`${p}.customHeadersApplyTo`, srv.customHeadersApplyTo ?? 'public');
    const headers = srv.customHeaders ?? [];
    emit(`${p}.customHeaders_count`, headers.length);
    headers.forEach((h, hi) => {
      emit(`${p}.customHeaders.${hi}.name`, h.name ?? '');
      emit(`${p}.customHeaders.${hi}.value_sha256`, h.value ? sha256(h.value) : 'empty');
    });
  });
  dumpNetworkProbes(servers);
}

function fileMeta(label, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    emit(`${label}_exists`, 'no');
    return;
  }
  const st = fs.statSync(filePath);
  emit(`${label}_exists`, 'yes');
  emit(`${label}_path`, filePath);
  emit(`${label}_size`, st.size);
  emit(`${label}_mtime`, st.mtime.toISOString());
}

function listDir(label, dirPath, max = 12) {
  if (!fs.existsSync(dirPath)) {
    emit(`${label}_exists`, 'no');
    return;
  }
  emit(`${label}_exists`, 'yes');
  emit(`${label}_path`, dirPath);
  const entries = fs.readdirSync(dirPath).sort();
  emit(`${label}_entry_count`, entries.length);
  entries.slice(0, max).forEach((name, i) => emit(`${label}.entry.${i}`, name));
}

const { appId: appIdArg, repoRoot } = parseArgs(process.argv);
let appId = appIdArg || (repoRoot ? readAppIdFromRepo(repoRoot) : '');
if (!appId) appId = readAppIdFromRepo(process.cwd()) || 'dev.psysonic.player';

const dataDir = path.join(xdgDataHome(), appId);
const configDir = path.join(xdgConfigHome(), appId);

emitSection('app_config_paths');
emit('app_id', appId);
emit('data_dir', dataDir);
emit('config_dir', configDir);
emit('data_dir_exists', fs.existsSync(dataDir) ? 'yes' : 'no');
emit('config_dir_exists', fs.existsSync(configDir) ? 'yes' : 'no');

const lsFile = pickLocalStorageFile(dataDir);
fileMeta('localstorage_db', lsFile);

emitSection('app_preferences');
if (lsFile) {
  const lang = readLocalStorageRaw(lsFile, 'psysonic_language');
  emit('language', lang ?? 'unknown');

  const authWrap = readLocalStorageKey(lsFile, 'psysonic-auth');
  if (authWrap?.state) {
    emitSection('app_servers');
    dumpServerProfiles(authWrap.state);
  } else {
    emit('app_servers_status', 'psysonic-auth not found or empty');
  }
} else {
  emit('app_servers_status', 'no localstorage database found');
}

emitSection('app_config_files');
for (const rel of ['linux_wayland_text_profile', 'mini_player_pos.json', '.window-state.json']) {
  fileMeta(rel.replace(/\./g, '_'), path.join(configDir, rel));
}

emitSection('app_data_artifacts');
fileMeta('hsts_storage', path.join(dataDir, 'hsts-storage.sqlite'));
fileMeta('library_db', path.join(dataDir, 'databases', 'library', 'library.sqlite'));
listDir('localstorage_dir', path.join(dataDir, 'localstorage'));

import { DEFAULT_NIGHT_ORDER } from './data.js';

const KEYS = {
  PLAYERS: 'werwolf_players',
  HISTORY: 'werwolf_history',
  ACTIVE_GAME: 'werwolf_active_game',
  SETTINGS: 'werwolf_settings',
  BACKUP_SLOT: 'ww_bk_slot',
};
const BACKUP_COUNT = 3;
const bk = (i) => `ww_bk_${i}`;

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export function loadPlayers() { return load(KEYS.PLAYERS, []); }
export function savePlayers(p) { save(KEYS.PLAYERS, p); }

export function loadHistory() { return load(KEYS.HISTORY, []); }
export function saveHistory(h) { save(KEYS.HISTORY, h); }

export function loadActiveGame() { return load(KEYS.ACTIVE_GAME, null); }
export function saveActiveGame(g) {
  if (g) save(KEYS.ACTIVE_GAME, g);
  else localStorage.removeItem(KEYS.ACTIVE_GAME);
}

export function loadSettings() {
  return load(KEYS.SETTINGS, { darkMode: true, nightOrder: DEFAULT_NIGHT_ORDER });
}
export function saveSettings(s) { save(KEYS.SETTINGS, s); }

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── ROLLING BACKUPS (3 slots) ────────────────────────────────────────────────
let _lastBackupTs = 0;

export function createBackup(label = 'auto') {
  // Throttle: don't create two backups within 3 seconds (prevents double-fire)
  const now = Date.now();
  if (now - _lastBackupTs < 3000) return;
  _lastBackupTs = now;
  try {
    const slot = (parseInt(localStorage.getItem(KEYS.BACKUP_SLOT) || '0')) % BACKUP_COUNT;
    const snapshot = {
      ts: now,
      label,
      v: 1,
      players: load(KEYS.PLAYERS, []),
      history: load(KEYS.HISTORY, []),
      activeGame: load(KEYS.ACTIVE_GAME, null),
      settings: load(KEYS.SETTINGS, {}),
    };
    localStorage.setItem(bk(slot), JSON.stringify(snapshot));
    localStorage.setItem(KEYS.BACKUP_SLOT, String((slot + 1) % BACKUP_COUNT));
  } catch (e) { /* storage full — silently skip */ }
}

export function loadBackups() {
  const nextSlot = parseInt(localStorage.getItem(KEYS.BACKUP_SLOT) || '0');
  const result = [];
  for (let i = 0; i < BACKUP_COUNT; i++) {
    const idx = (nextSlot - 1 - i + BACKUP_COUNT) % BACKUP_COUNT;
    const raw = localStorage.getItem(bk(idx));
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      result.push({ slot: idx, ...data });
    } catch {}
  }
  return result; // newest first
}

export function restoreBackup(slotIdx) {
  const raw = localStorage.getItem(bk(slotIdx));
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data.players))  save(KEYS.PLAYERS,     data.players);
    if (Array.isArray(data.history))  save(KEYS.HISTORY,     data.history);
    if (data.settings)                save(KEYS.SETTINGS,    data.settings);
    if (data.activeGame !== undefined) {
      if (data.activeGame) save(KEYS.ACTIVE_GAME, data.activeGame);
      else localStorage.removeItem(KEYS.ACTIVE_GAME);
    }
    return true;
  } catch { return false; }
}

// ─── FILE EXPORT / IMPORT ─────────────────────────────────────────────────────
function buildTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export async function exportToFile(players, history, activeGame, settings, type = 'manual') {
  const filename = `${type}-werwolf-backup-${buildTimestamp()}.json`;
  const payload  = JSON.stringify({
    ts: Date.now(), v: 1, label: type,
    players, history, activeGame, settings,
  }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });

  // Prefer Web Share API (works natively on iOS PWA → opens system Share Sheet)
  if (navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Werwolf Backup' });
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled — not an error
    }
  }

  // Fallback: classic <a download> (works on desktop / Android Chrome)
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function importFromFile(jsonText) {
  const data = JSON.parse(jsonText); // throws on invalid JSON — caller handles
  if (!data.players || !data.history) throw new Error('Ungültiges Format');
  if (Array.isArray(data.players))  save(KEYS.PLAYERS,  data.players);
  if (Array.isArray(data.history))  save(KEYS.HISTORY,  data.history);
  if (data.settings)                save(KEYS.SETTINGS, data.settings);
  if (data.activeGame !== undefined) {
    if (data.activeGame) save(KEYS.ACTIVE_GAME, data.activeGame);
    else localStorage.removeItem(KEYS.ACTIVE_GAME);
  }
  return data;
}

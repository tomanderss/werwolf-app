import { createApp, reactive, computed, watch, nextTick } from './vue.esm-browser.prod.js';
import { BUILD, CHANGELOG } from './buildinfo.js';
import { ROLES, ROLE_ORDER, DEFAULT_ROLE_COUNTS, DEFAULT_NIGHT_ORDER, computeNightSteps } from './data.js';
import { loadPlayers, savePlayers, loadHistory, saveHistory, loadActiveGame, saveActiveGame, loadSettings, saveSettings, generateId, createBackup, loadBackups, restoreBackup, exportToFile, importFromFile } from './storage.js';
import { createGame, emptyNightActions, resolveNight, checkWinCondition, buildGameStats, computePlayerStats, computeRoleStats } from './logic.js';

const APP_START = Date.now(); // used for minimum splash duration
const splashVersion = document.getElementById('splash-version');
if (splashVersion) splashVersion.textContent = `v${BUILD}`;

// ─── GLOBAL STATE ────────────────────────────────────────────────────────────
const state = reactive({
  screen: 'home',
  darkMode: true,
  testMode: false,
  nightOrder: [...DEFAULT_NIGHT_ORDER],
  toast: null,
  modal: null,
  savedPlayers: [],
  history: [],
  setup: {
    step: 1,
    selectedPlayerIds: [],
    roleCounts: { ...DEFAULT_ROLE_COUNTS },
    hauptmannMethod: 'vote',
    nightOrder: [...DEFAULT_NIGHT_ORDER], // copy of global, editable per-game
    newPlayerName: '',
  },
  game: null,
  // night sub-state
  nightUI: {
    selectedIds: [],
    seerinRevealed: false,
    witchShowKill: false,
    witchKillTarget: null,
    witchHealConfirmed: false,
    loversSelected: [],
    confirmed: false,
    editingRoleAssign: false,
  },
  // day sub-state
  dayUI: {
    voteTarget: null,
    jagerTarget: null,
    hauptmannTarget: null,
    showDorfidiotReveal: false,
    showLoverDeath: null,
    dayPhase: 'deaths',
    jaegerSplash: false,
    loverSplash: null,
    loverDiedPartner: null,
  },
  historyDetail: null,
  showWhatsNew: false,
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', duration = 2200) {
  state.toast = { msg, type };
  setTimeout(() => { if (state.toast?.msg === msg) state.toast = null; }, duration);
}

function openModal(modal) { state.modal = modal; }
function closeModal() { state.modal = null; }

function navigate(screen) {
  state.screen = screen;
  if (screen === 'home') {
    state.historyDetail = null;
  }
}

function alivePlayers(game) {
  return (game || state.game).players.filter(p => p.isAlive);
}

function playerById(id) {
  return state.game?.players.find(p => p.id === id);
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function formatDuration(ms) {
  if (!ms) return '–';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} Min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function roleName(id) { return ROLES[id]?.name || id; }
function roleIcon(id) { return ROLES[id]?.icon || '?'; }

function teamLabel(team) {
  if (team === 'wolves') return 'Werwölfe';
  if (team === 'village') return 'Dorf';
  if (team === 'lovers') return 'Liebespaar';
  return team;
}

// ─── VIEWPORT HEIGHT FIX (iOS Safari) ────────────────────────────────────────
function fixVH() {
  document.documentElement.style.setProperty('--app-h', window.innerHeight + 'px');
}
fixVH();
// Only update on orientation change — NOT on resize, because keyboard appearance
// fires resize and shrinks the layout, causing a jarring reflow while typing.
window.addEventListener('orientationchange', () => setTimeout(fixVH, 300));

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  const settings = loadSettings();
  state.darkMode = true; // always dark mode
  state.nightOrder = settings.nightOrder || [...DEFAULT_NIGHT_ORDER];
  applyTheme();
  state.savedPlayers = loadPlayers();
  state.history = loadHistory();
  const active = loadActiveGame();
  if (active) state.game = active;
  // Auto-backup on every app start
  createBackup('start');
  // Show What's New popup if version changed
  const seenVersion = localStorage.getItem('ww_seen_version');
  if (seenVersion !== BUILD) {
    state.showWhatsNew = true;
    localStorage.setItem('ww_seen_version', BUILD);
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : 'light');
}

function toggleTheme() {
  state.darkMode = !state.darkMode;
  applyTheme();
  saveSettings({ darkMode: state.darkMode, nightOrder: state.nightOrder });
}

// ─── PLAYER MANAGEMENT ───────────────────────────────────────────────────────
function addPlayer(name) {
  name = name.trim();
  if (!name) return showToast('Name darf nicht leer sein', 'error');
  if (state.savedPlayers.find(p => p.name.toLowerCase() === name.toLowerCase())) {
    return showToast('Spieler existiert bereits', 'error');
  }
  const p = { id: generateId(), name, createdAt: Date.now() };
  state.savedPlayers.push(p);
  savePlayers(state.savedPlayers);
  showToast(`${name} hinzugefügt`, 'success');
}

function removePlayer(id) {
  state.savedPlayers = state.savedPlayers.filter(p => p.id !== id);
  savePlayers(state.savedPlayers);
}

const DEFAULT_PLAYERS = ['Tom','Tjure','Lasse','Tara','Marie','Britta','Oliver','Maja','Tom K.','Kaja','Sven','Nicole','Oma Gitti','Opa Manni','Oma Ingeli','Opa Fritz'];

function addDefaultPlayers() {
  let added = 0;
  for (const name of DEFAULT_PLAYERS) {
    if (!state.savedPlayers.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      const p = { id: generateId(), name, createdAt: Date.now() };
      state.savedPlayers.push(p);
      added++;
    }
  }
  savePlayers(state.savedPlayers);
  showToast(added > 0 ? `${added} Spieler hinzugefügt` : 'Alle Spieler bereits vorhanden', 'success');
}

// ─── SETUP ───────────────────────────────────────────────────────────────────
function startSetup(useRoleReveal = false) {
  state.setup = {
    step: 1,
    selectedPlayerIds: [],
    roleCounts: { ...DEFAULT_ROLE_COUNTS },
    hauptmannMethod: 'vote',
    nightOrder: [...state.nightOrder],
    newPlayerName: '',
    useRoleReveal,
  };
  navigate('setup');
}

function startSetupWithReveal() { startSetup(true); }

function setupTogglePlayer(id) {
  const idx = state.setup.selectedPlayerIds.indexOf(id);
  if (idx >= 0) state.setup.selectedPlayerIds.splice(idx, 1);
  else state.setup.selectedPlayerIds.push(id);
}

function setupSelectedCount() {
  return state.setup.selectedPlayerIds.length;
}

function setupTotalRoles() {
  const counts = state.setup.roleCounts;
  return Object.values(counts).reduce((s, v) => s + v, 0);
}

function setupDorfbewohner() {
  const total = setupSelectedCount();
  const roles = setupTotalRoles();
  return Math.max(0, total - roles);
}

function setupValidateStep1() {
  if (setupSelectedCount() < 4) {
    showToast('Mindestens 4 Spieler benötigt', 'error');
    return false;
  }
  return true;
}

function setupValidateStep2() {
  const total = setupSelectedCount();
  const roles = setupTotalRoles();
  const wolves = state.setup.roleCounts.werwolf;
  if (wolves < 1) {
    showToast('Mindestens 1 Werwolf benötigt', 'error');
    return false;
  }
  if (roles > total) {
    showToast(`Zu viele Rollen (${roles} > ${total} Spieler)`, 'error');
    return false;
  }
  return true;
}

function setupNextStep() {
  if (state.setup.step === 1 && !setupValidateStep1()) return;
  if (state.setup.step === 2 && !setupValidateStep2()) return;
  if (state.setup.step < 3) state.setup.step++;
}

function setupPrevStep() {
  if (state.setup.step > 1) state.setup.step--;
}

function setupIncrRole(role) {
  const total = setupTotalRoles();
  if (total >= setupSelectedCount()) {
    showToast('Alle Plätze vergeben', 'error');
    return;
  }
  state.setup.roleCounts[role]++;
}

function setupDecrRole(role) {
  if (state.setup.roleCounts[role] > 0) state.setup.roleCounts[role]--;
}

function launchGame() {
  const players = state.savedPlayers.filter(p => state.setup.selectedPlayerIds.includes(p.id));
  // Also persist the chosen order as the new global default
  state.nightOrder = [...state.setup.nightOrder];
  saveSettings({ darkMode: state.darkMode, nightOrder: state.nightOrder });
  const game = createGame({
    players,
    roleCounts: state.setup.roleCounts,
    hauptmannMethod: state.setup.hauptmannMethod,
    nightOrder: state.setup.nightOrder,
  });
  state.game = game;

  if (state.setup.useRoleReveal) {
    // Randomly assign roles and start pass-phone reveal flow
    const assigned = [];
    Object.entries(state.setup.roleCounts).forEach(([role, count]) => {
      for (let i = 0; i < count; i++) assigned.push(role);
    });
    while (assigned.length < game.players.length) assigned.push('dorfbewohner');
    const shuffled = [...assigned].sort(() => Math.random() - 0.5);
    game.players.forEach((p, i) => { p.role = shuffled[i]; });
    game.rolesAutoAssigned = true;
    state.game.phase = 'role-reveal';
    state.game.roleRevealIndex = 0;
    state.game.roleRevealShown = false;
  } else {
    state.game.phase = 'hauptmann-init';
  }

  resetNightUI();
  saveActiveGame(game);
  navigate('game');
}

// ─── ROLE REVEAL (pass-phone mode) ───────────────────────────────────────────
function showCurrentRole() {
  state.game.roleRevealShown = true;
  saveActiveGame(state.game);
}

function advanceRoleReveal() {
  const g = state.game;
  g.roleRevealShown = false;
  g.roleRevealIndex++;
  if (g.roleRevealIndex >= g.players.length) {
    g.phase = 'hauptmann-init';
    g.roleRevealIndex = 0;
  }
  saveActiveGame(g);
}

// ─── ROLE ASSIGNMENT ─────────────────────────────────────────────────────────
function toggleRoleAssign(playerId, roleId) {
  const g = state.game;
  const p = playerById(playerId);
  if (!p) return;
  if (p.role === roleId) {
    p.role = 'unknown'; // de-assign
  } else if (p.role === 'unknown') {
    const count = g.roleCounts[roleId] || 1;
    const filled = g.players.filter(pl => pl.role === roleId).length;
    if (filled >= count) {
      // Already full — for single-slot roles replace the existing holder
      if (count === 1) {
        const existing = g.players.find(pl => pl.role === roleId);
        if (existing) existing.role = 'unknown';
        p.role = roleId;
      }
    } else {
      p.role = roleId;
    }
  }
  state.nightUI.editingRoleAssign = false;
  saveActiveGame(g);
}


function assignRole(playerId, role) {
  const p = playerById(playerId);
  if (!p) return;
  p.role = role;
  // If jaeger assigned to a night wolf-kill victim, retroactively trigger their ability
  if (role === 'jaeger' && state.game.dayState?.deaths) {
    const d = state.game.dayState.deaths.find(d => d.playerId === playerId && (d.cause === 'wolves' || d.cause === 'wolves-hure'));
    if (d) state.game.dayState.jaegerMustAct = true;
  }
  saveActiveGame(state.game);
}

// ─── NIGHT PHASE ─────────────────────────────────────────────────────────────
function resetNightUI() {
  state.nightUI = {
    selectedIds: [],
    seerinRevealed: false,
    witchShowKill: false,
    witchKillTarget: null,
    witchHealConfirmed: false,
    loversSelected: [],
    confirmed: false,
    editingRoleAssign: false,
  };
}

function nightGoBack() {
  const g = state.game;
  if (g.nightStepIndex === 0) return;

  const prevIdx = g.nightStepIndex - 1;
  const prevStep = g.nightSteps[prevIdx];

  // Undo action for the step we're going back to
  if (prevStep.id === 'amor') {
    if (g.loverIds) {
      g.players.forEach(p => { if (g.loverIds.includes(p.id)) { p.isLover = false; p.loverId = null; } });
      g.loverIds = null;
    }
  } else if (prevStep.id === 'hure') {
    g.nightActions.hureVisitingId = null;
  } else if (prevStep.id === 'seherin') {
    g.nightActions.seerinCheckedId = null;
    g.nightActions.seerinResult = null;
  } else if (prevStep.id === 'wolves-attack' || prevStep.id === 'wolves-reveal') {
    g.nightActions.wolfTargetId = null;
  } else if (prevStep.id === 'beschuetzer') {
    g.nightActions.beschuetzerProtectingId = null;
  } else if (prevStep.id === 'hexe') {
    if (g.nightActions.witchHealing) { g.witchState.healUsed = false; g.nightActions.witchHealing = false; }
    if (g.nightActions.witchKillingId) { g.witchState.killUsed = false; g.nightActions.witchKillingId = null; }
  }

  g.nightStepIndex = prevIdx;
  resetNightUI();
  saveActiveGame(g);
}

function toggleTestMode() {
  state.testMode = !state.testMode;
  showToast(state.testMode ? '🧪 Test-Modus AN — Spiele werden nicht gespeichert' : '✅ Test-Modus AUS', state.testMode ? 'info' : 'success', 3000);
}

// Auto-fill the current night step with a random valid selection
function autoFillStep() {
  const g = state.game;
  const step = currentStep();
  if (!step) return;
  const alive = alivePlayers(g);
  const rand = arr => arr[Math.floor(Math.random() * arr.length)];

  if (step.id === 'wolves-reveal') {
    const nonWolves = alive; // moderator picks, just select all wolves by role
    const wolves = g.players.filter(p => p.role === 'werwolf' && p.isAlive);
    state.nightUI.selectedIds = wolves.map(p => p.id);
  } else if (step.id === 'amor') {
    const shuffled = [...alive].sort(() => Math.random() - 0.5);
    state.nightUI.selectedIds = shuffled.slice(0, 2).map(p => p.id);
  } else if (step.id === 'hure') {
    const hure = g.players.find(p => p.role === 'hure' && p.isAlive);
    const candidates = alive.filter(p => p.role !== 'hure' && p.id !== g.hureState.lastVisitedId);
    if (candidates.length) state.nightUI.selectedIds = [rand(candidates).id];
  } else if (step.id === 'seherin') {
    const candidates = alive.filter(p => p.role !== 'seherin');
    if (candidates.length) {
      state.nightUI.selectedIds = [rand(candidates).id];
      doSeerinCheck();
    }
  } else if (step.id === 'wolves-attack') {
    const candidates = alive.filter(p => p.role !== 'werwolf');
    if (candidates.length) state.nightUI.selectedIds = [rand(candidates).id];
  } else if (step.id === 'beschuetzer') {
    const beschuetzer = g.players.find(p => p.role === 'beschuetzer' && p.isAlive);
    const candidates = alive.filter(p => p.role !== 'beschuetzer' && p.id !== g.beschuetzerState.lastProtectedId);
    if (candidates.length) state.nightUI.selectedIds = [rand(candidates).id];
  }
  // hexe: skip (no auto-fill, just confirm without potions)
}

function currentStep() {
  if (!state.game) return null;
  return state.game.nightSteps[state.game.nightStepIndex] || null;
}

function nightTogglePlayer(id) {
  const step = currentStep();
  if (!step) return;
  const idx = state.nightUI.selectedIds.indexOf(id);

  // For wolves-reveal: can select multiple (= wolf count)
  if (step.id === 'wolves-reveal') {
    if (idx >= 0) state.nightUI.selectedIds.splice(idx, 1);
    else state.nightUI.selectedIds.push(id);
    return;
  }
  // For amor: select exactly 2
  if (step.id === 'amor') {
    if (idx >= 0) {
      state.nightUI.selectedIds.splice(idx, 1);
    } else if (state.nightUI.selectedIds.length < 2) {
      state.nightUI.selectedIds.push(id);
    }
    return;
  }
  // Single select for most steps
  state.nightUI.selectedIds = idx >= 0 ? [] : [id];
}

function wolfCount() {
  // Always use the configured count — wolves-reveal is authoritative
  return state.game?.roleCounts?.werwolf || 0;
}

function nightCanConfirm() {
  const step = currentStep();
  if (!step) return false;
  const g = state.game;
  const sel = state.nightUI.selectedIds;

  // Generic: role must be assigned before any step can be confirmed (manual mode).
  // wolves-reveal is exempt — it IS the assignment step for wolves.
  const roleKnown = (roleId) =>
    !roleId || g.rolesAutoAssigned || g.players.some(p => p.role === roleId && p.isAlive);

  if (step.id !== 'wolves-reveal' && !roleKnown(step.role)) return false;

  // Step-specific action requirements
  if (step.id === 'wolves-reveal') return g.rolesAutoAssigned || sel.length === wolfCount();
  if (step.id === 'amor')          return sel.length === 2;
  if (step.id === 'hure')          return sel.length === 1;
  if (step.id === 'seherin')       return state.nightUI.seerinRevealed;
  if (step.id === 'wolves-attack') return sel.length === 1;
  if (step.id === 'beschuetzer')   return sel.length === 1;
  if (step.id === 'hexe')          return true;
  return false; // unknown future step → blocked until explicitly handled
}

function nightConfirm() {
  const g = state.game;
  const step = currentStep();
  if (!step) return;
  const sel = state.nightUI.selectedIds;

  if (step.id === 'wolves-reveal') {
    if (!g.rolesAutoAssigned) {
      // Manual mode: wolves-reveal is authoritative — clear old, assign fresh
      g.players.forEach(p => { if (p.role === 'werwolf') p.role = 'unknown'; });
      sel.forEach(id => { const p = playerById(id); if (p) p.role = 'werwolf'; });
    }
    // Auto-assign mode: roles already set, nothing to change
    g.nightActions.wolvesRevealed = true;
    g.log.push({ round: g.round, phase: 'night', action: 'wolves-reveal', desc: `Wölfe: ${sel.map(id => playerById(id)?.name).join(', ')}` });
  }

  if (step.id === 'amor') {
    g.loverIds = [...sel];
    g.players.forEach(p => {
      if (sel.includes(p.id)) {
        p.isLover = true;
        p.loverId = sel.find(id => id !== p.id);
      }
    });
    g.log.push({ round: g.round, phase: 'night', action: 'amor', desc: `Liebespaar: ${sel.map(id => playerById(id)?.name).join(' & ')}` });
  }

  if (step.id === 'hure') {
    g.nightActions.hureVisitingId = sel[0];
    g.hureState.currentVisitingId = sel[0];
    g.log.push({ round: g.round, phase: 'night', action: 'hure', desc: `Hure besucht ${playerById(sel[0])?.name}` });
  }

  if (step.id === 'seherin') {
    // result already stored in nightActions.seerinResult
  }

  if (step.id === 'wolves-attack') {
    g.nightActions.wolfTargetId = sel[0];
  }

  if (step.id === 'beschuetzer') {
    g.nightActions.beschuetzerProtectingId = sel[0];
    g.beschuetzerState.currentProtectingId = sel[0];
  }

  if (step.id === 'hexe') {
    if (state.nightUI.witchHealConfirmed) {
      g.nightActions.witchHealing = true;
      g.witchState.healUsed = true;
    }
    if (state.nightUI.witchKillTarget) {
      g.nightActions.witchKillingId = state.nightUI.witchKillTarget;
      g.witchState.killUsed = true;
    }
  }

  // Advance to next step — if no more steps remain, resolve the night
  g.nightStepIndex++;
  if (g.nightStepIndex >= g.nightSteps.length) {
    doNightResolve();
    return;
  }
  resetNightUI();
  saveActiveGame(g);
}

function doSeerinCheck() {
  const g = state.game;
  const sel = state.nightUI.selectedIds;
  if (sel.length !== 1) return;
  const target = playerById(sel[0]);
  const isWolf = target.role === 'werwolf';
  g.nightActions.seerinCheckedId = sel[0];
  g.nightActions.seerinResult = { playerId: sel[0], isWolf };
  state.nightUI.seerinRevealed = true;
  g.log.push({ round: g.round, phase: 'night', action: 'seherin', desc: `Seherin: ${target.name} ist ${isWolf ? 'ein Werwolf' : 'kein Werwolf'}` });
}

function doNightResolve() {
  const g = state.game;
  const deaths = resolveNight(g);

  // Check if Jaeger was killed by wolves
  const jaegerDeath = deaths.find(d => {
    const p = playerById(d.playerId);
    return p?.role === 'jaeger' && (d.cause === 'wolves' || d.cause === 'wolves-hure');
  });

  // Mark deaths on players
  for (const d of deaths) {
    const p = playerById(d.playerId);
    if (p) {
      p.isAlive = false;
      p.diedRound = g.round;
      p.diedPhase = 'night';
      p.diedCause = d.cause;
    }
  }

  // Also add heartbreak deaths now (lover died in the night)
  if (g.loverIds) {
    const deadIds = new Set(deaths.map(d => d.playerId));
    for (const d of [...deaths]) {
      if (g.loverIds.includes(d.playerId)) {
        const partnerId = g.loverIds.find(id => id !== d.playerId);
        if (partnerId && !deadIds.has(partnerId)) {
          const partner = playerById(partnerId);
          if (partner && partner.isAlive) {
            partner.isAlive = false;
            partner.diedRound = g.round;
            partner.diedPhase = 'day-heartbreak';
            partner.diedCause = 'heartbreak';
            deaths.push({ playerId: partnerId, cause: 'heartbreak' });
            deadIds.add(partnerId);
          }
        }
      }
    }
  }

  // Update hure/beschuetzer last-night state
  g.hureState.lastVisitedId = g.nightActions.hureVisitingId;
  g.beschuetzerState.lastProtectedId = g.nightActions.beschuetzerProtectingId;

  // Transition to night-log (moderator reviews deaths before announcing day)
  g.phase = 'night-log';
  g.dayState = {
    deaths,
    jaegerMustAct: !!jaegerDeath,
    jaegerActedPlayerId: null,
    voteResult: null,
  };

  // Init day UI (will be used when day actually starts)
  state.dayUI = {
    voteTarget: null,
    jagerTarget: null,
    hauptmannTarget: null,
    showDorfidiotReveal: false,
    showLoverDeath: null,
    dayPhase: 'deaths',
    jaegerSplash: false,
    loverSplash: null,
    loverDiedPartner: null,
    loverDiedBecause: null,
    loverDiedCause: null,
    pendingLoverDeath: null,
    voteRoleAssignId: null,
  };

  g.nightStepIndex = 0;
  g.nightSteps = [];
  resetNightUI();
  saveActiveGame(g);
}

function startDay() {
  const g = state.game;
  g.phase = 'day';

  // If Hauptmann died at night, clear title immediately
  if (g.hauptmannId) {
    const hauptmann = playerById(g.hauptmannId);
    if (!hauptmann?.isAlive) {
      if (hauptmann) hauptmann.isHauptmann = false;
      g.hauptmannId = null;
    }
  }

  // Jäger shoots BEFORE win condition — he may take the last wolf with him
  if (g.dayState.jaegerMustAct) {
    state.dayUI.dayPhase = 'jaeger';
    state.dayUI.jaegerSplash = true;
    saveActiveGame(g);
    return;
  }

  const win = checkWinCondition(g);
  if (win.over) { endGame(win); return; }

  if (!g.hauptmannId) {
    state.dayUI.dayPhase = 'hauptmann';
  } else {
    state.dayUI.dayPhase = 'vote';
  }
  saveActiveGame(g);
}

function deathCauseLabel(cause) {
  const map = {
    wolves:       '🐺 Von Werwölfen getötet',
    'wolves-hure':'💋 Hure war beim Angriffsopfer — beide sterben',
    witch:        '🧙‍♀️ Vergiftet durch die Hexe',
    heartbreak:   '💔 Liebespartner starb — starb vor Kummer',
    vote:         '🗳️ Durch Abstimmung ausgeschieden',
    jaeger:       '🏹 Vom Jäger mitgerissen',
  };
  return map[cause] || cause;
}

// ─── DAY PHASE ────────────────────────────────────────────────────────────────
function dayNights() {
  // Deaths to show (from night)
  return state.game?.dayState?.deaths || [];
}

function advanceDayPhase(next) {
  state.dayUI.dayPhase = next;
}

function dayConfirmDeaths() {
  const g = state.game;
  // Also kill love partners (heartbreak) - partner dies when deaths are announced
  if (g.loverIds) {
    const deadIds = new Set(g.dayState.deaths.map(d => d.playerId));
    for (const d of [...g.dayState.deaths]) {
      if (g.loverIds.includes(d.playerId)) {
        const partnerId = g.loverIds.find(id => id !== d.playerId);
        if (partnerId && !deadIds.has(partnerId)) {
          const partner = playerById(partnerId);
          if (partner && partner.isAlive) {
            partner.isAlive = false;
            partner.diedRound = g.round;
            partner.diedPhase = 'day-heartbreak';
            partner.diedCause = 'heartbreak';
            g.dayState.deaths.push({ playerId: partnerId, cause: 'heartbreak' });
            state.dayUI.showLoverDeath = partner;
          }
        }
      }
    }
  }

  const win = checkWinCondition(g);
  if (win.over) { endGame(win); return; }

  if (g.dayState.jaegerMustAct) {
    state.dayUI.dayPhase = 'jaeger';
    state.dayUI.jaegerSplash = true;
  } else if (!g.hauptmannId) {
    state.dayUI.dayPhase = 'hauptmann';
  } else {
    state.dayUI.dayPhase = 'vote';
  }
  saveActiveGame(g);
}

function confirmJaeger() {
  const g = state.game;
  const target = playerById(state.dayUI.jagerTarget);
  if (!target) return showToast('Kein Ziel ausgewählt', 'error');

  target.isAlive = false;
  target.diedRound = g.round;
  target.diedPhase = 'day';
  target.diedCause = 'jaeger';
  g.dayState.jaegerActedPlayerId = target.id;
  g.log.push({ round: g.round, phase: 'day', action: 'jaeger', desc: `Jäger reißt ${target.name} mit` });

  const win = checkWinCondition(g);
  if (win.over) { endGame(win); return; }

  if (!g.hauptmannId) {
    state.dayUI.dayPhase = 'hauptmann';
  } else {
    state.dayUI.dayPhase = 'vote';
  }
  saveActiveGame(g);
}

function confirmHauptmann(id) {
  const g = state.game;
  const player = playerById(id);
  if (!player) return;
  g.hauptmannId = id;
  player.isHauptmann = true;
  g.log.push({ round: g.round, phase: 'day', action: 'hauptmann', desc: `${player.name} wird Hauptmann` });
  state.dayUI.dayPhase = 'vote';
  saveActiveGame(g);
}

function randomHauptmann() {
  const alive = alivePlayers(state.game);
  const random = alive[Math.floor(Math.random() * alive.length)];
  state.game.hauptmannReveal = random;
  saveActiveGame(state.game);
}

function randomHauptmannInit() {
  const alive = state.game.players.filter(p => p.isAlive);
  const random = alive[Math.floor(Math.random() * alive.length)];
  state.game.hauptmannReveal = random;
  saveActiveGame(state.game);
}

function confirmHauptmannReveal() {
  const g = state.game;
  const p = g.hauptmannReveal;
  g.hauptmannReveal = null;
  if (g.phase === 'hauptmann-init') {
    confirmHauptmannInit(p?.id);
  } else {
    confirmHauptmann(p?.id);
  }
}

function confirmHauptmannInit(id) {
  const g = state.game;
  if (id) {
    const player = playerById(id);
    if (player) {
      g.hauptmannId = id;
      player.isHauptmann = true;
      g.log.push({ round: 0, phase: 'setup', action: 'hauptmann', desc: `${player.name} wird Hauptmann` });
    }
  }
  g.phase = 'night';
  saveActiveGame(g);
}

function afterVoteKill(g, target, targetId) {
  // Love partner instant death — check BEFORE hauptmann logic so it's never skipped
  let loverPartner = null;
  if (g.loverIds?.includes(targetId)) {
    const partnerId = g.loverIds.find(id => id !== targetId);
    const partner = playerById(partnerId);
    if (partner && partner.isAlive) {
      partner.isAlive = false;
      partner.diedRound = g.round;
      partner.diedPhase = 'day-heartbreak';
      partner.diedCause = 'heartbreak';
      g.log.push({ round: g.round, phase: 'day', action: 'heartbreak', desc: `${partner.name} stirbt vor Kummer` });
      loverPartner = partner;
    }
  }

  // Hauptmann nachfolger
  if (g.hauptmannId === targetId) {
    g.hauptmannId = null;
    target.isHauptmann = false;
    state.dayUI.pendingLoverDeath = loverPartner;
    state.dayUI.loverDiedBecause = loverPartner ? target.name : null;
    state.dayUI.loverDiedCause = loverPartner ? 'vote' : null;
    state.dayUI.dayPhase = 'hauptmann-successor';
    saveActiveGame(g);
    return;
  }

  // Show lover death splash
  if (loverPartner) {
    state.dayUI.dayPhase = 'lover-died';
    state.dayUI.loverDiedPartner = loverPartner;
    state.dayUI.loverDiedBecause = target.name;
    state.dayUI.loverDiedCause = 'vote';
    saveActiveGame(g);
    return;
  }

  const win = checkWinCondition(g);
  if (win.over) { endGame(win); return; }
  startNewNight();
}

function confirmVote() {
  const g = state.game;
  const targetId = state.dayUI.voteTarget;

  if (!targetId || targetId === 'none') {
    g.log.push({ round: g.round, phase: 'day', action: 'vote', desc: 'Keine Mehrheit — niemand ausgeschieden' });
    startNewNight();
    return;
  }

  const target = playerById(targetId);
  if (!target) return;

  // Check Dorfidiot (only if role already known)
  if (target.role === 'dorfidiot') {
    state.dayUI.showDorfidiotReveal = true;
    state.dayUI.dayPhase = 'dorfidiot';
    g.log.push({ round: g.round, phase: 'day', action: 'dorfidiot', desc: `${target.name} ist der Dorfidiot — bleibt im Spiel` });
    return;
  }

  // Kill target
  target.isAlive = false;
  target.diedRound = g.round;
  target.diedPhase = 'day';
  target.diedCause = 'vote';
  g.log.push({ round: g.round, phase: 'day', action: 'vote', desc: `${target.name} hingerichtet` });

  // If role unknown → mandatory role reveal before proceeding
  if (target.role === 'unknown' && !g.rolesAutoAssigned) {
    state.dayUI.dayPhase = 'vote-role-assign';
    state.dayUI.voteRoleAssignId = targetId;
    saveActiveGame(g);
    return;
  }

  afterVoteKill(g, target, targetId);
}

function continueAfterVoteRoleAssign() {
  const g = state.game;
  const targetId = state.dayUI.voteRoleAssignId;
  const target = playerById(targetId);
  state.dayUI.voteRoleAssignId = null;

  // If revealed as Dorfidiot → un-kill and show reveal
  if (target.role === 'dorfidiot') {
    target.isAlive = true;
    target.diedRound = null;
    target.diedPhase = null;
    target.diedCause = null;
    state.dayUI.showDorfidiotReveal = true;
    state.dayUI.dayPhase = 'dorfidiot';
    g.log.push({ round: g.round, phase: 'day', action: 'dorfidiot', desc: `${target.name} ist der Dorfidiot — bleibt im Spiel` });
    saveActiveGame(g);
    return;
  }

  afterVoteKill(g, target, targetId);
}

function continueAfterLoverDeath() {
  const g = state.game;
  state.dayUI.loverDiedPartner = null;
  const win = checkWinCondition(g);
  if (win.over) { endGame(win); return; }
  startNewNight();
}

function confirmHauptmannSuccessor(id) {
  const g = state.game;
  const player = playerById(id);
  if (!player) return;
  g.hauptmannId = id;
  player.isHauptmann = true;
  g.log.push({ round: g.round, phase: 'day', action: 'hauptmann', desc: `${player.name} wird neuer Hauptmann` });

  // Show pending lover death splash (voted person was also a lover)
  if (state.dayUI.pendingLoverDeath) {
    const partner = state.dayUI.pendingLoverDeath;
    state.dayUI.pendingLoverDeath = null;
    state.dayUI.dayPhase = 'lover-died';
    state.dayUI.loverDiedPartner = partner;
    saveActiveGame(g);
    return;
  }

  const win = checkWinCondition(g);
  if (win.over) { endGame(win); return; }
  startNewNight();
}

function startNewNight() {
  const g = state.game;
  g.round++;
  g.phase = 'night';
  g.nightStepIndex = 0;
  g.nightSteps = computeNightSteps(g, g.nightOrder);
  g.nightActions = emptyNightActions();
  g.dayState = null;
  state.dayUI = { voteTarget: null, jagerTarget: null, hauptmannTarget: null, showDorfidiotReveal: false, showLoverDeath: null, dayPhase: 'deaths', jaegerSplash: false, loverDiedPartner: null, loverDiedBecause: null, loverDiedCause: null, pendingLoverDeath: null, voteRoleAssignId: null };
  resetNightUI();
  saveActiveGame(g);
}

function endGame(win) {
  const g = state.game;
  g.winner = win.winnerTeam;
  g.winnerTeam = win.winnerTeam;
  g.endTime = Date.now();
  g.phase = 'over';
  g.isTest = state.testMode;

  if (!state.testMode) {
    const stats = buildGameStats(g);
    state.history.unshift(stats);
    saveHistory(state.history);
  }
  saveActiveGame(null);
  navigate('game');
}

function abandonGame() {
  saveActiveGame(null);
  state.game = null;
  navigate('home');
  showToast('Spiel beendet', 'info');
}

// ─── HISTORY MANAGEMENT ──────────────────────────────────────────────────────
function deleteGame(gameId) {
  state.history = state.history.filter(g => g.gameId !== gameId);
  if (state.historyDetail?.gameId === gameId) state.historyDetail = null;
  saveHistory(state.history);
  showToast('Spiel gelöscht', 'info');
}

function deleteAllHistory() {
  state.history = [];
  state.historyDetail = null;
  saveHistory(state.history);
  showToast('Alle Statistiken gelöscht', 'info');
}

// ─── BACKUP / EXPORT / IMPORT ────────────────────────────────────────────────
function manualExport() {
  exportToFile(
    state.savedPlayers,
    state.history,
    loadActiveGame(),
    loadSettings()
  );
  showToast('JSON-Export gestartet', 'success');
}

function doRestoreBackup(slotIdx) {
  if (!restoreBackup(slotIdx)) { showToast('Fehler beim Wiederherstellen', 'error'); return; }
  // Reload all state from localStorage
  state.savedPlayers = loadPlayers();
  state.history      = loadHistory();
  state.game         = loadActiveGame();
  const s = loadSettings();
  state.darkMode = s.darkMode !== false;
  state.nightOrder = s.nightOrder || [...DEFAULT_NIGHT_ORDER];
  applyTheme();
  showToast('Backup wiederhergestellt', 'success');
  navigate('home');
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      importFromFile(e.target.result);
      state.savedPlayers = loadPlayers();
      state.history      = loadHistory();
      state.game         = loadActiveGame();
      showToast('Import erfolgreich', 'success');
      navigate('home');
    } catch (err) {
      showToast('Ungültige Datei: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

// ─── VUE APP ──────────────────────────────────────────────────────────────────
const App = {
  setup() {
    function closeWhatsNew() { state.showWhatsNew = false; }
    return { state, ROLES, ROLE_ORDER, closeModal, closeWhatsNew };
  },
  template: `
    <div id="app">
      <!-- Toast -->
      <div v-if="state.toast" class="toast" :class="state.toast.type">{{ state.toast.msg }}</div>

      <!-- Modal -->
      <div v-if="state.modal" class="modal-overlay" @click.self="closeModal">
        <div class="modal">
          <div class="modal-handle"></div>
          <component :is="state.modal.component" v-bind="state.modal.props" />
        </div>
      </div>

      <!-- What's New Popup -->
      <div v-if="state.showWhatsNew" class="modal-overlay" @click.self="closeWhatsNew" style="z-index:99998">
        <div class="modal" style="max-height:80vh;overflow-y:auto">
          <div class="modal-handle"></div>
          <whats-new-modal @close="closeWhatsNew" />
        </div>
      </div>

      <!-- Main routing -->
      <home-screen v-if="state.screen === 'home'" />
      <setup-screen v-else-if="state.screen === 'setup'" />
      <game-screen v-else-if="state.screen === 'game'" />
      <stats-screen v-else-if="state.screen === 'stats'" />
      <history-screen v-else-if="state.screen === 'history'" />
      <players-screen v-else-if="state.screen === 'players'" />
      <backup-screen v-else-if="state.screen === 'backup'" />
      <changelog-screen v-else-if="state.screen === 'changelog'" />
    </div>
  `
};

// ─── HOME SCREEN ──────────────────────────────────────────────────────────────
const HomeScreen = {
  setup() {
    const hasActive = computed(() => state.game && state.game.phase !== 'over');
    const hasPlayers = computed(() => state.savedPlayers.length > 0);
    return { state, hasActive, hasPlayers, navigate, startSetup, startSetupWithReveal, toggleTheme, toggleTestMode, BUILD };
  },
  template: `
    <div class="screen screen-home">
      <div class="home-header">
        <div class="home-title">🐺 Werwolf</div>
        <div class="home-subtitle">Moderator</div>
        <div style="font-size:0.65rem;color:var(--text3);margin-top:6px;opacity:0.7">Version {{ BUILD }}</div>
      </div>
      <div class="home-menu">
        <div v-if="hasActive" class="home-menu-item resume" @click="navigate('game')">
          <span class="menu-icon">▶️</span>
          <div>
            <div class="menu-label">Spiel fortsetzen</div>
            <div class="menu-sub">Runde {{ state.game.round }} — {{ state.game.players.filter(p=>p.isAlive).length }} Spieler am Leben</div>
          </div>
        </div>

        <div class="home-menu-item primary" @click="hasPlayers ? startSetup() : navigate('players')">
          <span class="menu-icon">🎮</span>
          <div>
            <div class="menu-label">Neues Spiel</div>
            <div class="menu-sub" style="color:rgba(255,255,255,.7)">{{ hasPlayers ? 'Spieler & Rollen konfigurieren' : 'Erst Spieler anlegen' }}</div>
          </div>
        </div>

        <div class="home-menu-item" @click="hasPlayers ? startSetupWithReveal() : navigate('players')">
          <span class="menu-icon">🃏</span>
          <div>
            <div class="menu-label">Rollen per App verteilen</div>
            <div class="menu-sub">App verteilt Rollen — jeder schaut privat rein</div>
          </div>
        </div>

        <div class="home-menu-item" @click="navigate('players')">
          <span class="menu-icon">👥</span>
          <div>
            <div class="menu-label">Spieler verwalten</div>
            <div class="menu-sub">{{ state.savedPlayers.length }} Spieler gespeichert</div>
          </div>
        </div>

        <div class="home-menu-item" @click="navigate('stats')">
          <span class="menu-icon">📊</span>
          <div>
            <div class="menu-label">Statistiken</div>
            <div class="menu-sub">{{ state.history.length }} gespielte Runden</div>
          </div>
        </div>

        <div class="home-menu-item" @click="navigate('history')">
          <span class="menu-icon">📜</span>
          <div>
            <div class="menu-label">Spielverlauf</div>
            <div class="menu-sub">Vergangene Spiele anzeigen</div>
          </div>
        </div>


        <div class="home-menu-item" :style="state.testMode ? 'border-color:#f97316;background:rgba(249,115,22,0.1)' : ''" @click="toggleTestMode">
          <span class="menu-icon">🧪</span>
          <div>
            <div class="menu-label" :style="state.testMode ? 'color:#fb923c' : ''">
              Test-Modus {{ state.testMode ? 'AN' : 'AUS' }}
            </div>
            <div class="menu-sub">{{ state.testMode ? 'Spiele werden NICHT gespeichert' : 'Aktivieren zum Testen ohne Statistik' }}</div>
          </div>
          <div v-if="state.testMode" style="width:10px;height:10px;border-radius:50%;background:#f97316;box-shadow:0 0 8px #f97316;flex-shrink:0"></div>
        </div>

        <div class="home-menu-item" @click="navigate('backup')">
          <span class="menu-icon">💾</span>
          <div>
            <div class="menu-label">Datensicherung</div>
            <div class="menu-sub">Export, Import &amp; Auto-Backups</div>
          </div>
        </div>

        <div class="home-menu-item" @click="navigate('changelog')">
          <span class="menu-icon">📋</span>
          <div>
            <div class="menu-label">Changelog</div>
            <div class="menu-sub">Was ist neu in Version {{ BUILD }}</div>
          </div>
        </div>
      </div>
    </div>
  `
};

// ─── SETUP SCREEN ─────────────────────────────────────────────────────────────
const SetupScreen = {
  setup() {
    const sel = computed(() => state.setup.selectedPlayerIds);
    const dorf = computed(() => setupDorfbewohner());
    const total = computed(() => setupSelectedCount());
    const rolesTotal = computed(() => setupTotalRoles());
    const canAdd = computed(() => {
      const n = state.setup.newPlayerName.trim();
      return n.length > 0 && !state.savedPlayers.find(p => p.name.toLowerCase() === n.toLowerCase());
    });

    function addAndSelect() {
      const name = state.setup.newPlayerName.trim();
      if (!name) return;
      addPlayer(name);
      const newP = state.savedPlayers[state.savedPlayers.length - 1];
      if (newP && !sel.value.includes(newP.id)) sel.value.push(newP.id);
      state.setup.newPlayerName = '';
    }

    // Night order helpers — only show roles that have a night action
    const NIGHT_ORDER_META = {
      hure:        { label: 'Hure',        icon: '💋' },
      seherin:     { label: 'Seherin',     icon: '🔮' },
      werwolf:     { label: 'Werwölfe (Angriff)', icon: '🐺' },
      beschuetzer: { label: 'Beschützer',  icon: '🛡️' },
      hexe:        { label: 'Hexe',        icon: '🧙‍♀️' },
    };

    function nightOrderLabel(key) { return NIGHT_ORDER_META[key]?.label || key; }
    function nightOrderIcon(key)  { return NIGHT_ORDER_META[key]?.icon  || '?'; }

    function nightOrderMove(idx, dir) {
      const arr = state.setup.nightOrder;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= arr.length) return;
      const tmp = arr[idx];
      arr[idx] = arr[newIdx];
      arr[newIdx] = tmp;
    }

    return {
      state, ROLES, ROLE_ORDER, sel, dorf, total, rolesTotal, canAdd,
      navigate, setupTogglePlayer, setupNextStep, setupPrevStep,
      setupIncrRole, setupDecrRole, launchGame, addAndSelect,
      nightOrderLabel, nightOrderIcon, nightOrderMove,
      roleName, roleIcon
    };
  },
  template: `
    <div class="page">
      <div class="nav">
        <button class="nav-btn" @click="navigate('home')">←</button>
        <span class="nav-title">Neues Spiel</span>
        <span style="width:44px"></span>
      </div>
      <div class="screen">
        <!-- Step indicator -->
        <div class="setup-steps">
          <div v-for="(s,i) in ['Spieler','Rollen','Start']" :key="i"
               :class="['setup-step', state.setup.step === i+1 ? 'active' : '', state.setup.step > i+1 ? 'done' : '']">
            <div class="step-dot">{{ state.setup.step > i+1 ? '✓' : i+1 }}</div>
            <div class="step-label">{{ s }}</div>
          </div>
        </div>

        <!-- STEP 1: Players -->
        <div v-if="state.setup.step === 1">
          <div class="card-title">Spieler auswählen ({{ sel.length }} / {{ state.savedPlayers.length }})</div>
          <div class="player-list">
            <div v-for="p in state.savedPlayers" :key="p.id"
                 :class="['player-item', sel.includes(p.id) ? 'selected' : '']"
                 @click="setupTogglePlayer(p.id)">
              <div class="player-toggle">{{ sel.includes(p.id) ? '✓' : '' }}</div>
              <span class="player-name">{{ p.name }}</span>
            </div>
          </div>

          <div class="section-title" style="margin-top:20px">Neuen Spieler hinzufügen</div>
          <div style="display:flex;gap:8px">
            <input class="input" style="flex:1" placeholder="Name eingeben…"
                   v-model="state.setup.newPlayerName"
                   @keyup.enter="addAndSelect" />
            <button class="btn btn-primary" :disabled="!canAdd" @click="addAndSelect">+</button>
          </div>

          <div class="mt-4">
            <button class="btn btn-primary btn-full btn-lg" @click="setupNextStep"
                    :disabled="sel.length < 4">
              Weiter → Rollen ({{ sel.length }} Spieler)
            </button>
          </div>
        </div>

        <!-- STEP 2: Roles -->
        <div v-if="state.setup.step === 2">
          <div class="card-title">Karten konfigurieren</div>

          <!-- Role summary bar -->
          <div class="role-summary mb-3">
            <span class="role-badge">
              👥 {{ total }} Spieler
            </span>
            <span class="role-badge" :style="rolesTotal > total ? 'border-color:var(--red);color:#fca5a5' : ''">
              🃏 {{ rolesTotal + dorf }} / {{ total }} Karten
            </span>
            <span class="role-badge" v-if="dorf > 0">
              👤 × {{ dorf }} Dorfbewohner
            </span>
          </div>

          <div class="role-config">
            <div v-for="roleId in ROLE_ORDER.filter(r => r !== 'dorfbewohner')" :key="roleId"
                 class="role-row">
              <span class="role-icon">{{ ROLES[roleId].icon }}</span>
              <div class="role-info">
                <div class="role-name">{{ ROLES[roleId].name }}</div>
                <div class="role-desc">{{ ROLES[roleId].description }}</div>
              </div>
              <div class="counter">
                <button class="counter-btn" @click="setupDecrRole(roleId)"
                        :disabled="state.setup.roleCounts[roleId] === 0">−</button>
                <span class="counter-val">{{ state.setup.roleCounts[roleId] }}</span>
                <button class="counter-btn" @click="setupIncrRole(roleId)">+</button>
              </div>
            </div>
          </div>

          <div class="section-title">Hauptmann-Wahl</div>
          <div style="display:flex;gap:8px;margin-bottom:16px">
            <button :class="['btn btn-full', state.setup.hauptmannMethod==='vote' ? 'btn-primary' : 'btn-secondary']"
                    @click="state.setup.hauptmannMethod='vote'">🗳 Abstimmung</button>
            <button :class="['btn btn-full', state.setup.hauptmannMethod==='random' ? 'btn-primary' : 'btn-secondary']"
                    @click="state.setup.hauptmannMethod='random'">🎲 Zufällig</button>
          </div>

          <div class="section-title">Nachtreihenfolge</div>
          <div style="font-size:0.78rem;color:var(--text3);margin-bottom:10px">
            Reihenfolge in der Nacht (Werwölfe-Enthüllung &amp; Amor immer zuerst in Nacht 1).
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
            <div v-for="(roleKey, idx) in state.setup.nightOrder" :key="roleKey"
                 style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm)">
              <span style="font-size:0.75rem;color:var(--text3);min-width:20px;font-weight:700">{{ idx + 1 }}</span>
              <span style="font-size:1.3rem">{{ nightOrderIcon(roleKey) }}</span>
              <span style="flex:1;font-weight:600;font-size:0.9rem">{{ nightOrderLabel(roleKey) }}</span>
              <div style="display:flex;gap:4px">
                <button class="counter-btn" :disabled="idx === 0" @click="nightOrderMove(idx, -1)">↑</button>
                <button class="counter-btn" :disabled="idx === state.setup.nightOrder.length - 1" @click="nightOrderMove(idx, 1)">↓</button>
              </div>
            </div>
          </div>

          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary btn-full" @click="setupPrevStep">← Zurück</button>
            <button class="btn btn-primary btn-full" @click="setupNextStep"
                    :disabled="state.setup.roleCounts.werwolf < 1">
              Weiter →
            </button>
          </div>
        </div>

        <!-- STEP 3: Confirm + launch -->
        <div v-if="state.setup.step === 3">
          <div class="card-title">Spielübersicht</div>

          <div class="card mb-3">
            <div class="section-title">Spieler ({{ total }})</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              <span v-for="id in state.setup.selectedPlayerIds" :key="id" class="pill">
                {{ state.savedPlayers.find(p=>p.id===id)?.name }}
              </span>
            </div>
          </div>

          <div class="card mb-3">
            <div class="section-title">Karten</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              <template v-for="roleId in ROLE_ORDER" :key="roleId">
                <span v-if="roleId !== 'dorfbewohner' && state.setup.roleCounts[roleId] > 0" class="role-badge">
                  {{ ROLES[roleId].icon }} {{ ROLES[roleId].name }}
                  <span v-if="state.setup.roleCounts[roleId] > 1">× {{ state.setup.roleCounts[roleId] }}</span>
                </span>
              </template>
              <span v-if="dorf > 0" class="role-badge">👤 Dorfbewohner × {{ dorf }}</span>
            </div>
          </div>

          <div class="card mb-3" style="font-size:0.9rem">
            <span>👑 Hauptmann: </span>
            <strong>{{ state.setup.hauptmannMethod === 'random' ? 'Zufällig' : 'Abstimmung' }}</strong>
          </div>

          <div style="background:rgba(124,58,237,0.1);border:1px solid var(--accent);border-radius:var(--radius-sm);padding:12px;font-size:0.82rem;color:var(--text2);margin-bottom:16px">
            ⚠️ Die Rollen werden den Spielern <strong>zufällig</strong> zugeteilt. Nur du als Moderator siehst sie.
          </div>

          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" @click="setupPrevStep">← Zurück</button>
            <button class="btn btn-primary btn-full btn-lg" @click="launchGame">
              🎮 Spiel starten!
            </button>
          </div>
        </div>
      </div>
    </div>
  `
};

// ─── GAME SCREEN ──────────────────────────────────────────────────────────────
const GameScreen = {
  setup() {
    const g = computed(() => state.game);
    const step = computed(() => currentStep());
    const alive = computed(() => g.value ? alivePlayers(g.value) : []);

    function hureCanVisit(pid) {
      // Can't visit same person as last night
      return pid !== g.value?.hureState?.lastVisitedId;
    }

    function beschuetzerCanProtect(pid) {
      const p = playerById(pid);
      if (!p) return false;
      if (p.role === 'beschuetzer') return false; // can't protect himself
      return pid !== g.value?.beschuetzerState?.lastProtectedId;
    }

    function wolfCanTarget(pid) {
      const p = playerById(pid);
      return p && p.role !== 'werwolf'; // wolves can't target themselves
    }

    function loverPair() {
      if (!g.value?.loverIds) return null;
      return g.value.loverIds.map(id => playerById(id)).filter(Boolean);
    }

    // True when wolves attacked the hure at home but she's away visiting → attack nullified
    const wolfAttackNullified = computed(() => {
      const game = g.value;
      if (!game) return false;
      const wolfTargetId = game.nightActions.wolfTargetId;
      const hureVisitingId = game.nightActions.hureVisitingId;
      if (!wolfTargetId || !hureVisitingId) return false;
      const hure = game.players.find(p => p.role === 'hure' && p.isAlive);
      return hure && hure.id === wolfTargetId;
    });

    // True when Beschützer protected the wolf's target → target survives, no heal needed
    const beschuetzerSaved = computed(() => {
      const game = g.value;
      if (!game) return false;
      const wolfTargetId = game.nightActions.wolfTargetId;
      const protectedId  = game.nightActions.beschuetzerProtectingId;
      return !!(wolfTargetId && protectedId && wolfTargetId === protectedId);
    });

    return {
      state, g, step, alive, ROLES,
      currentStep, nightTogglePlayer, nightCanConfirm, nightConfirm,
      doSeerinCheck, playerById, wolfCount, roleName, roleIcon,
      hureCanVisit, beschuetzerCanProtect, wolfCanTarget, loverPair,
      wolfAttackNullified, beschuetzerSaved,
      autoFillStep, toggleTestMode, nightGoBack,
      showCurrentRole, advanceRoleReveal,
      assignRole, toggleRoleAssign,
      startDay, deathCauseLabel,
      dayNights, advanceDayPhase, confirmJaeger,
      confirmHauptmann, randomHauptmann, randomHauptmannInit, confirmHauptmannReveal, confirmHauptmannInit, confirmVote, confirmHauptmannSuccessor,
      continueAfterLoverDeath, continueAfterVoteRoleAssign,
      startNewNight, abandonGame, navigate, openModal,
      formatDate, teamLabel
    };
  },
  template: `
    <div class="page">
      <div class="nav">
        <button class="nav-btn" @click="navigate('home')">🏠</button>
        <span class="nav-title" style="font-size:0.9rem">
          {{ g?.phase === 'over' ? '🏁 Spiel beendet' : g?.phase === 'role-reveal' ? '🃏 Rollenverteilung' : g?.phase === 'hauptmann-init' ? '👑 Hauptmann' : g?.phase === 'night-log' ? '📋 Nacht ' + g?.round : (g?.phase === 'night' ? '🌙 Nacht ' : '☀️ Tag ') }}{{ (g?.phase === 'night' || g?.phase === 'day') ? g?.round : '' }}
        </span>
        <button class="btn btn-sm btn-secondary" style="color:var(--red);font-size:0.75rem;padding:4px 10px" @click="confirmAbandon">Beenden</button>
      </div>

      <!-- Test-Mode Banner -->
      <div v-if="state.testMode" style="background:#7c2d12;border-bottom:1px solid #f97316;padding:6px 16px;display:flex;align-items:center;gap:8px;font-size:0.8rem;font-weight:700;color:#fb923c;flex-shrink:0">
        <span>🧪</span>
        <span>TEST-MODUS — Ergebnisse werden nicht gespeichert</span>
      </div>

      <div class="screen" v-if="g">
        <!-- ROLE REVEAL (pass-phone mode) -->
        <div v-if="g.phase === 'role-reveal'">
          <div class="day-header">
            <div class="day-icon">🃏</div>
            <div class="day-title">Rollenverteilung</div>
            <div class="day-subtitle">Jeder schaut seine Rolle privat an</div>
          </div>
          <div class="card" style="text-align:center;padding:32px 24px;margin-top:8px">
            <div v-if="!g.roleRevealShown">
              <div style="font-size:0.85rem;color:var(--text2);margin-bottom:12px">Gib das Handy weiter an:</div>
              <div style="font-size:1.6rem;font-weight:700;margin-bottom:20px">{{ g.players[g.roleRevealIndex]?.name }}</div>
              <div style="font-size:0.8rem;color:var(--text3);margin-bottom:20px">Halte das Display verdeckt, bis du alleine schaust.</div>
              <button class="btn btn-primary btn-full btn-lg" @click="showCurrentRole">🃏 Meine Rolle anzeigen</button>
            </div>
            <div v-else>
              <div style="font-size:0.82rem;color:var(--text2);margin-bottom:8px">{{ g.players[g.roleRevealIndex]?.name }}, deine Rolle:</div>
              <div style="font-size:4rem;margin-bottom:8px">{{ ROLES[g.players[g.roleRevealIndex]?.role]?.icon }}</div>
              <div style="font-size:1.4rem;font-weight:700;margin-bottom:6px">{{ ROLES[g.players[g.roleRevealIndex]?.role]?.name }}</div>
              <div style="font-size:0.82rem;color:var(--text2);margin-bottom:24px">{{ ROLES[g.players[g.roleRevealIndex]?.role]?.description }}</div>
              <button class="btn btn-primary btn-full btn-lg" @click="advanceRoleReveal">
                {{ g.roleRevealIndex + 1 < g.players.length ? 'Verstanden → Weiter' : '▶️ Alle gesehen — Spiel beginnen' }}
              </button>
            </div>
          </div>
          <div style="text-align:center;margin-top:14px;font-size:0.78rem;color:var(--text3)">
            Spieler {{ g.roleRevealIndex + 1 }} von {{ g.players.length }}
          </div>
          <div style="display:flex;justify-content:center;gap:6px;margin-top:10px">
            <span v-for="(p, i) in g.players" :key="p.id"
                  :style="{ width:'8px', height:'8px', borderRadius:'50%', display:'inline-block',
                    background: i < g.roleRevealIndex ? 'var(--green)' : i === g.roleRevealIndex ? 'var(--accent)' : 'var(--bg3)',
                    border: '1px solid var(--border)' }">
            </span>
          </div>
        </div>

        <!-- Hauptmann Reveal Splash (zufällige Auswahl) -->
        <div v-if="g.hauptmannReveal" class="jaeger-splash" @click="null">
          <div class="jaeger-splash-inner">
            <div style="font-size:5rem;line-height:1">👑</div>
            <div class="jaeger-splash-title" style="color:var(--gold)">{{ g.hauptmannReveal.name }}</div>
            <div class="jaeger-splash-desc">wurde per Los zum Hauptmann bestimmt!</div>
            <button class="btn btn-gold btn-full btn-lg" style="margin-top:32px;max-width:280px"
                    @click="confirmHauptmannReveal">
              👑 Bestätigen
            </button>
          </div>
        </div>

        <!-- HAUPTMANN INIT (before first night) -->
        <div v-if="g.phase === 'hauptmann-init'">
          <div class="day-header">
            <div class="day-icon">👑</div>
            <div class="day-title">Hauptmann wählen</div>
            <div class="day-subtitle">Vor der ersten Nacht — {{ g.hauptmannMethod === 'random' ? 'Zufällige Auswahl' : 'Das Dorf wählt seinen Hauptmann' }}</div>
          </div>
          <div v-if="g.hauptmannMethod === 'random'">
            <button class="btn btn-gold btn-full btn-lg mt-3" @click="randomHauptmannInit">
              🎲 Zufällig auslosen
            </button>
          </div>
          <div v-else>
            <div class="night-instruction mt-2">Tippe auf den gewählten Hauptmann:</div>
            <div class="player-grid mt-3">
              <div v-for="p in g.players.filter(p=>p.isAlive)" :key="p.id"
                   :class="['player-chip', state.dayUI.hauptmannTarget === p.id ? 'selected' : '']"
                   @click="state.dayUI.hauptmannTarget = p.id">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
              </div>
            </div>
            <button class="btn btn-gold btn-full btn-lg mt-4" :disabled="!state.dayUI.hauptmannTarget"
                    @click="confirmHauptmannInit(state.dayUI.hauptmannTarget)">
              👑 Als Hauptmann bestätigen
            </button>
          </div>
        </div>

        <!-- ROLE ASSIGN (before first night) -->
        <!-- GAME OVER -->
        <div v-if="g.phase === 'over'" class="game-over">
          <div class="go-icon">
            {{ g.winnerTeam === 'wolves' ? '🐺' : g.winnerTeam === 'lovers' ? '💑' : '🏘️' }}
          </div>
          <div class="go-title">Spiel vorbei!</div>
          <div class="go-subtitle">Runde {{ g.round }} · {{ formatDate(g.startTime) }}</div>
          <div v-if="g.isTest" style="display:inline-flex;align-items:center;gap:6px;background:rgba(249,115,22,0.15);border:1px solid #f97316;border-radius:99px;padding:4px 14px;font-size:0.8rem;font-weight:700;color:#fb923c;margin-bottom:12px">
            🧪 Test-Spiel — nicht in Statistik gespeichert
          </div>
          <div :class="['go-team', g.winnerTeam]">
            {{ g.winnerTeam === 'wolves' ? '🐺 Werwölfe gewinnen!' : g.winnerTeam === 'lovers' ? '💑 Liebespaar gewinnt!' : '🏘️ Dorf gewinnt!' }}
          </div>

          <!-- Assign remaining unknown roles before showing results -->
          <div v-if="g.players.some(p => p.role === 'unknown')" class="card mb-3" style="border-color:var(--gold)">
            <div style="font-size:0.85rem;font-weight:700;margin-bottom:10px">⚠️ Noch unbekannte Rollen — bitte eintragen:</div>
            <div v-for="p in g.players.filter(p => p.role === 'unknown')" :key="p.id" style="margin-bottom:10px">
              <div style="font-size:0.85rem;font-weight:600;margin-bottom:6px">{{ p.name }}</div>
              <div style="display:flex;flex-wrap:wrap;gap:5px">
                <template v-for="rid in ['werwolf','seherin','hexe','jaeger','hure','amor','beschuetzer','dorfidiot','dorfbewohner']" :key="rid">
                  <button v-if="(g.roleCounts[rid] > 0 && g.players.filter(pl => pl.role === rid).length < g.roleCounts[rid]) || rid === 'dorfbewohner'"
                          class="btn btn-secondary btn-sm" style="font-size:0.78rem;padding:5px 9px"
                          @click="assignRole(p.id, rid)">
                    {{ ROLES[rid]?.icon }} {{ ROLES[rid]?.name }}
                  </button>
                </template>
              </div>
            </div>
          </div>

          <div class="section-title">Alle Rollen</div>
          <div class="role-reveal-grid">
            <div v-for="p in g.players" :key="p.id"
                 :class="['role-reveal-item', !p.isAlive ? 'dead' : '', (g.winnerTeam==='wolves' && p.role==='werwolf') || (g.winnerTeam==='village' && p.role!=='werwolf') || (g.winnerTeam==='lovers' && p.isLover) ? 'winner' : '']">
              <div style="font-size:1.5rem">{{ ROLES[p.role]?.icon }}</div>
              <div style="font-weight:700;font-size:0.85rem;margin-top:4px">{{ p.name }}</div>
              <div style="font-size:0.72rem;color:var(--text2)">{{ ROLES[p.role]?.name }}</div>
              <div v-if="!p.isAlive" style="font-size:0.65rem;color:var(--red);margin-top:2px">† Runde {{ p.diedRound }}</div>
              <div v-if="p.isHauptmann" style="font-size:0.7rem;color:var(--gold)">👑 Hauptmann</div>
              <div v-if="p.isLover" style="font-size:0.7rem;color:var(--pink)">💋 Liebespaar</div>
            </div>
          </div>

          <div class="mt-4" style="display:flex;flex-direction:column;gap:10px">
            <button class="btn btn-primary btn-full btn-lg" @click="navigate('stats')">📊 Statistiken</button>
            <button class="btn btn-secondary btn-full" @click="startNewGameAfter">🎮 Neues Spiel</button>
            <button class="btn btn-secondary btn-full" @click="navigate('home')">🏠 Startseite</button>
          </div>
        </div>

        <!-- NIGHT PHASE -->
        <div v-else-if="g.phase === 'night'">
          <!-- Progress dots -->
          <div class="step-progress">
            <div v-for="(s, i) in g.nightSteps" :key="i"
                 :class="['step-dot-prog', i === g.nightStepIndex ? 'active' : '', i < g.nightStepIndex ? 'done' : '']">
            </div>
          </div>

          <div class="night-header">
            <div class="night-round">Runde {{ g.round }} · Nacht</div>
            <div class="night-step-icon">{{ step?.icon }}</div>
            <div class="night-step-title">{{ step?.label }}</div>
          </div>

          <!-- STEP: wolves-reveal -->
          <div v-if="step?.id === 'wolves-reveal'">
            <!-- Auto-assign mode: roles already known, just show wolves -->
            <div v-if="g.rolesAutoAssigned" class="card mt-3" style="border-color:var(--red);background:rgba(220,38,38,0.08)">
              <div style="font-size:0.82rem;color:var(--text2);margin-bottom:8px">🐺 Werwölfe (bereits bekannt):</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px">
                <span v-for="p in g.players.filter(p=>p.role==='werwolf'&&p.isAlive)" :key="p.id"
                      class="pill" style="border-color:var(--red);color:#fca5a5">
                  {{ p.name }}
                </span>
              </div>
            </div>
            <!-- Manual mode: select wolves -->
            <div v-else>
              <div class="night-instruction">Alle Spieler schließen die Augen. Werwölfe, öffnet die Augen und schaut euch an. Tippe alle Werwölfe an:</div>
              <div class="player-grid mt-3">
                <div v-for="p in alive" :key="p.id"
                     :class="['player-chip',
                       state.nightUI.selectedIds.includes(p.id) ? 'wolf-selected' : '',
                       state.nightUI.selectedIds.length >= wolfCount() && !state.nightUI.selectedIds.includes(p.id) ? 'disabled-choice' : '']"
                     @click="nightTogglePlayer(p.id)">
                  <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                  <span class="chip-name">{{ p.name }}</span>
                </div>
              </div>
              <div class="night-instruction mt-3" style="color:var(--text3)">
                {{ state.nightUI.selectedIds.length }} / {{ wolfCount() }} Werwölfe ausgewählt
              </div>
            </div>
          </div>

          <!-- STEP: amor -->
          <div v-if="step?.id === 'amor'">
            <!-- Role identity header -->
            <div v-if="(!g.players.some(p=>p.role==='amor'&&p.isAlive) || state.nightUI.editingRoleAssign) && !g.rolesAutoAssigned"
                 class="role-id-banner mb-3">
              <div class="role-id-label">💘 Wer ist Amor?</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
                <div v-for="p in alive.filter(p=>p.role==='unknown'||p.role==='amor')" :key="p.id"
                     :class="['player-chip', p.role==='amor'?'selected':'']"
                     style="min-width:68px;padding:8px 6px"
                     @click="toggleRoleAssign(p.id,'amor')">
                  <span class="chip-icon" style="font-size:1rem">{{ p.role==='amor'?'💘':'👤' }}</span>
                  <span class="chip-name" style="font-size:0.72rem">{{ p.name }}</span>
                </div>
              </div>
            </div>
            <div v-else-if="!g.rolesAutoAssigned" class="role-id-set mb-3">
              <span>💘 Amor: <strong>{{ g.players.find(p=>p.role==='amor'&&p.isAlive)?.name }}</strong></span>
              <button class="btn btn-sm btn-secondary" style="padding:3px 8px;font-size:0.72rem"
                      @click="state.nightUI.editingRoleAssign=true">✏️</button>
            </div>
            <div class="night-instruction">Wähle zwei Personen, die sich verlieben:</div>
            <div class="player-grid mt-3">
              <div v-for="p in alive" :key="p.id"
                   :class="['player-chip', state.nightUI.selectedIds.includes(p.id)?'selected':'', state.nightUI.selectedIds.length>=2&&!state.nightUI.selectedIds.includes(p.id)?'disabled-choice':'']"
                   @click="nightTogglePlayer(p.id)">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
              </div>
            </div>
            <div v-if="state.nightUI.selectedIds.length===2" class="seer-result village mt-3">
              💑 {{ state.nightUI.selectedIds.map(id=>playerById(id)?.name).join(' & ') }} sind verliebt
            </div>
          </div>

          <!-- STEP: hure -->
          <div v-if="step?.id === 'hure'">
            <!-- Role identity header -->
            <div v-if="(!g.players.some(p=>p.role==='hure'&&p.isAlive) || state.nightUI.editingRoleAssign) && !g.rolesAutoAssigned"
                 class="role-id-banner mb-3">
              <div class="role-id-label">💋 Wer ist die Hure?</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
                <div v-for="p in alive.filter(p=>p.role==='unknown'||p.role==='hure')" :key="p.id"
                     :class="['player-chip', p.role==='hure'?'selected':'']"
                     style="min-width:68px;padding:8px 6px"
                     @click="toggleRoleAssign(p.id,'hure')">
                  <span class="chip-icon" style="font-size:1rem">{{ p.role==='hure'?'💋':'👤' }}</span>
                  <span class="chip-name" style="font-size:0.72rem">{{ p.name }}</span>
                </div>
              </div>
            </div>
            <div v-else-if="!g.rolesAutoAssigned" class="role-id-set mb-3">
              <span>💋 Hure: <strong>{{ g.players.find(p=>p.role==='hure'&&p.isAlive)?.name }}</strong></span>
              <button class="btn btn-sm btn-secondary" style="padding:3px 8px;font-size:0.72rem"
                      @click="state.nightUI.editingRoleAssign=true">✏️</button>
            </div>
            <div class="night-instruction">Wähle eine Person, bei der die Hure übernachtet:</div>
            <div class="player-grid mt-3">
              <div v-for="p in alive.filter(p=>p.role!=='hure')" :key="p.id"
                   :class="['player-chip', state.nightUI.selectedIds.includes(p.id)?'selected':'', !hureCanVisit(p.id)?'disabled-choice':'']"
                   @click="hureCanVisit(p.id)&&nightTogglePlayer(p.id)">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
                <span v-if="!hureCanVisit(p.id)" style="font-size:0.65rem;color:var(--text3)">letzte Nacht</span>
              </div>
            </div>
          </div>

          <!-- STEP: seherin -->
          <div v-if="step?.id === 'seherin'">
            <!-- Role identity header -->
            <div v-if="(!g.players.some(p=>p.role==='seherin'&&p.isAlive) || state.nightUI.editingRoleAssign) && !g.rolesAutoAssigned"
                 class="role-id-banner mb-3">
              <div class="role-id-label">🔮 Wer ist die Seherin?</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
                <div v-for="p in alive.filter(p=>p.role==='unknown'||p.role==='seherin')" :key="p.id"
                     :class="['player-chip', p.role==='seherin'?'selected':'']"
                     style="min-width:68px;padding:8px 6px"
                     @click="toggleRoleAssign(p.id,'seherin')">
                  <span class="chip-icon" style="font-size:1rem">{{ p.role==='seherin'?'🔮':'👤' }}</span>
                  <span class="chip-name" style="font-size:0.72rem">{{ p.name }}</span>
                </div>
              </div>
            </div>
            <div v-else-if="!g.rolesAutoAssigned" class="role-id-set mb-3">
              <span>🔮 Seherin: <strong>{{ g.players.find(p=>p.role==='seherin'&&p.isAlive)?.name }}</strong></span>
              <button class="btn btn-sm btn-secondary" style="padding:3px 8px;font-size:0.72rem"
                      @click="state.nightUI.editingRoleAssign=true">✏️</button>
            </div>
            <div class="night-instruction">Wähle eine Person, deren Identität die Seherin prüft:</div>
            <div v-if="!state.nightUI.seerinRevealed" class="player-grid mt-3">
              <div v-for="p in alive.filter(p=>p.role!=='seherin')" :key="p.id"
                   :class="['player-chip', state.nightUI.selectedIds.includes(p.id)?'selected':'']"
                   @click="nightTogglePlayer(p.id)">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
              </div>
            </div>
            <button v-if="state.nightUI.selectedIds.length===1&&!state.nightUI.seerinRevealed"
                    class="btn btn-primary btn-full mt-3" @click="doSeerinCheck">
              🔮 Ergebnis zeigen
            </button>
            <div v-if="state.nightUI.seerinRevealed&&g.nightActions.seerinResult" class="mt-3">
              <div :class="['seer-result', g.nightActions.seerinResult.isWolf?'wolf':'village']">
                {{ g.nightActions.seerinResult.isWolf ? '🐺 WERWOLF!' : '✅ Kein Werwolf' }}
                <div style="font-size:0.85rem;margin-top:4px;opacity:0.8">
                  {{ playerById(g.nightActions.seerinResult.playerId)?.name }}
                </div>
              </div>
            </div>
          </div>

          <!-- STEP: wolves-attack -->
          <div v-if="step?.id === 'wolves-attack'">
            <!-- Show known wolves -->
            <div class="role-id-set mb-3" style="flex-wrap:wrap;gap:6px">
              <span style="flex-shrink:0">🐺 Wölfe:</span>
              <span v-for="p in g.players.filter(p=>p.role==='werwolf'&&p.isAlive)" :key="p.id"
                    style="font-weight:700">{{ p.name }}</span>
            </div>
            <div class="night-instruction">Werwölfe, einigt euch auf ein Opfer:</div>
            <div class="player-grid mt-3">
              <div v-for="p in alive.filter(p=>wolfCanTarget(p.id))" :key="p.id"
                   :class="['player-chip', state.nightUI.selectedIds.includes(p.id)?'wolf-selected':'']"
                   @click="nightTogglePlayer(p.id)">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
                <div class="chip-badges">
                  <span v-if="p.isHauptmann" class="chip-badge">👑</span>
                  <span v-if="p.isLover" class="chip-badge">💋</span>
                </div>
              </div>
            </div>
          </div>

          <!-- STEP: beschuetzer -->
          <div v-if="step?.id === 'beschuetzer'">
            <!-- Role identity header -->
            <div v-if="(!g.players.some(p=>p.role==='beschuetzer'&&p.isAlive) || state.nightUI.editingRoleAssign) && !g.rolesAutoAssigned"
                 class="role-id-banner mb-3">
              <div class="role-id-label">🛡️ Wer ist der Beschützer?</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
                <div v-for="p in alive.filter(p=>p.role==='unknown'||p.role==='beschuetzer')" :key="p.id"
                     :class="['player-chip', p.role==='beschuetzer'?'selected':'']"
                     style="min-width:68px;padding:8px 6px"
                     @click="toggleRoleAssign(p.id,'beschuetzer')">
                  <span class="chip-icon" style="font-size:1rem">{{ p.role==='beschuetzer'?'🛡️':'👤' }}</span>
                  <span class="chip-name" style="font-size:0.72rem">{{ p.name }}</span>
                </div>
              </div>
            </div>
            <div v-else-if="!g.rolesAutoAssigned" class="role-id-set mb-3">
              <span>🛡️ Beschützer: <strong>{{ g.players.find(p=>p.role==='beschuetzer'&&p.isAlive)?.name }}</strong></span>
              <button class="btn btn-sm btn-secondary" style="padding:3px 8px;font-size:0.72rem"
                      @click="state.nightUI.editingRoleAssign=true">✏️</button>
            </div>
            <div class="night-instruction">Wähle eine Person, die der Beschützer schützt:</div>
            <div class="player-grid mt-3">
              <div v-for="p in alive" :key="p.id"
                   :class="['player-chip', state.nightUI.selectedIds.includes(p.id)?'selected':'', !beschuetzerCanProtect(p.id)?'disabled-choice':'']"
                   @click="beschuetzerCanProtect(p.id)&&nightTogglePlayer(p.id)">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
                <span v-if="p.role==='beschuetzer'" style="font-size:0.65rem;color:var(--text3)">er selbst</span>
                <span v-else-if="!beschuetzerCanProtect(p.id)" style="font-size:0.65rem;color:var(--text3)">letzte Nacht</span>
              </div>
            </div>
          </div>

          <!-- STEP: hexe -->
          <div v-if="step?.id === 'hexe'">
            <!-- Role identity header -->
            <div v-if="(!g.players.some(p=>p.role==='hexe'&&p.isAlive) || state.nightUI.editingRoleAssign) && !g.rolesAutoAssigned"
                 class="role-id-banner mb-3">
              <div class="role-id-label">🧙‍♀️ Wer ist die Hexe?</div>
              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
                <div v-for="p in alive.filter(p=>p.role==='unknown'||p.role==='hexe')" :key="p.id"
                     :class="['player-chip', p.role==='hexe'?'selected':'']"
                     style="min-width:68px;padding:8px 6px"
                     @click="toggleRoleAssign(p.id,'hexe')">
                  <span class="chip-icon" style="font-size:1rem">{{ p.role==='hexe'?'🧙‍♀️':'👤' }}</span>
                  <span class="chip-name" style="font-size:0.72rem">{{ p.name }}</span>
                </div>
              </div>
            </div>
            <div v-else-if="!g.rolesAutoAssigned" class="role-id-set mb-3">
              <span>🧙‍♀️ Hexe: <strong>{{ g.players.find(p=>p.role==='hexe'&&p.isAlive)?.name }}</strong></span>
              <button class="btn btn-sm btn-secondary" style="padding:3px 8px;font-size:0.72rem"
                      @click="state.nightUI.editingRoleAssign=true">✏️</button>
            </div>
            <div class="night-instruction">Hexe, verwende deine Tränke:</div>

            <!-- Wolf target info -->
            <div v-if="g.nightActions.wolfTargetId && !wolfAttackNullified && !beschuetzerSaved" class="card mt-3"
                 style="border-color:var(--red);background:rgba(220,38,38,0.08)">
              <div style="font-size:0.82rem;color:var(--text2)">Die Wölfe haben angegriffen:</div>
              <div style="font-weight:700;font-size:1rem;margin-top:4px">
                {{ playerById(g.nightActions.wolfTargetId)?.name }}
              </div>
              <div style="font-size:0.75rem;color:var(--text3)">
                {{ roleIcon(playerById(g.nightActions.wolfTargetId)?.role) }}
                {{ roleName(playerById(g.nightActions.wolfTargetId)?.role) }}
              </div>
            </div>
            <div v-else-if="beschuetzerSaved" class="card mt-3" style="font-size:0.85rem;color:var(--text2)">
              🛡️ Beschützer hat das Opfer geschützt — niemand stirbt durch Wölfe.
            </div>
            <div v-else-if="wolfAttackNullified" class="card mt-3" style="font-size:0.85rem;color:var(--text2)">
              💋 Die Hure war nicht zuhause — Angriff verpufft, niemand stirbt durch Wölfe.
            </div>
            <div v-else class="card mt-3" style="font-size:0.85rem;color:var(--text2)">
              🛡️ Niemand wurde von den Wölfen angegriffen.
            </div>

            <div class="witch-actions mt-3">
              <!-- Heal potion -->
              <div :class="['witch-potion', g.witchState.healUsed ? 'used' : '']">
                <div class="witch-potion-header">
                  <span style="font-size:1.3rem">💚</span>
                  <span class="witch-potion-name">Heiltrank</span>
                  <span v-if="g.witchState.healUsed" class="witch-potion-used-badge">Verbraucht</span>
                </div>
                <button v-if="!g.witchState.healUsed && g.nightActions.wolfTargetId && !wolfAttackNullified && !beschuetzerSaved && !state.nightUI.witchHealConfirmed"
                        class="btn btn-success btn-full btn-sm"
                        @click="state.nightUI.witchHealConfirmed = true">
                  ✅ Opfer retten
                </button>
                <div v-if="state.nightUI.witchHealConfirmed"
                     style="color:#86efac;font-size:0.85rem;font-weight:600">✅ Wird gerettet</div>
              </div>

              <!-- Kill potion -->
              <div :class="['witch-potion', g.witchState.killUsed ? 'used' : '']">
                <div class="witch-potion-header">
                  <span style="font-size:1.3rem">💀</span>
                  <span class="witch-potion-name">Gifttrank</span>
                  <span v-if="g.witchState.killUsed" class="witch-potion-used-badge">Verbraucht</span>
                </div>
                <div v-if="!g.witchState.killUsed && !state.nightUI.witchKillTarget">
                  <button class="btn btn-danger btn-sm" @click="state.nightUI.witchShowKill = !state.nightUI.witchShowKill">
                    {{ state.nightUI.witchShowKill ? '✕ Abbrechen' : '☠️ Person vergiften' }}
                  </button>
                  <div v-if="state.nightUI.witchShowKill" class="player-grid mt-2">
                    <div v-for="p in alive.filter(p => p.id !== g.nightActions.wolfTargetId)" :key="p.id"
                         class="player-chip"
                         @click="state.nightUI.witchKillTarget = p.id; state.nightUI.witchShowKill = false">
                      <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                      <span class="chip-name">{{ p.name }}</span>
                    </div>
                  </div>
                </div>
                <div v-if="state.nightUI.witchKillTarget"
                     style="color:#fca5a5;font-size:0.85rem;font-weight:600;display:flex;align-items:center;justify-content:space-between">
                  <span>☠️ {{ playerById(state.nightUI.witchKillTarget)?.name }}</span>
                  <button class="btn btn-sm btn-secondary" @click="state.nightUI.witchKillTarget = null">✕</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Confirm button -->
          <div class="mt-4" style="display:flex;flex-direction:column;gap:8px">
            <button v-if="g.nightStepIndex > 0 && step?.id !== 'night-resolve'"
                    class="btn btn-secondary btn-full"
                    @click="nightGoBack">
              ← Schritt zurück
            </button>
            <button v-if="state.testMode && step?.id !== 'night-resolve' && step?.id !== 'seherin'"
                    class="btn btn-full"
                    style="background:rgba(249,115,22,0.15);border:1px solid #f97316;color:#fb923c;font-size:0.85rem"
                    @click="autoFillStep">
              🎲 Auto-Auswahl (Test)
            </button>
            <button class="btn btn-primary btn-full btn-lg" :disabled="!nightCanConfirm()" @click="nightConfirm">
              {{ step?.id === 'hexe' ? '💤 Hexe schläft' : 'Weiter →' }}
            </button>
          </div>

          <!-- Alive players summary -->
          <div class="section-title mt-4">Am Leben ({{ alive.length }})</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            <span v-for="p in alive" :key="p.id" class="pill">
              <span v-if="p.isHauptmann">👑</span>
              <span v-if="p.isLover">💋</span>
              {{ p.name }}
            </span>
          </div>
        </div>

        <!-- NIGHT LOG (moderator review before announcing day) -->
        <div v-else-if="g.phase === 'night-log'">
          <div class="day-header">
            <div class="day-icon">📋</div>
            <div class="day-title">Nacht {{ g.round }} — Todeslog</div>
            <div class="day-subtitle">Überblick bevor der Tag beginnt</div>
          </div>

          <div v-if="!g.dayState.deaths.length" class="card" style="text-align:center;padding:24px;margin-top:8px">
            <div style="font-size:2rem;margin-bottom:8px">🌟</div>
            <div style="font-weight:700">Niemand ist gestorben!</div>
            <div style="font-size:0.85rem;color:var(--text2);margin-top:4px">Eine ruhige Nacht.</div>
          </div>

          <div v-else style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
            <div v-for="(d, i) in g.dayState.deaths" :key="d.playerId"
                 class="card" style="border-left:3px solid var(--red);padding:12px 14px">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="min-width:24px;height:24px;border-radius:50%;background:var(--red);display:flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:800;color:#fff;flex-shrink:0">
                  {{ i + 1 }}
                </div>
                <span style="font-size:1.4rem;flex-shrink:0">{{ ROLES[playerById(d.playerId)?.role]?.icon || '❓' }}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-weight:700;font-size:0.95rem">{{ playerById(d.playerId)?.name }}</div>
                  <div style="font-size:0.75rem;color:var(--text2)">{{ roleName(playerById(d.playerId)?.role) }}</div>
                </div>
              </div>
              <div style="margin-top:8px;font-size:0.82rem;color:var(--text2);padding-left:34px">
                {{ deathCauseLabel(d.cause) }}
              </div>
              <!-- Role picker if unknown -->
              <div v-if="playerById(d.playerId)?.role === 'unknown' && !g.rolesAutoAssigned" style="margin-top:10px;padding-left:34px">
                <div style="font-size:0.72rem;color:var(--text3);margin-bottom:6px">Welche Rolle hatte diese Person?</div>
                <div style="display:flex;flex-wrap:wrap;gap:5px">
                  <template v-for="rid in ['werwolf','seherin','hexe','jaeger','hure','amor','beschuetzer','dorfidiot','dorfbewohner']" :key="rid">
                    <button v-if="g.roleCounts[rid] > 0 && g.players.filter(p => p.role === rid).length < g.roleCounts[rid]"
                            class="btn btn-secondary btn-sm" style="font-size:0.78rem;padding:5px 9px"
                            @click="assignRole(d.playerId, rid)">
                      {{ ROLES[rid]?.icon }} {{ ROLES[rid]?.name }}
                    </button>
                  </template>
                </div>
              </div>
              <!-- Edit role if known (not in auto-assign mode) -->
              <div v-else-if="!g.rolesAutoAssigned" style="margin-top:6px;padding-left:34px">
                <button class="btn btn-sm btn-secondary" style="padding:3px 8px;font-size:0.72rem"
                        @click="assignRole(d.playerId, 'unknown')">✏️ Rolle ändern</button>
              </div>
            </div>
          </div>

          <button class="btn btn-primary btn-full btn-lg mt-4"
                  :disabled="!g.rolesAutoAssigned && g.dayState.deaths.some(d => playerById(d.playerId)?.role === 'unknown')"
                  @click="startDay">
            {{ !g.rolesAutoAssigned && g.dayState.deaths.some(d => playerById(d.playerId)?.role === 'unknown') ? '⚠️ Erst alle Rollen eintragen' : '☀️ Tag beginnen' }}
          </button>
        </div>

        <!-- DAY PHASE -->
        <div v-else-if="g.phase === 'day'">
          <!-- Lover-died phase: blocking splash + role picker -->
          <div v-if="state.dayUI.dayPhase === 'lover-died' && state.dayUI.loverDiedPartner">
            <div class="jaeger-splash" style="flex-direction:column;padding:32px 24px;overflow-y:auto">
              <div class="jaeger-splash-inner" style="max-width:360px;width:100%">
                <div style="font-size:5rem;line-height:1">💔</div>
                <div class="jaeger-splash-title" style="color:#f43f5e">{{ state.dayUI.loverDiedPartner.name }}</div>
                <div class="jaeger-splash-desc">stirbt vor Kummer —<br>
                  <span v-if="state.dayUI.loverDiedBecause">
                    {{ state.dayUI.loverDiedBecause }}
                    {{ state.dayUI.loverDiedCause === 'vote' ? 'wurde vom Dorf hingerichtet.' : '' }}
                    {{ state.dayUI.loverDiedCause === 'wolves' || state.dayUI.loverDiedCause === 'wolves-hure' ? 'wurde von den Werwölfen getötet.' : '' }}
                    {{ state.dayUI.loverDiedCause === 'witch' ? 'wurde von der Hexe vergiftet.' : '' }}
                    {{ state.dayUI.loverDiedCause === 'jaeger' ? 'wurde vom Jäger mitgerissen.' : '' }}
                  </span>
                  <span v-else>Der Liebespartner ist gestorben.</span>
                </div>

                <!-- Role picker for the dead partner -->
                <div v-if="!g.rolesAutoAssigned && state.dayUI.loverDiedPartner.role === 'unknown'" style="margin-top:20px;text-align:left">
                  <div style="font-size:0.82rem;color:var(--text2);margin-bottom:8px">Welche Rolle hatte {{ state.dayUI.loverDiedPartner.name }}?</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">
                    <template v-for="rid in ['werwolf','seherin','hexe','jaeger','hure','amor','beschuetzer','dorfidiot','dorfbewohner']" :key="rid">
                      <button v-if="g.roleCounts[rid] > 0 && g.players.filter(p=>p.role===rid).length < g.roleCounts[rid]"
                              class="btn btn-secondary btn-sm" style="font-size:0.8rem;padding:6px 10px"
                              @click="assignRole(state.dayUI.loverDiedPartner.id, rid)">
                        {{ ROLES[rid]?.icon }} {{ ROLES[rid]?.name }}
                      </button>
                    </template>
                  </div>
                </div>
                <div v-else style="margin-top:12px;font-size:0.9rem;color:var(--text2)">
                  {{ ROLES[state.dayUI.loverDiedPartner.role]?.icon }} {{ ROLES[state.dayUI.loverDiedPartner.role]?.name }}
                </div>

                <button class="btn btn-full btn-lg" style="margin-top:28px;background:#f43f5e;color:#fff;max-width:280px"
                        @click="continueAfterLoverDeath">
                  💔 Verstanden — Weiter
                </button>
              </div>
            </div>
          </div>

          <!-- Jaeger splash overlay -->
          <div v-if="state.dayUI.dayPhase === 'jaeger' && state.dayUI.jaegerSplash"
               class="jaeger-splash" @click="state.dayUI.jaegerSplash = false">
            <div class="jaeger-splash-inner">
              <div style="font-size:5rem;line-height:1">🏹</div>
              <div class="jaeger-splash-title">Der Jäger stirbt!</div>
              <div class="jaeger-splash-desc">Er hat noch einen letzten Schuss frei.<br>Wen nimmt er mit in den Tod?</div>
              <button class="btn btn-danger btn-full btn-lg" style="margin-top:32px;max-width:280px"
                      @click.stop="state.dayUI.jaegerSplash = false">
                🏹 Ziel auswählen
              </button>
            </div>
          </div>

          <!-- Jaeger action -->
          <div v-if="state.dayUI.dayPhase === 'jaeger' && !state.dayUI.jaegerSplash">
            <div class="day-header">
              <div class="day-icon">🏹</div>
              <div class="day-title">Der Jäger!</div>
              <div class="day-subtitle">Wen reißt er mit in den Tod?</div>
            </div>
            <div class="player-grid mt-3">
              <div v-for="p in alive" :key="p.id"
                   :class="['player-chip', state.dayUI.jagerTarget === p.id ? 'wolf-selected' : '']"
                   @click="state.dayUI.jagerTarget = p.id">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
              </div>
            </div>
            <!-- Role reveal for jaeger target if unknown -->
            <div v-if="!g.rolesAutoAssigned && state.dayUI.jagerTarget && playerById(state.dayUI.jagerTarget)?.role === 'unknown'"
                 class="card mt-3" style="border-color:var(--red);background:rgba(220,38,38,0.05)">
              <div style="font-size:0.8rem;color:var(--text2);margin-bottom:8px">
                Rolle von <strong>{{ playerById(state.dayUI.jagerTarget)?.name }}</strong> enthüllen:
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:6px">
                <template v-for="rid in ['werwolf','seherin','hexe','jaeger','hure','amor','beschuetzer','dorfidiot','dorfbewohner']" :key="rid">
                  <button v-if="g.roleCounts[rid] > 0 && g.players.filter(p => p.role === rid).length < g.roleCounts[rid]"
                          class="btn btn-secondary btn-sm" style="font-size:0.8rem;padding:6px 10px"
                          @click="assignRole(state.dayUI.jagerTarget, rid)">
                    {{ ROLES[rid]?.icon }} {{ ROLES[rid]?.name }}
                  </button>
                </template>
              </div>
            </div>
            <button class="btn btn-danger btn-full btn-lg mt-4" :disabled="!state.dayUI.jagerTarget" @click="confirmJaeger">
              🏹 Person mit in den Tod reißen
            </button>
          </div>

          <!-- Hauptmann election (mid-game — always manual, random only at game start) -->
          <div v-if="state.dayUI.dayPhase === 'hauptmann'">
            <div class="day-header">
              <div class="day-icon">👑</div>
              <div class="day-title">Der sterbende Hauptmann bestimmt seinen Nachfolger</div>
            </div>
            <div>
              <div class="night-instruction">Tippe auf den Spieler, der zum Hauptmann gewählt wurde:</div>
              <div class="player-grid mt-3">
                <div v-for="p in alive" :key="p.id"
                     :class="['player-chip', state.dayUI.hauptmannTarget === p.id ? 'selected' : '']"
                     @click="state.dayUI.hauptmannTarget = p.id">
                  <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                  <span class="chip-name">{{ p.name }}</span>
                </div>
              </div>
              <button class="btn btn-gold btn-full btn-lg mt-4" :disabled="!state.dayUI.hauptmannTarget"
                      @click="confirmHauptmann(state.dayUI.hauptmannTarget)">
                👑 Als Hauptmann bestätigen
              </button>
            </div>
          </div>

          <!-- Hauptmann successor -->
          <div v-if="state.dayUI.dayPhase === 'hauptmann-successor'">
            <div class="day-header">
              <div class="day-icon">👑</div>
              <div class="day-title">Der sterbende Hauptmann bestimmt seinen Nachfolger</div>
            </div>
            <div class="player-grid mt-3">
              <div v-for="p in alive" :key="p.id"
                   :class="['player-chip', state.dayUI.hauptmannTarget === p.id ? 'selected' : '']"
                   @click="state.dayUI.hauptmannTarget = p.id">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
              </div>
            </div>
            <button class="btn btn-gold btn-full btn-lg mt-4" :disabled="!state.dayUI.hauptmannTarget"
                    @click="confirmHauptmannSuccessor(state.dayUI.hauptmannTarget)">
              👑 Nachfolger bestätigen
            </button>
          </div>

          <!-- Day vote -->
          <div v-if="state.dayUI.dayPhase === 'vote'">
            <div class="day-header">
              <div class="day-icon">🗳️</div>
              <div class="day-title">Tagesabstimmung</div>
              <div class="day-subtitle">Runde {{ g.round }}</div>
            </div>

            <div v-if="g.hauptmannId" class="vote-warning" style="border-color:var(--gold);background:rgba(217,119,6,0.08);color:#fcd34d">
              👑 Bei Gleichstand entscheidet <strong>{{ playerById(g.hauptmannId)?.name }}</strong> (Hauptmann)
            </div>
            <div v-if="g.loverIds" class="vote-warning" style="border-color:var(--pink);background:rgba(244,63,94,0.1);color:#fda4af">
              💋 <strong>{{ g.loverIds.map(id=>playerById(id)?.name).filter(Boolean).join(' & ') }}</strong> dürfen nicht gegeneinander stimmen!
            </div>

            <div class="night-instruction">Wer wird ausgeschieden? (Tippe auf den Spieler oder "Niemand")</div>
            <div class="player-grid mt-3">
              <div :class="['player-chip', state.dayUI.voteTarget === 'none' ? 'selected' : '']"
                   style="border-color:var(--text3)"
                   @click="state.dayUI.voteTarget = state.dayUI.voteTarget === 'none' ? null : 'none'">
                <span class="chip-icon">🤷</span>
                <span class="chip-name">Niemand</span>
              </div>
              <div v-for="p in alive" :key="p.id"
                   :class="['player-chip', state.dayUI.voteTarget === p.id ? 'wolf-selected' : '']"
                   @click="state.dayUI.voteTarget = state.dayUI.voteTarget === p.id ? null : p.id">
                <span class="chip-icon">{{ ROLES[p.role]?.icon }}</span>
                <span class="chip-name">{{ p.name }}</span>
                <div class="chip-badges">
                  <span v-if="p.isHauptmann" class="chip-badge">👑</span>
                  <span v-if="p.isLover" class="chip-badge">💋</span>
                </div>
              </div>
            </div>
            <button v-if="state.testMode" class="btn btn-full mt-3"
                    style="background:rgba(249,115,22,0.15);border:1px solid #f97316;color:#fb923c;font-size:0.85rem"
                    @click="state.dayUI.voteTarget = alive[Math.floor(Math.random()*alive.length)]?.id">
              🎲 Zufällig wählen (Test)
            </button>
            <button class="btn btn-primary btn-full btn-lg mt-3"
                    :disabled="!state.dayUI.voteTarget"
                    @click="confirmVote">
              ✅ Abstimmung bestätigen
            </button>
          </div>

          <!-- Mandatory role assign after vote kill -->
          <div v-if="state.dayUI.dayPhase === 'vote-role-assign' && state.dayUI.voteRoleAssignId">
            <div class="day-header">
              <div class="day-icon">❓</div>
              <div class="day-title">Rolle enthüllen</div>
              <div class="day-subtitle">{{ playerById(state.dayUI.voteRoleAssignId)?.name }} wurde hingerichtet — welche Rolle hatte sie?</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
              <template v-for="rid in ['werwolf','seherin','hexe','jaeger','hure','amor','beschuetzer','dorfidiot','dorfbewohner']" :key="rid">
                <button v-if="g.roleCounts[rid] > 0 && g.players.filter(p => p.role === rid).length < g.roleCounts[rid]"
                        class="btn btn-secondary btn-full btn-lg"
                        style="font-size:0.95rem"
                        @click="assignRole(state.dayUI.voteRoleAssignId, rid); continueAfterVoteRoleAssign()">
                  {{ ROLES[rid]?.icon }} {{ ROLES[rid]?.name }}
                </button>
              </template>
            </div>
          </div>

          <!-- Dorfidiot reveal -->
          <div v-if="state.dayUI.dayPhase === 'dorfidiot'">
            <div class="day-header">
              <div class="day-icon">🤡</div>
              <div class="day-title">Dorfidiot enthüllt!</div>
              <div class="day-subtitle">{{ playerById(state.dayUI.voteTarget)?.name }} ist der Dorfidiot</div>
            </div>
            <div class="card" style="text-align:center;padding:24px;border-color:var(--green)">
              <div style="font-size:3rem;margin-bottom:8px">🤡</div>
              <div style="font-weight:700;font-size:1.1rem">{{ playerById(state.dayUI.voteTarget)?.name }}</div>
              <div style="color:var(--text2);margin-top:8px;font-size:0.9rem">
                Der Dorfidiot kann nicht durch Abstimmung ausgeschieden werden. Das Spiel geht weiter!
              </div>
            </div>
            <button class="btn btn-primary btn-full btn-lg mt-4" @click="startNewNight">
              🌙 Nächste Nacht
            </button>
          </div>

          <!-- Lover death at vote -->
          <div v-if="state.dayUI.showLoverDeath && state.dayUI.dayPhase !== 'deaths'" class="card mt-3" style="border-color:var(--pink);background:rgba(244,63,94,0.08)">
            <div style="font-size:1.3rem;margin-bottom:6px">💔</div>
            <div style="font-weight:700">{{ state.dayUI.showLoverDeath.name }} stirbt vor Kummer!</div>
            <div style="font-size:0.82rem;color:var(--text2);margin-top:4px">Der Liebespartner wurde ausgeschieden.</div>
          </div>
        </div>
      </div>
    </div>
  `,
  methods: {
    confirmAbandon() {
      if (confirm('Spiel wirklich beenden?')) abandonGame();
    },
    startNewGameAfter() {
      saveActiveGame(null);
      state.game = null;
      startSetup();
    }
  }
};

// ─── STATS SCREEN ─────────────────────────────────────────────────────────────
const StatsScreen = {
  setup() {
    const playerStats = computed(() => computePlayerStats(state.history));
    const roleStats = computed(() => computeRoleStats(state.history));
    const totalGames = computed(() => state.history.length);
    const wolfWins = computed(() => state.history.filter(g => g.winnerTeam === 'wolves').length);
    const villageWins = computed(() => state.history.filter(g => g.winnerTeam === 'village').length);
    const loverWins = computed(() => state.history.filter(g => g.winnerTeam === 'lovers').length);
    const avgRounds = computed(() => {
      if (!state.history.length) return 0;
      return Math.round(state.history.reduce((s, g) => s + g.rounds, 0) / state.history.length);
    });
    const avgDuration = computed(() => {
      const timed = state.history.filter(g => g.endTime && g.date);
      if (!timed.length) return null;
      const avg = timed.reduce((s, g) => s + (g.endTime - g.date), 0) / timed.length;
      return formatDuration(avg);
    });

    function winrateClass(rate) {
      if (rate >= 55) return 'good';
      if (rate >= 40) return 'mid';
      return 'low';
    }

    return { state, playerStats, roleStats, totalGames, wolfWins, villageWins, loverWins, avgRounds, avgDuration, navigate, ROLES, winrateClass, roleName, roleIcon, formatDuration };
  },
  template: `
    <div class="page">
      <div class="nav">
        <button class="nav-btn" @click="navigate('home')">←</button>
        <span class="nav-title">Statistiken</span>
        <span style="width:44px"></span>
      </div>
      <div class="screen">
        <div v-if="totalGames === 0" class="empty-state">
          <div class="empty-icon">📊</div>
          <p>Noch keine Spiele gespielt.<br>Start a game to see stats!</p>
        </div>
        <div v-else>
          <!-- Overview -->
          <div class="section-title">Übersicht</div>
          <div class="stat-hero">
            <div class="stat-box">
              <div class="stat-val">{{ totalGames }}</div>
              <div class="stat-label">Spiele</div>
            </div>
            <div class="stat-box">
              <div class="stat-val">{{ avgRounds }}</div>
              <div class="stat-label">Ø Runden</div>
            </div>
            <div class="stat-box">
              <div class="stat-val" style="font-size:1.1rem">{{ avgDuration || '–' }}</div>
              <div class="stat-label">Ø Dauer</div>
            </div>
            <div class="stat-box">
              <div class="stat-val">{{ state.savedPlayers.length }}</div>
              <div class="stat-label">Spieler</div>
            </div>
          </div>

          <!-- Win rates by team -->
          <div class="card mb-3">
            <div class="card-title">Siegquoten</div>
            <div style="display:flex;flex-direction:column;gap:10px">
              <div v-for="[team, count, icon, color] in [['Werwölfe', wolfWins, '🐺', '#dc2626'], ['Dorf', villageWins, '🏘️', '#16a34a'], ['Liebespaar', loverWins, '💑', '#ec4899']]" :key="team">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                  <span style="font-size:0.85rem;font-weight:600">{{ icon }} {{ team }}</span>
                  <span style="font-size:0.85rem;color:var(--text2)">{{ count }} ({{ totalGames ? Math.round(count/totalGames*100) : 0 }}%)</span>
                </div>
                <div class="win-bar">
                  <div class="win-bar-fill" :style="{ width: totalGames ? (count/totalGames*100)+'%' : '0%', background: color }"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Role stats -->
          <div class="section-title">Rollen-Statistiken</div>
          <div class="card mb-3">
            <div style="display:flex;flex-direction:column;gap:8px">
              <div v-for="roleId in Object.keys(roleStats).filter(r=>roleStats[r].played>0)" :key="roleId"
                   style="display:flex;align-items:center;gap:10px">
                <span style="font-size:1.3rem">{{ roleIcon(roleId) }}</span>
                <div style="flex:1">
                  <div style="font-size:0.85rem;font-weight:600">{{ roleName(roleId) }}</div>
                  <div style="font-size:0.7rem;color:var(--text3)">{{ roleStats[roleId].played }}x gespielt</div>
                </div>
                <span :class="['psc-winrate', roleStats[roleId].winRate >= 55 ? 'good' : roleStats[roleId].winRate >= 40 ? 'mid' : 'low']">
                  {{ roleStats[roleId].winRate }}% S
                </span>
              </div>
            </div>
          </div>

          <!-- Player stats -->
          <div class="section-title">Spieler-Statistiken</div>
          <template v-for="(stat, pid) in playerStats" :key="pid">
          <div v-if="stat.gamesPlayed > 0" class="player-stat-card">
            <div class="psc-header">
              <div class="psc-name">{{ stat.name }}</div>
              <span :class="['psc-winrate', winrateClass(stat.winRate)]">{{ stat.winRate }}%</span>
            </div>
            <div class="psc-grid">
              <div class="psc-stat">
                <div class="pv">{{ stat.gamesPlayed }}</div>
                <div class="pl">Spiele</div>
              </div>
              <div class="psc-stat">
                <div class="pv" style="color:var(--green)">{{ stat.wins }}</div>
                <div class="pl">Siege</div>
              </div>
              <div class="psc-stat">
                <div class="pv" style="color:var(--text3)">{{ stat.survivalRate }}%</div>
                <div class="pl">Überlebt</div>
              </div>
            </div>
            <div class="win-bar mt-2">
              <div class="win-bar-fill" :style="{ width: stat.winRate+'%' }"></div>
            </div>
            <div v-if="stat.favoriteRole" style="margin-top:8px;font-size:0.75rem;color:var(--text2)">
              Lieblingsrolle: {{ roleIcon(stat.favoriteRole) }} {{ roleName(stat.favoriteRole) }}
              ({{ stat.rolesCounts[stat.favoriteRole] }}x)
              <span v-if="stat.asHauptmann > 0"> · 👑 {{ stat.asHauptmann }}x Hauptmann</span>
              <span v-if="stat.asLover > 0"> · 💋 {{ stat.asLover }}x Liebespaar</span>
            </div>
            <!-- Role breakdown -->
            <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">
              <span v-for="(count, role) in stat.rolesCounts" :key="role"
                    class="pill" style="font-size:0.68rem">
                {{ roleIcon(role) }} {{ count }}x
              </span>
            </div>
          </div>
          </template>
        </div>
      </div>
    </div>
  `
};

// ─── HISTORY SCREEN ───────────────────────────────────────────────────────────
const HistoryScreen = {
  setup() {
    const pending = reactive({ type: null, id: null }); // double-confirm state

    function winnerLabel(team) {
      if (team === 'wolves') return '🐺 Werwölfe';
      if (team === 'village') return '🏘️ Dorf';
      if (team === 'lovers') return '💑 Liebespaar';
      return '–';
    }

    function askDelete(type, id = null) {
      pending.type = type;
      pending.id = id;
    }
    function cancelDelete() { pending.type = null; pending.id = null; }
    function confirmDelete() {
      if (pending.type === 'game') deleteGame(pending.id);
      else if (pending.type === 'all') deleteAllHistory();
      pending.type = null; pending.id = null;
    }

    return { state, navigate, formatDate, formatDuration, winnerLabel, roleName, roleIcon,
             pending, askDelete, cancelDelete, confirmDelete };
  },
  template: `
    <div class="page">
      <div class="nav">
        <button class="nav-btn" @click="navigate('home')">←</button>
        <span class="nav-title">Spielhistorie</span>
        <span style="width:44px"></span>
      </div>
      <div class="screen">
        <div v-if="state.history.length === 0" class="empty-state">
          <div class="empty-icon">📜</div>
          <p>Noch keine Spiele gespeichert.</p>
        </div>
        <div v-else>
          <!-- Delete all -->
          <div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-bottom:14px">
            <template v-if="pending.type === 'all'">
              <span style="font-size:0.82rem;color:var(--red);font-weight:600">Alle löschen?</span>
              <button class="btn btn-sm btn-danger" @click="confirmDelete">✓ Ja, alle</button>
              <button class="btn btn-sm btn-secondary" @click="cancelDelete">✕ Nein</button>
            </template>
            <button v-else class="btn btn-sm btn-secondary" style="color:var(--red)"
                    @click="askDelete('all')">
              🗑 Alle löschen
            </button>
          </div>

          <div v-for="(g, idx) in state.history" :key="g.gameId || idx" class="history-item"
               @click="pending.type ? null : (state.historyDetail = (state.historyDetail?.gameId === g.gameId ? null : g))">
            <div class="hi-header">
              <div class="hi-date" style="flex:1">{{ formatDate(g.date) }} · {{ g.rounds }} Runden{{ g.endTime ? ' · ' + formatDuration(g.endTime - g.date) : '' }}</div>
              <span :class="['hi-winner', g.winnerTeam]" style="margin-right:8px">{{ winnerLabel(g.winnerTeam) }}</span>
              <!-- Per-game delete -->
              <template v-if="pending.type === 'game' && pending.id === g.gameId">
                <button class="btn btn-sm btn-danger" style="padding:3px 8px" @click.stop="confirmDelete">✓</button>
                <button class="btn btn-sm btn-secondary" style="padding:3px 8px;margin-left:4px" @click.stop="cancelDelete">✕</button>
              </template>
              <button v-else class="btn btn-sm btn-secondary"
                      style="padding:3px 8px;color:var(--red);flex-shrink:0"
                      @click.stop="askDelete('game', g.gameId)">🗑</button>
            </div>
            <div class="hi-players">
              <span v-for="p in g.players" :key="p.savedPlayerId || p.name"
                    :class="['hi-player', p.won ? 'winner' : '']"
                    :style="p.won ? 'border-color:var(--gold);color:var(--gold)' : ''">
                {{ roleIcon(p.role) }} {{ p.name }}
              </span>
            </div>
            <!-- Expanded detail -->
            <div v-if="state.historyDetail?.gameId === g.gameId" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
              <div style="display:flex;flex-direction:column;gap:6px">
                <div v-for="p in g.players" :key="p.name" style="display:flex;align-items:center;gap:8px;font-size:0.82rem">
                  <span>{{ roleIcon(p.role) }}</span>
                  <span style="flex:1;font-weight:600">{{ p.name }}</span>
                  <span style="color:var(--text2)">{{ roleName(p.role) }}</span>
                  <span v-if="p.won" style="color:var(--gold)">🏆</span>
                  <span v-if="!p.survived" style="color:var(--red)">†R{{ p.diedRound }}</span>
                  <span v-if="p.wasHauptmann" style="color:var(--gold)">👑</span>
                  <span v-if="p.wasLover" style="color:var(--pink)">💋</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
};

// ─── PLAYERS SCREEN ───────────────────────────────────────────────────────────
const PlayersScreen = {
  setup() {
    const localName = reactive({ v: '' });
    const editing = reactive({ id: null, name: '' });
    const stats = computed(() => computePlayerStats(state.history));

    function add() {
      addPlayer(localName.v);
      localName.v = '';
    }

    function startEdit(p) {
      editing.id = p.id;
      editing.name = p.name;
    }

    function saveEdit() {
      const name = editing.name.trim();
      if (!name) return;
      if (state.savedPlayers.find(p => p.id !== editing.id && p.name.toLowerCase() === name.toLowerCase())) {
        showToast('Name bereits vergeben', 'error');
        return;
      }
      const p = state.savedPlayers.find(p => p.id === editing.id);
      if (p) p.name = name;
      savePlayers(state.savedPlayers);
      showToast('Name gespeichert', 'success');
      editing.id = null;
    }

    function cancelEdit() { editing.id = null; }

    const deletePending = reactive({ id: null });
    function askRemove(id) { deletePending.id = id; }
    function confirmRemove() { removePlayer(deletePending.id); deletePending.id = null; }
    function cancelRemove() { deletePending.id = null; }

    return { state, stats, localName, editing, deletePending, navigate, removePlayer, add, addDefaultPlayers,
             startEdit, saveEdit, cancelEdit, askRemove, confirmRemove, cancelRemove, roleName, roleIcon };
  },
  template: `
    <div class="page">
      <div class="nav">
        <button class="nav-btn" @click="navigate('home')">←</button>
        <span class="nav-title">Spieler verwalten</span>
        <span style="width:44px"></span>
      </div>
      <div class="screen">
        <button class="btn btn-secondary btn-full mb-3" @click="addDefaultPlayers">
          👥 Standardspieler hinzufügen
        </button>
        <div class="section-title">Neuen Spieler hinzufügen</div>
        <div style="display:flex;gap:8px;margin-bottom:20px">
          <input class="input" style="flex:1" placeholder="Name…" v-model="localName.v" @keyup.enter="add" />
          <button class="btn btn-primary" @click="add" :disabled="!localName.v.trim()">+ Hinzufügen</button>
        </div>

        <div class="section-title">Alle Spieler ({{ state.savedPlayers.length }})</div>
        <div v-if="state.savedPlayers.length === 0" class="empty-state">
          <div class="empty-icon">👥</div>
          <p>Noch keine Spieler angelegt.</p>
        </div>
        <div v-for="p in state.savedPlayers" :key="p.id" class="player-manage-item">
          <div style="font-size:1.5rem">👤</div>
          <!-- Edit mode -->
          <div v-if="editing.id === p.id" style="flex:1;display:flex;gap:6px;align-items:center">
            <input class="input" style="flex:1;padding:8px 10px;font-size:0.9rem"
                   v-model="editing.name" @keyup.enter="saveEdit" @keyup.escape="cancelEdit" autofocus />
            <button class="btn btn-primary btn-sm" @click="saveEdit">✓</button>
            <button class="btn btn-secondary btn-sm" @click="cancelEdit">✕</button>
          </div>
          <!-- View mode -->
          <div v-else style="flex:1">
            <div class="pmi-name">{{ p.name }}</div>
            <div class="pmi-stats" v-if="stats[p.id] && stats[p.id].gamesPlayed > 0">
              {{ stats[p.id].gamesPlayed }} Spiele · {{ stats[p.id].winRate }}% Siege
              <span v-if="stats[p.id].favoriteRole"> · {{ roleIcon(stats[p.id].favoriteRole) }}</span>
            </div>
            <div class="pmi-stats" v-else>Noch kein Spiel</div>
          </div>
          <div v-if="editing.id !== p.id" style="display:flex;gap:6px;align-items:center">
            <button class="btn btn-sm btn-secondary" @click="startEdit(p)">✏️</button>
            <template v-if="deletePending.id === p.id">
              <button class="btn btn-sm btn-danger" @click="confirmRemove">✓</button>
              <button class="btn btn-sm btn-secondary" @click="cancelRemove">✕</button>
            </template>
            <button v-else class="btn btn-sm btn-secondary" style="color:var(--red)"
                    @click="askRemove(p.id)">🗑</button>
          </div>
        </div>
      </div>
    </div>
  `
};

// ─── BACKUP SCREEN ────────────────────────────────────────────────────────────
const BackupScreen = {
  setup() {
    const backups = computed(() => loadBackups());
    const restoreConfirm = reactive({ slot: null });
    const importRef = { el: null };

    function labelOf(b) {
      if (b.label === 'start') return '▶️ App gestartet';
      if (b.label === 'close') return '⏸ App minimiert';
      return '💾 Manuell';
    }
    function askRestore(slot) { restoreConfirm.slot = slot; }
    function cancelRestore() { restoreConfirm.slot = null; }
    function confirmRestore() { doRestoreBackup(restoreConfirm.slot); restoreConfirm.slot = null; }
    function triggerImport() {
      const inp = document.getElementById('backup-file-input');
      if (inp) inp.click();
    }
    function onFileChange(e) { handleImportFile(e.target.files[0]); e.target.value = ''; }

    return { state, backups, restoreConfirm, navigate, manualExport,
             labelOf, askRestore, cancelRestore, confirmRestore, triggerImport, onFileChange, formatDate };
  },
  template: `
    <div class="page">
      <div class="nav">
        <button class="nav-btn" @click="navigate('home')">←</button>
        <span class="nav-title">Datensicherung</span>
        <span style="width:44px"></span>
      </div>
      <div class="screen">
        <!-- Manual export / import -->
        <div class="section-title">Export / Import</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
          <button class="btn btn-primary btn-full" @click="manualExport">
            💾 JSON exportieren
          </button>
          <button class="btn btn-secondary btn-full" @click="triggerImport">
            📂 JSON importieren
          </button>
        </div>
        <input id="backup-file-input" type="file" accept=".json,application/json"
               style="display:none" @change="onFileChange" />

        <!-- Auto backups -->
        <div class="section-title">Automatische Backups (letzte 3)</div>
        <div v-if="backups.length === 0" class="card" style="font-size:0.85rem;color:var(--text2);padding:16px">
          Noch keine Backups vorhanden. Starte die App oder löse einen Export aus.
        </div>
        <div v-for="(b, i) in backups" :key="b.slot" class="card mb-2">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:0.9rem">{{ labelOf(b) }}</div>
              <div style="font-size:0.78rem;color:var(--text2);margin-top:2px">{{ formatDate(b.ts) }}</div>
              <div style="font-size:0.72rem;color:var(--text3);margin-top:4px">
                {{ (b.players||[]).length }} Spieler · {{ (b.history||[]).length }} Spiele
                <span v-if="b.activeGame"> · laufendes Spiel</span>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
              <template v-if="restoreConfirm.slot === b.slot">
                <span style="font-size:0.78rem;color:var(--red);font-weight:600">Wirklich?</span>
                <button class="btn btn-sm btn-danger" @click="confirmRestore">✓ Ja</button>
                <button class="btn btn-sm btn-secondary" @click="cancelRestore">✕</button>
              </template>
              <button v-else class="btn btn-sm btn-secondary" @click="askRestore(b.slot)">
                ↩ Wiederherstellen
              </button>
            </div>
          </div>
        </div>

        <div class="card mt-3" style="font-size:0.78rem;color:var(--text3);line-height:1.6">
          💡 Backups werden automatisch beim Öffnen und Schließen der App erstellt.
          Der älteste von 3 Slots wird rotierend überschrieben.
          Für dauerhaftes Backup → JSON exportieren und in iCloud Drive speichern.
        </div>
      </div>
    </div>
  `
};

// ─── WHATS NEW MODAL ─────────────────────────────────────────────────────────
const WhatsNewModal = {
  emits: ['close'],
  setup(_, { emit }) {
    const latest = CHANGELOG[0];
    return { latest, BUILD, emit };
  },
  template: `
    <div style="padding:4px 0 8px">
      <div style="text-align:center;margin-bottom:16px">
        <div style="font-size:2rem;margin-bottom:6px">🎉</div>
        <div style="font-size:1.1rem;font-weight:800;color:var(--text1)">Was ist neu?</div>
        <div style="font-size:0.78rem;color:var(--text3);margin-top:4px">Version {{ BUILD }} · {{ latest.date }}</div>
      </div>
      <ul style="list-style:none;padding:0;margin:0 0 20px;display:flex;flex-direction:column;gap:10px">
        <li v-for="(item, i) in latest.changes" :key="i"
            style="display:flex;gap:10px;align-items:flex-start;font-size:0.88rem;color:var(--text2);line-height:1.45">
          <span style="color:var(--accent);font-weight:700;flex-shrink:0;margin-top:1px">✦</span>
          <span>{{ item }}</span>
        </li>
      </ul>
      <button class="btn btn-primary btn-full" @click="emit('close')">Verstanden!</button>
    </div>
  `
};

// ─── CHANGELOG SCREEN ─────────────────────────────────────────────────────────
const ChangelogScreen = {
  setup() {
    return { state, CHANGELOG, BUILD, navigate };
  },
  template: `
    <div class="page">
      <div class="nav">
        <button class="nav-btn" @click="navigate('home')">←</button>
        <span class="nav-title">Changelog</span>
        <span style="width:44px"></span>
      </div>
      <div class="screen">
        <div v-for="entry in CHANGELOG" :key="entry.version" class="card mb-3">
          <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
            <div style="font-size:1rem;font-weight:800;color:var(--text1)">v{{ entry.version }}</div>
            <div v-if="entry.version === BUILD"
                 style="font-size:0.68rem;font-weight:700;color:var(--accent);background:rgba(124,58,237,0.15);border:1px solid var(--accent);border-radius:20px;padding:1px 8px;line-height:1.8">
              Aktuell
            </div>
            <div style="margin-left:auto;font-size:0.75rem;color:var(--text3)">{{ entry.date }}</div>
          </div>
          <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
            <li v-for="(item, i) in entry.changes" :key="i"
                style="display:flex;gap:10px;align-items:flex-start;font-size:0.85rem;color:var(--text2);line-height:1.45">
              <span style="color:var(--accent);font-weight:700;flex-shrink:0;margin-top:1px">✦</span>
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  `
};

// ─── BOOTSTRAP ────────────────────────────────────────────────────────────────
const app = createApp(App);
app.component('HomeScreen', HomeScreen);
app.component('SetupScreen', SetupScreen);
app.component('GameScreen', GameScreen);
app.component('StatsScreen', StatsScreen);
app.component('HistoryScreen', HistoryScreen);
app.component('PlayersScreen', PlayersScreen);
app.component('BackupScreen', BackupScreen);
app.component('WhatsNewModal', WhatsNewModal);
app.component('ChangelogScreen', ChangelogScreen);

// Make helpers accessible in templates via methods on GameScreen
app.config.globalProperties.$fmt = formatDate;

init();
app.mount('#app');

// Hide splash after Vue renders, but always show for at least 1.5 seconds
nextTick(() => {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const elapsed   = Date.now() - APP_START;
  const remaining = Math.max(0, 1500 - elapsed);
  setTimeout(() => {
    splash.classList.add('fade-out');
    setTimeout(() => { if (splash.parentNode) splash.remove(); }, 500);
  }, remaining);
});

// Auto-backup on close / background (pagehide is most reliable on iOS PWA)
window.addEventListener('pagehide', () => createBackup('close'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') createBackup('close');
});

// Service worker registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

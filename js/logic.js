import { ROLES, DEFAULT_NIGHT_ORDER, computeNightSteps } from './data.js';
import { generateId } from './storage.js';

export function createGame({ players, roleCounts, hauptmannMethod, nightOrder }) {
  // Roles are decided offline (physical cards/lots) — all start unknown.
  // Roles are entered by the moderator during the game as they're revealed.
  const gamePlayers = players.map((p) => ({
    id: generateId(),
    savedPlayerId: p.id,
    name: p.name,
    role: 'unknown',
    isAlive: true,
    isHauptmann: false,
    isLover: false,
    loverId: null,
    diedRound: null,
    diedPhase: null,
    diedCause: null,
  }));

  const order = nightOrder || DEFAULT_NIGHT_ORDER;
  const game = {
    id: generateId(),
    startTime: Date.now(),
    endTime: null,
    round: 1,
    phase: 'night',
    nightStepIndex: 0,
    nightSteps: [],
    nightOrder: order,
    roleCounts: {
      ...roleCounts,
      // Compute actual dorfbewohner count (fills remaining slots)
      dorfbewohner: Math.max(0, players.length - Object.values(roleCounts).reduce((s,v) => s+v, 0))
    },
    players: gamePlayers,
    witchState: { healUsed: false, killUsed: false },
    hureState: { lastVisitedId: null },
    beschuetzerState: { lastProtectedId: null },
    nightActions: emptyNightActions(),
    dayState: null,
    loverIds: null,
    hauptmannId: null,
    hauptmannMethod,
    winner: null,
    winnerTeam: null,
    log: [],
  };

  game.nightSteps = computeNightSteps(game, order);
  return game;
}

export function emptyNightActions() {
  return {
    wolfTargetId: null,
    beschuetzerProtectingId: null,
    witchHealing: false,
    witchKillingId: null,
    hureVisitingId: null,
    seerinCheckedId: null,
    seerinResult: null,
    loversChosen: false,
    wolvesRevealed: false,
  };
}

export function resolveNight(game) {
  const { nightActions, players } = game;
  const deaths = [];

  let wolfTarget = nightActions.wolfTargetId;
  const hure = players.find(p => p.role === 'hure' && p.isAlive);
  const hureVisiting = nightActions.hureVisitingId;

  if (hure && hureVisiting) {
    if (wolfTarget === hureVisiting) {
      // Wolves attacked the host — both die unless beschuetzer saved host
      if (nightActions.beschuetzerProtectingId !== hureVisiting) {
        deaths.push({ playerId: hureVisiting, cause: 'wolves' });
        deaths.push({ playerId: hure.id, cause: 'wolves-hure' });
      }
      wolfTarget = null;
    } else if (wolfTarget === hure.id) {
      // Wolves attacked Hure's home but she's away — survives
      wolfTarget = null;
    }
  }

  if (wolfTarget) {
    if (nightActions.beschuetzerProtectingId !== wolfTarget) {
      deaths.push({ playerId: wolfTarget, cause: 'wolves' });
    }
  }

  if (nightActions.witchHealing) {
    // Remove the wolf-kill death (and hure collateral if any)
    const wolfDeathIdx = deaths.findIndex(d => d.cause === 'wolves');
    if (wolfDeathIdx >= 0) deaths.splice(wolfDeathIdx, 1);
    const hureDeathIdx = deaths.findIndex(d => d.cause === 'wolves-hure');
    if (hureDeathIdx >= 0) deaths.splice(hureDeathIdx, 1);
  }

  if (nightActions.witchKillingId) {
    if (!deaths.find(d => d.playerId === nightActions.witchKillingId)) {
      deaths.push({ playerId: nightActions.witchKillingId, cause: 'witch' });
    }
  }

  return deaths;
}

export function checkWinCondition(game) {
  const alive = game.players.filter(p => p.isAlive);
  const wolves = alive.filter(p => p.role === 'werwolf');
  const nonWolves = alive.filter(p => p.role !== 'werwolf');

  if (game.loverIds) {
    const aliveIds = new Set(alive.map(p => p.id));
    if (alive.length === 2 && alive.every(p => game.loverIds.includes(p.id))) {
      return { over: true, winnerTeam: 'lovers', winners: alive };
    }
  }

  if (wolves.length === 0) {
    return { over: true, winnerTeam: 'village', winners: nonWolves };
  }
  if (wolves.length > 0 && nonWolves.length === 0) {
    return { over: true, winnerTeam: 'wolves', winners: wolves };
  }
  return { over: false };
}

export function buildGameStats(game) {
  return {
    gameId: game.id,
    date: game.startTime,
    endTime: game.endTime,
    rounds: game.round,
    winnerTeam: game.winnerTeam,
    nightOrder: game.nightOrder || [],
    players: game.players.map(p => ({
      savedPlayerId: p.savedPlayerId,
      name: p.name,        // snapshot — survives player deletion
      role: p.role === 'unknown' ? 'dorfbewohner' : p.role,
      survived: p.isAlive,
      won: didPlayerWin(p, game),
      wasHauptmann: p.isHauptmann,
      wasLover: p.isLover,
      diedRound: p.diedRound,
      diedCause: p.diedCause,
    }))
  };
}

function didPlayerWin(player, game) {
  if (!game.winnerTeam) return false;
  if (game.winnerTeam === 'lovers') return player.isLover;
  if (game.winnerTeam === 'wolves') return player.role === 'werwolf';
  if (game.winnerTeam === 'village') return player.role !== 'werwolf';
  return false;
}

export function computePlayerStats(history) {
  // Key by savedPlayerId; include ALL players ever seen in history,
  // even if they were deleted from savedPlayers later.
  const stats = {};

  for (const game of history) {
    for (const gp of game.players) {
      const key = gp.savedPlayerId || gp.name; // fallback to name for very old records
      if (!stats[key]) {
        stats[key] = {
          id: key,
          name: gp.name,
          gamesPlayed: 0, wins: 0, losses: 0,
          rolesCounts: {}, survivedCount: 0,
          asHauptmann: 0, asLover: 0,
        };
      }
      const s = stats[key];
      s.gamesPlayed++;
      if (gp.won) s.wins++; else s.losses++;
      if (gp.survived) s.survivedCount++;
      if (gp.wasHauptmann) s.asHauptmann++;
      if (gp.wasLover) s.asLover++;
      s.rolesCounts[gp.role] = (s.rolesCounts[gp.role] || 0) + 1;
    }
  }

  for (const s of Object.values(stats)) {
    s.winRate = s.gamesPlayed > 0 ? Math.round((s.wins / s.gamesPlayed) * 100) : 0;
    s.survivalRate = s.gamesPlayed > 0 ? Math.round((s.survivedCount / s.gamesPlayed) * 100) : 0;
    s.favoriteRole = Object.entries(s.rolesCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  return stats;
}

export function computeRoleStats(history) {
  const stats = {};
  for (const game of history) {
    for (const gp of game.players) {
      if (!stats[gp.role]) stats[gp.role] = { played: 0, wins: 0 };
      stats[gp.role].played++;
      if (gp.won) stats[gp.role].wins++;
    }
  }
  for (const s of Object.values(stats)) {
    s.winRate = s.played > 0 ? Math.round((s.wins / s.played) * 100) : 0;
  }
  return stats;
}

export const ROLES = {
  werwolf: {
    id: 'werwolf', name: 'Werwolf', team: 'wolves',
    icon: '🐺', color: '#dc2626', bgColor: '#450a0a',
    description: 'Tötet jede Nacht gemeinsam eine Person.',
    hasNightAction: true, isMultiple: true
  },
  seherin: {
    id: 'seherin', name: 'Seherin', team: 'village',
    icon: '🔮', color: '#a855f7', bgColor: '#3b0764',
    description: 'Erfährt jede Nacht ob eine Person ein Werwolf ist oder nicht.',
    hasNightAction: true, isMultiple: false
  },
  hexe: {
    id: 'hexe', name: 'Hexe', team: 'village',
    icon: '🧙‍♀️', color: '#22c55e', bgColor: '#052e16',
    description: 'Hat einen Heiltrank und einen Gifttrank. Kann beide in einer Nacht einsetzen. Kann sich selbst retten.',
    hasNightAction: true, isMultiple: false
  },
  jaeger: {
    id: 'jaeger', name: 'Jäger', team: 'village',
    icon: '🏹', color: '#f97316', bgColor: '#431407',
    description: 'Wenn er von Werwölfen getötet wird, darf er eine Person mit in den Tod reißen.',
    hasNightAction: false, isMultiple: false
  },
  hure: {
    id: 'hure', name: 'Hure', team: 'village',
    icon: '💋', color: '#ec4899', bgColor: '#500724',
    description: 'Verbringt jede Nacht bei einer anderen Person. Wenn die Wölfe den Gastgeber angreifen, sterben beide.',
    hasNightAction: true, isMultiple: false
  },
  amor: {
    id: 'amor', name: 'Amor', team: 'village',
    icon: '💘', color: '#f43f5e', bgColor: '#4c0519',
    description: 'Verbindet in der ersten Nacht zwei Verliebte. Das Pärchen gewinnt wenn alle anderen sterben.',
    hasNightAction: true, nightOneOnly: true, isMultiple: false
  },
  beschuetzer: {
    id: 'beschuetzer', name: 'Beschützer', team: 'village',
    icon: '🛡️', color: '#3b82f6', bgColor: '#172554',
    description: 'Schützt jede Nacht eine Person. Nicht sich selbst. Nicht dieselbe Person zwei Nächte hintereinander.',
    hasNightAction: true, isMultiple: false
  },
  dorfidiot: {
    id: 'dorfidiot', name: 'Dorfidiot', team: 'village',
    icon: '🤡', color: '#84cc16', bgColor: '#1a2e05',
    description: 'Kann nicht durch Abstimmung eliminiert werden. Das Dorf erfährt es erst wenn es versucht.',
    hasNightAction: false, isMultiple: false
  },
  dorfbewohner: {
    id: 'dorfbewohner', name: 'Dorfbewohner', team: 'village',
    icon: '👤', color: '#6b7280', bgColor: '#111827',
    description: 'Keine besondere Fähigkeit. Kämpft für das Dorf.',
    hasNightAction: false, isMultiple: true
  },
  unknown: {
    id: 'unknown', name: 'Unbekannt', team: 'village',
    icon: '❓', color: '#6b7280', bgColor: '#111827',
    description: 'Rolle noch nicht enthüllt.',
    hasNightAction: false, isMultiple: true
  }
};

export const ROLE_ORDER = ['werwolf', 'seherin', 'hexe', 'jaeger', 'hure', 'amor', 'beschuetzer', 'dorfidiot', 'dorfbewohner'];

export const DEFAULT_ROLE_COUNTS = {
  werwolf: 2, seherin: 1, hexe: 0, jaeger: 0,
  hure: 0, amor: 0, beschuetzer: 0, dorfidiot: 0
};

// The orderable night roles (wolves-reveal and amor are fixed as first/second in round 1)
// 'werwolf' here = wolves-attack step
export const DEFAULT_NIGHT_ORDER = ['hure', 'beschuetzer', 'seherin', 'werwolf', 'hexe'];

// All step definitions
const STEP_META = {
  'hure':     { id: 'hure',           label: 'Hure erwacht',           icon: '💋', role: 'hure',        nightOneOnly: false },
  'seherin':  { id: 'seherin',        label: 'Seherin erwacht',        icon: '🔮', role: 'seherin',     nightOneOnly: false },
  'werwolf':  { id: 'wolves-attack',  label: 'Werwölfe erwachen',      icon: '🐺', role: 'werwolf',     nightOneOnly: false },
  'beschuetzer': { id: 'beschuetzer', label: 'Beschützer erwacht',     icon: '🛡️', role: 'beschuetzer', nightOneOnly: false },
  'hexe':     { id: 'hexe',           label: 'Hexe erwacht',           icon: '🧙‍♀️', role: 'hexe',      nightOneOnly: false },
};

export function computeNightSteps(game, nightOrder = DEFAULT_NIGHT_ORDER) {
  const { roleCounts, players, round } = game;
  const steps = [];

  // A role is still active if not all confirmed holders are dead.
  // Unknown-role players count as potential holders, so a role stays active
  // until enough players with that role are confirmed dead.
  function roleActive(roleId) {
    const count = roleCounts?.[roleId] || 0;
    if (!count) return false;
    const confirmedDead = players.filter(p => p.role === roleId && !p.isAlive).length;
    return confirmedDead < count;
  }

  // Fixed first-night steps
  if (round === 1) {
    steps.push({ id: 'wolves-reveal', label: 'Werwölfe öffnen die Augen', icon: '🐺', role: 'werwolf' });
    if (roleActive('amor')) {
      steps.push({ id: 'amor', label: 'Amor erwacht', icon: '💘', role: 'amor' });
    }
  }

  // Configurable order — include step only if role still has living holders
  for (const roleKey of nightOrder) {
    const meta = STEP_META[roleKey];
    if (!meta) continue;
    if (roleActive(roleKey)) {
      steps.push({ ...meta });
    }
  }

  return steps;
}

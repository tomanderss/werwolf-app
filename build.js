// build.js — auto-generiert js/buildinfo.js
// Changelog kommt aus changes.txt (wird von Claude gepflegt)

import { execSync }                    from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join }               from 'path';
import { fileURLToPath }               from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: __dir }).toString().trim();
}

// ── Version ───────────────────────────────────────────────────────────────────
const VERSION_OFFSET = 4;
const totalCommits   = parseInt(git('rev-list --count HEAD'));
const VERSION        = `0.${totalCommits + VERSION_OFFSET}`;
const GIT_HASH       = git('rev-parse --short HEAD');

// ── Aktuelle Änderungen aus changes.txt ───────────────────────────────────────
const changesFile = join(__dir, 'changes.txt');
const currentChanges = existsSync(changesFile)
  ? readFileSync(changesFile, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  : ['Stabilitätsverbesserungen'];

// ── Bisherige History aus buildinfo.js übernehmen ────────────────────────────
let oldChangelog = [];
const buildinfoPath = join(__dir, 'js', 'buildinfo.js');
if (existsSync(buildinfoPath)) {
  try {
    const raw = readFileSync(buildinfoPath, 'utf8');
    const match = raw.match(/export const CHANGELOG\s*=\s*(\[[\s\S]*?\]);/);
    if (match) oldChangelog = JSON.parse(match[1]);
  } catch {}
}

// Heutige Datum
const today = new Date().toLocaleDateString('de-DE', {
  day: '2-digit', month: '2-digit', year: 'numeric'
});

// Neuen Eintrag vorne einfügen (ältere Versionen gleicher Version überschreiben)
const newEntry = { version: VERSION, date: today, changes: currentChanges };
const history  = [newEntry, ...oldChangelog.filter(e => e.version !== VERSION)];

// ── Schreiben ─────────────────────────────────────────────────────────────────
const out = `// Auto-generiert von build.js — nicht manuell bearbeiten!
export const BUILD      = '${VERSION}';
export const BUILD_HASH = '${GIT_HASH}';

export const CHANGELOG = ${JSON.stringify(history, null, 2)};
`;

writeFileSync(buildinfoPath, out, 'utf8');

// changes.txt leeren (für nächsten Release-Zyklus)
writeFileSync(changesFile, '', 'utf8');

console.log(`✓ v${VERSION} (${GIT_HASH}) — ${currentChanges.length} Änderungen`);

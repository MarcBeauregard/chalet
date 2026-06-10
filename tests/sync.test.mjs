// Tests de la logique critique de synchronisation : merge 3-way, tombstones,
// normalisation d'état, dates. C'est le code qui peut détruire des données
// s'il régresse — il est extrait tel quel de index.html (voir extract.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChaletCode } from './extract.mjs';

const C = extractChaletCode();
const DAY = 24 * 3600 * 1000;

function baseState(over = {}) {
  return Object.assign(JSON.parse(JSON.stringify(C.DEFAULT_STATE)), over);
}
function task(id, mtime, over = {}) {
  return Object.assign(
    { id: String(id), title: 'Tâche ' + id, done: false, priority: 'medium', person: 'marc', category: 'autre', order: 0, mtime },
    over
  );
}

// ── normalizeState ──────────────────────────────────────────────

test('normalizeState: entrée invalide → état par défaut', () => {
  for (const raw of [null, undefined, 42, 'oops']) {
    const s = C.normalizeState(raw);
    assert.deepEqual(s.tasks, []);
    assert.equal(s.schemaVersion, C.SCHEMA_VERSION);
  }
});

test('normalizeState: ids coercés en string + défauts remplis', () => {
  const s = C.normalizeState(baseState({ tasks: [{ id: 123, title: 'x' }] }));
  assert.equal(s.tasks[0].id, '123');
  assert.equal(s.tasks[0].priority, 'medium');
  assert.equal(s.tasks[0].mtime, 0);
});

test('normalizeState: syncKeyHash invalide rejeté, valide conservé', () => {
  assert.equal(C.normalizeState(baseState({ syncKeyHash: 'pas-un-hash' })).syncKeyHash, '');
  const valid = 'a'.repeat(64);
  assert.equal(C.normalizeState(baseState({ syncKeyHash: valid })).syncKeyHash, valid);
});

test('normalizeState: tombstones > 30 jours purgés, récents conservés', () => {
  const s = C.normalizeState(baseState({
    deletedIds: { tasks: [
      { id: 'vieux', ts: Date.now() - 31 * DAY },
      { id: 'recent', ts: Date.now() - DAY }
    ] }
  }));
  assert.deepEqual(s.deletedIds.tasks.map(t => t.id), ['recent']);
});

test('normalizeState: procedureRuns plafonné à 100 (les plus récents)', () => {
  const runs = Array.from({ length: 150 }, (_, i) => ({
    id: 'r' + i, procedureId: 'p', startedAt: 1000 + i, stepsDone: {}, mtime: 0
  }));
  const s = C.normalizeState(baseState({ procedureRuns: runs }));
  assert.equal(s.procedureRuns.length, 100);
  // Le plus ancien conservé doit être plus récent que tous les écartés
  const kept = s.procedureRuns.map(r => r.startedAt);
  assert.equal(Math.min(...kept), 1000 + 50);
});

test('normalizeState: itemsHistory plafonné à 200 noms (les plus utilisés)', () => {
  const hist = {};
  for (let i = 0; i < 250; i++) hist['item' + i] = i;
  const s = C.normalizeState(baseState({ itemsHistory: { courses: hist, packing: {}, tasks: {} } }));
  const entries = Object.entries(s.itemsHistory.courses);
  assert.equal(entries.length, 200);
  assert.ok(!('item0' in s.itemsHistory.courses));   // le moins utilisé écarté
  assert.ok('item249' in s.itemsHistory.courses);    // le plus utilisé gardé
});

// ── mergeStates ─────────────────────────────────────────────────

test('mergeStates: la version la plus récente d\'un item gagne', () => {
  const local = baseState({ tasks: [task('1', 100, { title: 'locale' })] });
  const remote = baseState({ tasks: [task('1', 200, { title: 'distante' })] });
  assert.equal(C.mergeStates(local, remote).tasks[0].title, 'distante');
  // Symétrique : local plus récent gagne
  const local2 = baseState({ tasks: [task('1', 300, { title: 'locale' })] });
  assert.equal(C.mergeStates(local2, remote).tasks[0].title, 'locale');
});

test('mergeStates: item présent uniquement côté distant est ajouté', () => {
  const local = baseState({ tasks: [task('1', 100)] });
  const remote = baseState({ tasks: [task('2', 100)] });
  const ids = C.mergeStates(local, remote).tasks.map(t => t.id).sort();
  assert.deepEqual(ids, ['1', '2']);
});

test('mergeStates: tombstone plus récent que l\'item supprime', () => {
  // Timestamps récents : normalizeState purge les tombstones > 30 jours
  const t0 = Date.now() - 1000;
  const local = baseState({ tasks: [task('1', t0)] });
  const remote = baseState({ deletedIds: { tasks: [{ id: '1', ts: t0 + 500 }] } });
  assert.deepEqual(C.mergeStates(local, remote).tasks, []);
});

test('mergeStates: item ré-édité après suppression ressuscite', () => {
  const t0 = Date.now() - 1000;
  const local = baseState({ tasks: [task('1', t0 + 500)] });
  const remote = baseState({ deletedIds: { tasks: [{ id: '1', ts: t0 }] } });
  assert.equal(C.mergeStates(local, remote).tasks.length, 1);
});

test('mergeStates: tombstones unionnés des deux côtés', () => {
  const tsRecent = Date.now() - DAY;
  const local = baseState({ deletedIds: { tasks: [{ id: 'a', ts: tsRecent }] } });
  const remote = baseState({ deletedIds: { tasks: [{ id: 'b', ts: tsRecent }] } });
  const ids = C.mergeStates(local, remote).deletedIds.tasks.map(t => t.id).sort();
  assert.deepEqual(ids, ['a', 'b']);
});

test('mergeStates: champ scalaire — le fieldMtime le plus récent gagne', () => {
  const local = baseState({ notes: 'locale', fieldMtimes: { notes: 100 } });
  const remote = baseState({ notes: 'distante', fieldMtimes: { notes: 200 } });
  assert.equal(C.mergeStates(local, remote).notes, 'distante');
  const local2 = baseState({ notes: 'locale', fieldMtimes: { notes: 300 } });
  assert.equal(C.mergeStates(local2, remote).notes, 'locale');
});

test('mergeStates: champs local-only préservés (photos, syncUrl, syncKeyHash)', () => {
  const hash = 'b'.repeat(64);
  const local = baseState({ syncUrl: 'https://local.example', syncKeyHash: hash });
  const remote = baseState({ syncUrl: 'https://remote.example', syncKeyHash: 'c'.repeat(64) });
  const merged = C.mergeStates(local, remote);
  assert.equal(merged.syncUrl, 'https://local.example');
  assert.equal(merged.syncKeyHash, hash);
});

test('mergeStates: remote null/invalide → état local inchangé', () => {
  const local = baseState({ tasks: [task('1', 100)] });
  assert.equal(C.mergeStates(local, null).tasks[0].id, '1');
});

// ── Dates (heure locale, pas UTC) ───────────────────────────────

test('fmtDate/parseDateLocal: aller-retour stable en heure locale', () => {
  const d = new Date(2026, 5, 10); // 10 juin 2026 local
  assert.equal(C.fmtDate(d), '2026-06-10');
  const back = C.parseDateLocal('2026-06-10');
  assert.equal(back.getFullYear(), 2026);
  assert.equal(back.getMonth(), 5);
  assert.equal(back.getDate(), 10);
});

test('isLate: hier en retard, aujourd\'hui et demain non', () => {
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(C.isLate(C.fmtDate(yesterday)), true);
  assert.equal(C.isLate(C.fmtDate(new Date())), false);
  assert.equal(C.isLate(C.fmtDate(tomorrow)), false);
});

// ── Divers ──────────────────────────────────────────────────────

test('safeUrl: bloque javascript: et les URLs non-http', () => {
  assert.equal(C.safeUrl('javascript:alert(1)'), '');
  assert.equal(C.safeUrl('https://example.com/x'), 'https://example.com/x');
});

/**
 * chalet-sync — Cloudflare Worker pour la synchro PWA "Notre Chalet"
 *
 * Backend: Airtable (table ChaletSync). Le Worker sert de proxy sécurisé:
 *   le PAT Airtable ne quitte jamais le serveur, le client ne voit que le
 *   hash bearer.
 *
 * Endpoints:
 *   GET  /state   → { state, lastModified } ou { state: null } si inexistant
 *   PUT  /state   → body = JSON d'état, retour { ok: true, lastModified }
 *
 * Auth client → Worker: `Authorization: Bearer <hash>` où <hash> est un
 *   SHA-256 hex (64 chars) du mot de passe partagé + sel côté client.
 *   Le hash EST la clé logique ("RoomKey"). Pas de brute force sans
 *   mot de passe ≥12 caractères (imposé par l'UI PWA).
 *
 * Secrets Worker requis (à configurer dans Cloudflare dashboard):
 *   AIRTABLE_PAT       — Personal Access Token Airtable (scopes: data.records:read,
 *                        data.records:write sur la base Chalet)
 *   AIRTABLE_BASE_ID   — ID de la base Chalet (ex: appxAyyhoMMiSpngJ)
 *   AIRTABLE_TABLE_ID  — ID de la table ChaletSync (ex: tbljjDJptz704QTz7)
 */

const MAX_BODY_BYTES = 500 * 1024; // 500 kB — Airtable long text limite ~100k chars

export default {
  async fetch(request, env) {
    // Pré-flight CORS
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (url.pathname !== '/state') {
      return cors(json({ error: 'Not found' }, 404));
    }

    // Vérifie que les secrets sont configurés
    if (!env.AIRTABLE_PAT || !env.AIRTABLE_BASE_ID || !env.AIRTABLE_TABLE_ID) {
      return cors(json({ error: 'Airtable non configuré (secrets manquants)' }, 500));
    }

    // Auth: hash hex 64 chars via Bearer token
    const auth = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+([a-f0-9]{64})$/.exec(auth);
    if (!m) {
      return cors(json({ error: 'Invalid or missing key' }, 401));
    }
    const roomKey = m[1];

    try {
      if (request.method === 'GET') {
        return cors(await handleGet(env, roomKey));
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        if (body.length > MAX_BODY_BYTES) {
          return cors(json({ error: 'Body too large' }, 413));
        }
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { return cors(json({ error: 'Invalid JSON' }, 400)); }
        return cors(await handlePut(env, roomKey, parsed));
      }
      return cors(json({ error: 'Method not allowed' }, 405));
    } catch (err) {
      return cors(json({ error: 'Internal error', detail: String(err && err.message || err) }, 502));
    }
  }
};

// ──────────────────────────────────────────────────────────────
// GET: cherche l'enregistrement par RoomKey, renvoie StateJson parsé
// ──────────────────────────────────────────────────────────────
async function handleGet(env, roomKey) {
  const rec = await findRecordByRoomKey(env, roomKey);
  if (!rec) {
    return json({ state: null, lastModified: 0 });
  }
  const raw = (rec.fields && rec.fields.StateJson) || '';
  const lastModified = Number(rec.fields && rec.fields.LastModified) || 0;
  if (!raw) {
    return json({ state: null, lastModified });
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); }
  catch {
    return json({ state: null, lastModified, warning: 'stored-corrupt' });
  }
  return json({ state: parsed, lastModified });
}

// ──────────────────────────────────────────────────────────────
// PUT: upsert (performUpsert sur RoomKey) — un appel, pas de lookup séparé
// ──────────────────────────────────────────────────────────────
async function handlePut(env, roomKey, stateObj) {
  const lastModified = Date.now();
  const stateStr = JSON.stringify(stateObj);
  if (stateStr.length > 95000) {
    // Airtable long text limite ≈ 100k chars — marge de sécurité
    return json({ error: 'State trop volumineux pour Airtable (>95k chars)' }, 413);
  }

  const endpoint = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`;
  const payload = {
    performUpsert: { fieldsToMergeOn: ['RoomKey'] },
    records: [{
      fields: {
        RoomKey: roomKey,
        StateJson: stateStr,
        LastModified: lastModified
      }
    }]
  };

  const res = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.AIRTABLE_PAT}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const detail = await safeText(res);
    return json({ error: 'Airtable upsert failed', status: res.status, detail }, 502);
  }
  return json({ ok: true, lastModified });
}

// ──────────────────────────────────────────────────────────────
// Helper: lookup par RoomKey via filterByFormula
// ──────────────────────────────────────────────────────────────
async function findRecordByRoomKey(env, roomKey) {
  // Formule: {RoomKey} = 'xxxx' — on escape les apostrophes (bien que hex n'en contienne pas)
  const safe = roomKey.replace(/'/g, "\\'");
  const formula = `{RoomKey}='${safe}'`;
  const params = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: '1',
    'fields[]': 'StateJson'
  });
  // On ajoute LastModified comme 2e champ (URLSearchParams ne permet pas 2 fois la même clé facilement)
  params.append('fields[]', 'LastModified');

  const endpoint = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}?${params.toString()}`;
  const res = await fetch(endpoint, {
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` }
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`Airtable GET ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return (data.records && data.records[0]) || null;
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 500); }
  catch { return ''; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers: h });
}

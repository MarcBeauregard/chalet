/**
 * chalet-sync — Cloudflare Worker pour la synchro PWA "Notre Chalet"
 *
 * Backend: Airtable. Le Worker sert de proxy sécurisé; le PAT ne quitte
 *   jamais le serveur, le client ne voit que le hash bearer.
 *
 * Endpoints:
 *   GET    /state              → { state, lastModified } (ChaletSync)
 *   PUT    /state              → upsert state (ChaletSync)
 *   GET    /photos             → { photos: [...] } (ChaletPhotos, liste pour RoomKey)
 *   POST   /photos             → upload photo → { id, url, name, addedBy, addedAt }
 *   DELETE /photos/:id         → supprime la photo (vérifie le RoomKey)
 *
 * Auth client → Worker: `Authorization: Bearer <hash>` où <hash> est un
 *   SHA-256 hex (64 chars) du mot de passe partagé + sel côté client.
 *   Le hash EST la clé logique ("RoomKey").
 *
 * Secrets Worker requis:
 *   AIRTABLE_PAT              — PAT Airtable (scopes: data.records:read/write)
 *   AIRTABLE_BASE_ID          — ID base Chalet (appxAyyhoMMiSpngJ)
 *   AIRTABLE_TABLE_ID         — ID table ChaletSync (tbljjDJptz704QTz7)
 *   AIRTABLE_PHOTOS_TABLE_ID  — ID table ChaletPhotos (tblYiEIWs228rckR6)
 *   AIRTABLE_PHOTOS_FIELD_ID  — ID field Photo attachment (fldb809mPXXwKztgo)
 */

const MAX_STATE_BYTES = 500 * 1024;       // body /state : 500 kB
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;  // body /photos : 6 MB (après base64 ≈ 4.5 MB binaire)

export default {
  async fetch(request, env) {
    // Pré-flight CORS
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Vérifie secrets essentiels
    if (!env.AIRTABLE_PAT || !env.AIRTABLE_BASE_ID || !env.AIRTABLE_TABLE_ID) {
      return cors(json({ error: 'Airtable non configuré (secrets manquants)' }, 500));
    }

    // Auth bearer hash hex 64 chars
    const auth = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+([a-f0-9]{64})$/.exec(auth);
    if (!m) {
      return cors(json({ error: 'Invalid or missing key' }, 401));
    }
    const roomKey = m[1];

    try {
      // === /state (sync blob) ===
      if (path === '/state') {
        if (request.method === 'GET')  return cors(await handleGetState(env, roomKey));
        if (request.method === 'PUT')  return cors(await handlePutState(env, roomKey, request));
        return cors(json({ error: 'Method not allowed' }, 405));
      }

      // === /photos (liste + upload) ===
      if (path === '/photos') {
        if (!env.AIRTABLE_PHOTOS_TABLE_ID || !env.AIRTABLE_PHOTOS_FIELD_ID) {
          return cors(json({ error: 'ChaletPhotos non configurée (secrets manquants)' }, 500));
        }
        if (request.method === 'GET')  return cors(await handleListPhotos(env, roomKey));
        if (request.method === 'POST') return cors(await handleUploadPhoto(env, roomKey, request));
        return cors(json({ error: 'Method not allowed' }, 405));
      }

      // === /photos/:id (delete) ===
      const photoMatch = /^\/photos\/(rec[A-Za-z0-9]{14})$/.exec(path);
      if (photoMatch) {
        if (!env.AIRTABLE_PHOTOS_TABLE_ID) {
          return cors(json({ error: 'ChaletPhotos non configurée' }, 500));
        }
        if (request.method === 'DELETE') return cors(await handleDeletePhoto(env, roomKey, photoMatch[1]));
        return cors(json({ error: 'Method not allowed' }, 405));
      }

      return cors(json({ error: 'Not found' }, 404));
    } catch (err) {
      return cors(json({ error: 'Internal error', detail: String(err && err.message || err) }, 502));
    }
  }
};

// ═════════════════════════════════════════════════════════════════
//  /state — sync blob (inchangé)
// ═════════════════════════════════════════════════════════════════
async function handleGetState(env, roomKey) {
  const rec = await findRecord(env, env.AIRTABLE_TABLE_ID, roomKey, ['StateJson', 'LastModified']);
  if (!rec) return json({ state: null, lastModified: 0 });
  const raw = (rec.fields && rec.fields.StateJson) || '';
  const lastModified = Number(rec.fields && rec.fields.LastModified) || 0;
  if (!raw) return json({ state: null, lastModified });
  let parsed = null;
  try { parsed = JSON.parse(raw); }
  catch { return json({ state: null, lastModified, warning: 'stored-corrupt' }); }
  return json({ state: parsed, lastModified });
}

async function handlePutState(env, roomKey, request) {
  const body = await request.text();
  if (body.length > MAX_STATE_BYTES) return json({ error: 'Body too large' }, 413);
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const lastModified = Date.now();
  const stateStr = JSON.stringify(parsed);
  if (stateStr.length > 95000) return json({ error: 'State trop volumineux pour Airtable (>95k chars)' }, 413);

  const endpoint = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`;
  const payload = {
    performUpsert: { fieldsToMergeOn: ['RoomKey'] },
    records: [{ fields: { RoomKey: roomKey, StateJson: stateStr, LastModified: lastModified } }]
  };
  const res = await fetch(endpoint, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const detail = await safeText(res);
    return json({ error: 'Airtable upsert failed', status: res.status, detail }, 502);
  }
  return json({ ok: true, lastModified });
}

// ═════════════════════════════════════════════════════════════════
//  /photos GET — liste pour une room
// ═════════════════════════════════════════════════════════════════
async function handleListPhotos(env, roomKey) {
  const safe = roomKey.replace(/'/g, "\\'");
  const params = new URLSearchParams({
    filterByFormula: `{RoomKey}='${safe}'`,
    pageSize: '100'
  });
  ['Photo', 'Name', 'AddedAt', 'AddedBy'].forEach(f => params.append('fields[]', f));
  // Tri par AddedAt desc (plus récentes en premier)
  params.append('sort[0][field]', 'AddedAt');
  params.append('sort[0][direction]', 'desc');

  const endpoint = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_PHOTOS_TABLE_ID}?${params.toString()}`;
  const res = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` } });
  if (!res.ok) {
    const detail = await safeText(res);
    return json({ error: 'Airtable list failed', status: res.status, detail }, 502);
  }
  const data = await res.json();
  const photos = (data.records || []).map(r => {
    const att = (r.fields && r.fields.Photo && r.fields.Photo[0]) || null;
    return {
      id: r.id,
      name: (r.fields && r.fields.Name) || '',
      addedBy: (r.fields && r.fields.AddedBy) || '',
      addedAt: Number(r.fields && r.fields.AddedAt) || 0,
      url: att ? att.url : null,
      thumbUrl: (att && att.thumbnails && att.thumbnails.large && att.thumbnails.large.url) || (att ? att.url : null),
      width: att ? att.width : null,
      height: att ? att.height : null
    };
  }).filter(p => p.url);
  return json({ photos });
}

// ═════════════════════════════════════════════════════════════════
//  /photos POST — upload (crée record + upload attachment binaire)
//  Body JSON: { name, addedBy, contentType, base64 }
// ═════════════════════════════════════════════════════════════════
async function handleUploadPhoto(env, roomKey, request) {
  const ctype = request.headers.get('Content-Type') || '';
  if (!ctype.includes('application/json')) {
    return json({ error: 'Content-Type must be application/json' }, 415);
  }
  const raw = await request.text();
  if (raw.length > MAX_PHOTO_BYTES) return json({ error: 'Body too large (max 6 MB)' }, 413);

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const name = String(payload.name || 'photo.jpg').slice(0, 255);
  const addedBy = String(payload.addedBy || '').slice(0, 50);
  const contentType = String(payload.contentType || 'image/jpeg');
  const base64 = String(payload.base64 || '');
  if (!/^image\//i.test(contentType)) return json({ error: 'contentType must be image/*' }, 400);
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) return json({ error: 'Invalid base64' }, 400);

  const addedAt = Date.now();

  // 1) Créer un record "vide" (sans attachment encore)
  const createRes = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_PHOTOS_TABLE_ID}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { RoomKey: roomKey, Name: name, AddedAt: addedAt, AddedBy: addedBy } })
  });
  if (!createRes.ok) {
    const detail = await safeText(createRes);
    return json({ error: 'Airtable create failed', status: createRes.status, detail }, 502);
  }
  const created = await createRes.json();
  const recordId = created.id;

  // 2) Upload de l'attachment via content.airtable.com
  const uploadEndpoint = `https://content.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${recordId}/${env.AIRTABLE_PHOTOS_FIELD_ID}/uploadAttachment`;
  const uploadRes = await fetch(uploadEndpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType, file: base64, filename: name })
  });
  if (!uploadRes.ok) {
    const detail = await safeText(uploadRes);
    // Rollback : supprime le record créé pour ne pas laisser de ligne vide
    await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_PHOTOS_TABLE_ID}/${recordId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` }
    });
    return json({ error: 'Airtable attachment upload failed', status: uploadRes.status, detail }, 502);
  }
  const uploaded = await uploadRes.json();
  const att = (uploaded.fields && uploaded.fields[env.AIRTABLE_PHOTOS_FIELD_ID] && uploaded.fields[env.AIRTABLE_PHOTOS_FIELD_ID][0]) || null;

  return json({
    id: recordId,
    name,
    addedBy,
    addedAt,
    url: att ? att.url : null,
    thumbUrl: (att && att.thumbnails && att.thumbnails.large && att.thumbnails.large.url) || (att ? att.url : null),
    width: att ? att.width : null,
    height: att ? att.height : null
  });
}

// ═════════════════════════════════════════════════════════════════
//  /photos/:id DELETE — supprime record (vérifie RoomKey)
// ═════════════════════════════════════════════════════════════════
async function handleDeletePhoto(env, roomKey, recordId) {
  // 1) Fetch record pour vérifier propriété
  const getRes = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_PHOTOS_TABLE_ID}/${recordId}`, {
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` }
  });
  if (getRes.status === 404) return json({ error: 'Photo not found' }, 404);
  if (!getRes.ok) {
    const detail = await safeText(getRes);
    return json({ error: 'Airtable get failed', status: getRes.status, detail }, 502);
  }
  const rec = await getRes.json();
  const recKey = (rec.fields && rec.fields.RoomKey) || '';
  if (recKey !== roomKey) {
    return json({ error: 'Forbidden (wrong room)' }, 403);
  }
  // 2) Delete
  const delRes = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_PHOTOS_TABLE_ID}/${recordId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` }
  });
  if (!delRes.ok) {
    const detail = await safeText(delRes);
    return json({ error: 'Airtable delete failed', status: delRes.status, detail }, 502);
  }
  return json({ ok: true });
}

// ═════════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════════
async function findRecord(env, tableId, roomKey, fields) {
  const safe = roomKey.replace(/'/g, "\\'");
  const params = new URLSearchParams({
    filterByFormula: `{RoomKey}='${safe}'`,
    maxRecords: '1'
  });
  (fields || []).forEach(f => params.append('fields[]', f));
  const endpoint = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${tableId}?${params.toString()}`;
  const res = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` } });
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
  h.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers: h });
}

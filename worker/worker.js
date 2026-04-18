/**
 * chalet-sync — Cloudflare Worker pour la synchro PWA "Notre Chalet"
 *
 * Endpoints:
 *   GET  /state   → { state, lastModified } ou { state: null } si inexistant
 *   PUT  /state   → body = JSON d'état, retour { ok: true, lastModified }
 *
 * Auth: le client envoie `Authorization: Bearer <hash>` où <hash> est un
 *       SHA-256 (64 hex) du mot de passe partagé + sel côté client.
 *       Le hash EST la clé KV — pas de brute force possible sans un
 *       mot de passe ≥12 caractères (ce que l'UI impose).
 *
 * KV: un binding `CHALET_KV` doit être configuré dans le dashboard.
 * Expiration: 90 jours d'inactivité (un nouveau PUT remet le TTL à zéro).
 */

const TTL_SECONDS = 90 * 24 * 3600; // 90 jours
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

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

    // Auth: hash hex 64 chars via Bearer token
    const auth = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+([a-f0-9]{64})$/.exec(auth);
    if (!m) {
      return cors(json({ error: 'Invalid or missing key' }, 401));
    }
    const key = 'room:' + m[1];

    // Vérifie que le binding existe
    if (!env.CHALET_KV) {
      return cors(json({ error: 'KV namespace non lié (CHALET_KV manquant)' }, 500));
    }

    if (request.method === 'GET') {
      const raw = await env.CHALET_KV.get(key);
      if (!raw) {
        return cors(json({ state: null, lastModified: 0 }));
      }
      try {
        const obj = JSON.parse(raw);
        return cors(json(obj));
      } catch {
        // Corruption: on renvoie un null plutôt que de bloquer
        return cors(json({ state: null, lastModified: 0, warning: 'stored-corrupt' }));
      }
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BODY_BYTES) {
        return cors(json({ error: 'Body too large' }, 413));
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return cors(json({ error: 'Invalid JSON' }, 400));
      }
      const lastModified = Date.now();
      const payload = JSON.stringify({ state: parsed, lastModified });
      await env.CHALET_KV.put(key, payload, { expirationTtl: TTL_SECONDS });
      return cors(json({ ok: true, lastModified }));
    }

    return cors(json({ error: 'Method not allowed' }, 405));
  }
};

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

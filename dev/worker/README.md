# chalet-sync — Worker Cloudflare

Worker ultra-minimal qui stocke un blob JSON par "chambre" dans Cloudflare KV. La clé KV est le SHA-256 (avec sel) du mot de passe partagé entre toi et ta copine — personne d'autre ne peut lire votre donnée sans connaître le mot de passe.

## Déploiement (5 min, via le dashboard web)

1. Va sur https://dash.cloudflare.com → **Workers & Pages** → **KV** → **Create a namespace**
   - Nom du namespace: `chalet-kv` (ou ce que tu veux)

2. Retourne sur **Workers & Pages** → **Create** → **Create Worker**
   - Nom du Worker: `chalet-sync`
   - Colle le contenu de `worker.js`
   - Clique **Deploy**

3. Dans le Worker `chalet-sync`, va dans **Settings** → **Bindings** → **Add** → **KV Namespace**
   - Variable name: `CHALET_KV` (exactement, c'est sensible à la casse)
   - KV namespace: sélectionne `chalet-kv`
   - Save & Deploy

4. Copie l'URL affichée en haut (`https://chalet-sync.<ton-sous-domaine>.workers.dev`)

5. Dans l'app PWA, va dans **Paramètres → Synchronisation cloud → Configurer** et colle cette URL + choisis un mot de passe ≥ 12 caractères. Ta copine fait la même manip (même URL + même mot de passe) sur son iPhone.

## Test rapide en ligne de commande

```bash
# Simule un client: envoie un état, puis le relit
HASH=$(printf '%s' 'chalet-sync-2026-v1:moncodechalet123!' | openssl dgst -sha256 | awk '{print $2}')
URL="https://chalet-sync.<ton-sous-domaine>.workers.dev"

curl -X PUT "$URL/state" \
  -H "Authorization: Bearer $HASH" \
  -H "Content-Type: application/json" \
  -d '{"test":"hello"}'

curl -X GET "$URL/state" \
  -H "Authorization: Bearer $HASH"
```

## Quotas gratuits (largement suffisants pour 2 personnes)

- Workers: 100 000 requêtes/jour gratuites
- KV: 100 000 lectures/jour, 1 000 écritures/jour, 1 Go stockage
- Expiration automatique 90 jours sans écriture (évite l'accumulation)

Pour 2 personnes avec pull toutes les 30s quand l'app est ouverte: ~240 GET/h × 2 = ~11 500 requêtes/jour max. On reste très loin du plafond.

## Changer le sel

Le sel est côté **client** (dans `index.html`, constante `SYNC_SALT`). Le Worker ne le connaît pas — il reçoit juste le hash. Si tu changes le sel, tous les utilisateurs devront reconfigurer leur mot de passe.

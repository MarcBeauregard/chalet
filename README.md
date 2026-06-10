# Notre Chalet

Web app mobile pour planifier et gérer la vie au chalet à deux : séjours, tâches, bagages, liste d'épicerie, photos, contacts, procédures et notes partagées.

Les données sont stockées localement dans le navigateur, et synchronisées entre les deux appareils via un Worker Cloudflare (`worker/`) qui sert de proxy vers Airtable. Un export/import JSON manuel reste disponible dans les paramètres en secours.

## Déploiement

Hébergée sur GitHub Pages à l'URL suivante :

```
https://marcbeauregard.github.io/chalet/
```

Le dossier `dev/` est une copie de prévisualisation servie sous `/chalet/dev/`.

## Installation sur mobile (PWA)

- **iPhone** : ouvrir l'URL dans Safari → bouton Partager → « Sur l'écran d'accueil ».
- **Android** : ouvrir l'URL dans Chrome → menu ⋮ → « Installer l'application ».

Une fois installée, l'app fonctionne hors-ligne.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Application complète (HTML + CSS + JS dans un seul fichier) |
| `manifest.webmanifest` | Métadonnées PWA (nom, couleurs, icônes) |
| `sw.js` | Service worker — cache-first pour fonctionner hors-ligne |
| `worker/worker.js` | Worker Cloudflare — synchro d'état, photos, sauvegardes quotidiennes |
| `tests/` | Tests unitaires de la logique de synchro (merge, tombstones, normalisation) |
| `icon.svg` | Icône source (chalet avec toit enneigé) |
| `icon-192.png`, `icon-512.png` | Icônes PWA Android |
| `apple-touch-icon.png` | Icône iOS (180 × 180) |

## Synchronisation

- Le client pousse l'état complet (`PUT /state`) avec un header `X-Base-Last-Modified` ; si l'autre appareil a poussé entre-temps, le Worker répond 409 et le client re-pull/merge avant de re-pousser (pas d'écrasement silencieux).
- Le Worker snapshote l'état une fois par jour avant écrasement (conservé 14 jours). Restauration : Paramètres → Synchronisation → Sauvegardes quotidiennes.
- Le Worker applique un rate limiting par IP (anti brute-force et anti-spam d'uploads).

## Tests

```
node --test
```

Les tests extraient les fonctions pures de `index.html` (merge 3-way, normalisation d'état, dates) et les exercent avec Node. Ils tournent en CI sur chaque push (`.github/workflows/ci.yml`).

## Mettre à jour après un changement

Après avoir modifié `index.html` ou `sw.js`, bumper la version du cache dans `sw.js` (`CACHE_VERSION`) pour que les utilisateurs récupèrent la nouvelle version.

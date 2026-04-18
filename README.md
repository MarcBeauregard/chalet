# Notre Chalet

Web app mobile pour planifier et gérer la vie au chalet à deux : séjours, tâches, bagages, liste d'épicerie, photos et notes partagées.

Tout est stocké localement dans le navigateur (aucun compte, aucun serveur). La synchronisation entre deux appareils se fait via le bouton **Exporter / Importer JSON** dans les paramètres.

## Déploiement

Hébergée sur GitHub Pages à l'URL suivante :

```
https://marcbeauregard.github.io/chalet/
```

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
| `icon.svg` | Icône source (chalet avec toit enneigé) |
| `icon-192.png`, `icon-512.png` | Icônes PWA Android |
| `apple-touch-icon.png` | Icône iOS (180 × 180) |

## Mettre à jour après un changement

Après avoir modifié `index.html` ou `sw.js`, bumper la version du cache dans `sw.js` (`CACHE_VERSION`) pour que les utilisateurs récupèrent la nouvelle version.

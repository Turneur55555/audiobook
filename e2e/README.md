# Tests de bout en bout

Navigateur réel (Playwright + Chromium). Supabase est simulé : liste d'épisodes, MP3 courts générés
avec ffmpeg, et synchronisation exécutée par un vrai Postgres local (PGlite) avec `supabase/sync.sql`.
Chaque suite tourne en mode « iPhone simulé » (rien n'est chargé avant « Lire », comme Safari iOS)
et en mode ordinateur.

| Suite | Ce qui est vérifié |
|---|---|
| `playback` | enchaînement, fin de tome, minuteur « Fin du chap. », vitesse, précédent/suivant, sauts rapides, réécouter, reprise après rechargement, écran verrouillé |
| `sync` | fusion à la liaison, lecture simultanée, épisodes écoutés, serveur en panne, lien invalide, horloge décalée de 3 min |
| `offline` | tout télécharger / arrêter / reprendre, coupure, suppression, ±15 s sur un épisode téléchargé, enchaînement sans réseau, retour du réseau |
| `reopen` | fermer l'app (en pause ou en lecture) puis la rouvrir : reprise exacte, jamais de 0:00 enregistré, avec un faux Safari qui ignore les sauts précoces et ceux via le service worker |
| `ui` | 60 épisodes, aucune largeur qui déborde de 320 à 1280 px, libellés accessibles |
| `atelier` | import texte + MP3, mise à jour sans doublon, série vide, MP3 supprimé après un échec, compte non autorisé |

```bash
cd e2e && npm install          # pglite + playwright (puis : npx playwright install chromium)
./build-local.sh               # build de production servi en local
OWNER_EMAIL=… node run-all.mjs # OWNER_EMAIL : adresse de l'auteur, pour la suite « atelier »
SUITES=sync MODES=ios node run-all.mjs   # une partie seulement
APP=https://mon-audiobook.vercel.app node run-all.mjs   # contre le site en ligne
```

Limite : ce n'est pas un vrai iPhone. L'écran verrouillé, la lecture en arrière-plan et l'app
installée sur l'écran d'accueil restent à vérifier sur l'appareil.

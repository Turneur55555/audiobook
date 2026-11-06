# Mon Audiobook

Site : https://mon-audiobook.vercel.app

Bibliothèque d’écoute pour *Le Seuil d'Astréon* : chapitres texte et MP3, reprise à la seconde près, écoute écran verrouillé.

- Front : TanStack Start + React + Tailwind
- Données : Supabase (table `chapters`, bucket `audiobook`, table `listening_sync` pour la synchronisation)
- Hébergement : Vercel (déploiement automatique à chaque push sur `main`)

## Commandes

```bash
bun install
bun run dev     # serveur local
bun run test    # tests
bun run build   # build de production
```

## Synchronisation entre appareils

Les positions d’écoute sont partagées entre les appareils qui ont le même code de synchronisation
(QR code ou lien `…/#sync=CODE` dans la Bibliothèque, ou code tapé à la main). Pas de compte.

À activer une fois : coller `supabase/sync.sql` dans Supabase → SQL Editor → Run.
Sans ce script, le site fonctionne comme avant (positions gardées sur chaque appareil).

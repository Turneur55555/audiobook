# Mon Audiobook

Bibliothèque d'écoute pour *Le Seuil d'Astréon* : chapitres texte et MP3, reprise à la seconde près, écoute écran verrouillé.

- Front : TanStack Start + React + Tailwind
- Données : Supabase (table `chapters`, bucket `audiobook`)
- Hébergement : Vercel (déploiement automatique à chaque push sur `main`)

## Commandes

```bash
bun install
bun run dev     # serveur local
bun run test    # tests
bun run build   # build de production
```

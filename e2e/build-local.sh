#!/bin/bash
# Build de production servi localement (preset node-server) pour les tests.
set -e
cd "$(dirname "$0")/.."
sed 's/nitro({ preset: "vercel" })/nitro({ preset: "node-server" })/' vite.config.ts > vite.e2e.config.ts
trap 'rm -f vite.e2e.config.ts' EXIT
npx vite build -c vite.e2e.config.ts 2>&1 | grep -iE "error" || true

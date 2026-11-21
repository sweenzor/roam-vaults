#!/usr/bin/env bash
# Roam Depot build: produces extension.js at the repository root.
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
npm run build

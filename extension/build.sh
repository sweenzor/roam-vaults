#!/usr/bin/env bash
# Roam Depot build. The Depot runs this from the extension/ folder (source_subdir), then picks up
# extension.js, README.md and CHANGELOG.md from this folder. Runs on GitHub Actions ubuntu-24.04.
set -euo pipefail
cd "$(dirname "$0")"
npm ci --no-audit --no-fund
npm run build
cp dist/extension.js extension.js

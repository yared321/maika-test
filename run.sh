#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# If .env.local is missing, copy the template so you can fill in secrets (never commit .env.local).
if [[ ! -f .env.local ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env.local
    echo "Created .env.local from .env.example — edit it with your real values, then run ./run.sh again."
    exit 0
  else
    echo "Missing .env.example; cannot create .env.local." >&2
    exit 1
  fi
fi

set -a
# shellcheck disable=SC1091
source .env.local
set +a

exec npm run dev

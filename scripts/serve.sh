#!/usr/bin/env bash
# Start clipgenerator local API (+ optional Vite note).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY="${ROOT}/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "error: missing .venv. Create it with:" >&2
  echo "  python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

export PYTHONPATH="${ROOT}/app/backend${PYTHONPATH:+:$PYTHONPATH}"
PORT="${PORT:-8787}"
# Daily-driver default: show Agent flow tab. Open-source / clean UI: CLIPGENERATOR_AGENT_FLOW=0
export CLIPGENERATOR_AGENT_FLOW="${CLIPGENERATOR_AGENT_FLOW:-1}"
# Default: NO --reload. Auto-reload kills long download/Whisper jobs mid-run.
# Opt in for backend hacking: RELOAD=1 ./scripts/serve.sh
echo "clipgenerator API → http://127.0.0.1:${PORT}"
echo "  agent_flow=${CLIPGENERATOR_AGENT_FLOW}  (set CLIPGENERATOR_AGENT_FLOW=0 for Editor-only)"
echo "  UI dev (separate terminal): cd app/frontend && npm install && npm run dev"
echo

if [[ "${RELOAD:-0}" == "1" ]]; then
  echo "warning: RELOAD=1 — long STT jobs will die if you edit backend code" >&2
  exec "$PY" -m uvicorn main:app \
    --app-dir "${ROOT}/app/backend" \
    --host 127.0.0.1 \
    --port "$PORT" \
    --reload \
    --reload-dir "${ROOT}/app/backend"
else
  exec "$PY" -m uvicorn main:app \
    --app-dir "${ROOT}/app/backend" \
    --host 127.0.0.1 \
    --port "$PORT"
fi

#!/usr/bin/env bash
# Generate a searchable timestamped transcript from a local video.
# Prefers sidecar YouTube captions when present; otherwise local MLX Whisper.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_SCRIPT="${ROOT}/scripts/transcribe.py"

# Prefer project venv (mlx-whisper lives there)
if [[ -x "${ROOT}/.venv/bin/python" ]]; then
  PYTHON="${ROOT}/.venv/bin/python"
else
  PYTHON="python3"
fi

usage() {
  cat <<'EOF'
Usage: ./scripts/transcribe.sh [options] <video.mp4>

Writes searchable transcript files next to the video:
  <stem>.transcript.json
  <stem>.transcript.txt

Prefers free sidecar captions (.vtt/.srt from download --with-subs).
Otherwise extracts audio and runs local MLX Whisper (no API key).

Options:
  --force       Regenerate even if transcript outputs already exist
  --stt         Force Whisper even if sidecar captions exist
  --model NAME  Whisper model (default: medium). Examples: small, medium, large-v3
  --language    Language code (default: en)
  -h, --help    Show this help

Examples:
  ./scripts/transcribe.sh "videos/Talk [abc123].mp4"
  ./scripts/transcribe.sh --force --model medium "videos/Talk [abc123].mp4"
  ./scripts/transcribe.sh --model large-v3 "videos/Talk [abc123].mp4"

Timestamps are approximate (for finding moments). Caption burn-in is a later release.
EOF
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$PY_SCRIPT" ]]; then
  echo "error: missing $PY_SCRIPT" >&2
  exit 1
fi

exec "$PYTHON" "$PY_SCRIPT" "$@"

#!/usr/bin/env bash
# Generate a searchable timestamped transcript from a local video.
# Prefers sidecar YouTube captions when present; otherwise uses xAI STT.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ROOT}/scripts/transcribe.py"

usage() {
  cat <<'EOF'
Usage: ./scripts/transcribe.sh [options] <video.mp4>

Writes searchable transcript files next to the video:
  <stem>.transcript.json
  <stem>.transcript.txt

Prefers free sidecar captions (.vtt/.srt from download --with-subs).
Otherwise extracts audio and calls xAI STT (requires XAI_API_KEY).

Options:
  --force       Regenerate even if transcript outputs already exist
  --stt         Force xAI STT even if sidecar captions exist
  --language    Language code for STT formatting (default: en)
  -h, --help    Show this help

Examples:
  ./scripts/transcribe.sh "videos/Talk [abc123].mp4"
  ./scripts/transcribe.sh --force "videos/Talk [abc123].mp4"
  ./scripts/transcribe.sh --stt "videos/Talk [abc123].mp4"

Timestamps are approximate (for finding moments). For burn-in captions
on a finished short, use FCP auto-captions on the clipped audio.
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

if [[ ! -f "$PY" ]]; then
  echo "error: missing $PY" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found" >&2
  exit 1
fi

exec python3 "$PY" "$@"

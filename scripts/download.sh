#!/usr/bin/env bash
# Download a YouTube or X video into videos/ using repo yt-dlp defaults.
# Always ensures final file is H.264 + AAC (X-compatible).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${ROOT}/config/yt-dlp.conf"
TO_H264="${ROOT}/scripts/to-h264.sh"
VIDEOS="${ROOT}/videos"
MIN_HEIGHT=1080

usage() {
  cat <<'EOF'
Usage: ./scripts/download.sh [options] <URL> [URL...]

Downloads into videos/ using config/yt-dlp.conf.
Prefers ≥1080p H.264; always re-encodes to H.264+AAC if needed (X-compatible).

Wrapper options:
  --strict-1080   Fail if no format with height ≥ 1080 is available
  --with-subs     Also download English captions (manual + auto) as .vtt
                  sidecars. Useful so ./scripts/transcribe.sh can skip paid STT.
  -h, --help      Show this help

All other options are passed through to yt-dlp.

Examples:
  ./scripts/download.sh "https://www.youtube.com/watch?v=..."
  ./scripts/download.sh "https://x.com/user/status/..."
  ./scripts/download.sh --strict-1080 "URL"
  ./scripts/download.sh --with-subs "https://www.youtube.com/watch?v=..."
  ./scripts/download.sh --cookies-from-browser chrome "URL"
EOF
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

strict_1080=0
with_subs=0
pass_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --strict-1080)
      strict_1080=1
      shift
      ;;
    --with-subs)
      with_subs=1
      shift
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        pass_args+=("$1")
        shift
      done
      break
      ;;
    *)
      pass_args+=("$1")
      shift
      ;;
  esac
done

if [[ ${#pass_args[@]} -eq 0 ]]; then
  echo "error: no URL provided" >&2
  usage
  exit 1
fi

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "error: yt-dlp not found. Install with: brew install yt-dlp ffmpeg" >&2
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "error: ffprobe not found (part of ffmpeg). Install with: brew install ffmpeg" >&2
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "error: missing config: $CONFIG" >&2
  exit 1
fi

if [[ ! -x "$TO_H264" ]]; then
  echo "error: missing or not executable: $TO_H264" >&2
  exit 1
fi

mkdir -p "$VIDEOS"
cd "$ROOT"

extra_args=()
if [[ "$strict_1080" -eq 1 ]]; then
  # Prefer H.264 ≥1080 only (no under-1080 fallback)
  extra_args+=(-f "bv*[vcodec^=avc1][height>=${MIN_HEIGHT}]+ba[ext=m4a]/bv*[height>=${MIN_HEIGHT}]+ba/b[height>=${MIN_HEIGHT}]")
fi
if [[ "$with_subs" -eq 1 ]]; then
  # Sidecars for free transcription via scripts/transcribe.sh (YouTube; X often has none)
  extra_args+=(
    --write-subs
    --write-auto-subs
    --sub-langs "en.*,en"
    --convert-subs vtt
    --skip-unavailable-fragments
  )
fi

paths_file="$(mktemp)"
trap 'rm -f "$paths_file"' EXIT

# Progress/logs on stderr; final filepath(s) on stdout via --print
set +e
yt-dlp \
  --config-locations "$CONFIG" \
  --print after_move:filepath \
  "${extra_args[@]+"${extra_args[@]}"}" \
  "${pass_args[@]}" >"$paths_file"
yt_status=$?
set -e

if [[ "$yt_status" -ne 0 ]]; then
  echo "error: yt-dlp failed (exit $yt_status)" >&2
  exit "$yt_status"
fi

if [[ ! -s "$paths_file" ]]; then
  echo "error: download finished but no output filepath was reported" >&2
  exit 1
fi

echo
echo "=== Ensuring X-compatible encoding (H.264 + AAC) ==="

status=0
while IFS= read -r path || [[ -n "$path" ]]; do
  [[ -z "${path// }" ]] && continue

  if [[ ! -f "$path" ]]; then
    if [[ -f "${ROOT}/${path}" ]]; then
      path="${ROOT}/${path}"
    else
      echo "warning: reported path not found: $path" >&2
      status=1
      continue
    fi
  fi

  abs_path="$(cd "$(dirname "$path")" && pwd)/$(basename "$path")"

  # Always enforce H.264 + AAC in place (no-op if already correct)
  if ! "$TO_H264" "$abs_path"; then
    echo "error: failed to ensure H.264 encoding for: $abs_path" >&2
    status=1
    continue
  fi

  width="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$abs_path" 2>/dev/null || echo "?")"
  height="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$abs_path" 2>/dev/null || echo "?")"
  codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$abs_path" 2>/dev/null || echo "?")"
  acodec="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$abs_path" 2>/dev/null || echo "?")"
  size_human="$(du -h "$abs_path" | awk '{print $1}')"

  echo
  echo "=== Download complete ==="
  echo "Path:       $abs_path"
  echo "Resolution: ${width}x${height}"
  echo "Video:      $codec"
  echo "Audio:      $acodec"
  echo "Size:       $size_human"

  if [[ "$codec" != "h264" ]]; then
    echo "ERROR: final video codec is $codec (expected h264)" >&2
    status=1
  fi
  if [[ "$acodec" != "aac" && "$acodec" != "?" && -n "$acodec" ]]; then
    echo "WARNING: audio codec is $acodec (expected aac)" >&2
  fi
  if [[ "$height" =~ ^[0-9]+$ ]] && [[ "$height" -lt "$MIN_HEIGHT" ]]; then
    echo "WARNING: height is ${height}p (below preferred ${MIN_HEIGHT}p minimum). Saved best available." >&2
  fi
  echo
done <"$paths_file"

exit "$status"

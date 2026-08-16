#!/usr/bin/env bash
# Ensure a video is H.264 + AAC (X / QuickTime compatible).
# Copies a stream that is already correct. Re-encodes only what is not.
# Replaces input in place by default.
#
# Usage:
#   ./scripts/to-h264.sh <input.mp4>
#   ./scripts/to-h264.sh <input.mp4> <output.mp4>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <input.mp4> [output.mp4]" >&2
  exit 1
fi

input="$1"
if [[ ! -f "$input" ]]; then
  echo "error: file not found: $input" >&2
  exit 1
fi

if [[ $# -ge 2 ]]; then
  output="$2"
else
  output="$input"
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "error: ffmpeg/ffprobe required. Install with: brew install ffmpeg" >&2
  exit 1
fi

vcodec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$input" 2>/dev/null | head -1 | tr -d '\r' || echo "")"
acodec="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$input" 2>/dev/null | head -1 | tr -d '\r' || echo "")"

need_v=1
need_a=1
[[ "$vcodec" == "h264" ]] && need_v=0
if [[ "$acodec" == "aac" || -z "$acodec" ]]; then
  need_a=0
fi

if [[ "$need_v" -eq 0 && "$need_a" -eq 0 ]]; then
  if [[ "$input" == "$output" ]]; then
    echo "Already X-compatible (h264${acodec:+/}$acodec): $input"
  else
    cp "$input" "$output"
    echo "Already X-compatible; copied to: $output"
  fi
  exit 0
fi

# macOS mktemp requires the X's at the end (not ….XXXXXX.mp4)
tmp="$(mktemp "${TMPDIR:-/tmp}/to-h264.XXXXXX")"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

echo "Normalizing to H.264 + AAC…"
echo "  in:  $input  (${vcodec:-none}/${acodec:-none})"
echo "  out: $output"
[[ "$need_v" -eq 1 ]] && echo "  video: re-encode" || echo "  video: copy"
if [[ -z "$acodec" ]]; then
  echo "  audio: none"
elif [[ "$need_a" -eq 1 ]]; then
  echo "  audio: re-encode 256k"
else
  echo "  audio: copy"
fi

args=(-y -hide_banner -i "$input")

if [[ "$need_v" -eq 1 ]]; then
  if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
    args+=(-c:v h264_videotoolbox -b:v 8M -pix_fmt yuv420p)
  else
    args+=(-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p)
  fi
else
  args+=(-c:v copy)
fi

if [[ -z "$acodec" ]]; then
  args+=(-an)
elif [[ "$need_a" -eq 1 ]]; then
  if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q aac_at; then
    args+=(-c:a aac_at -b:a 256k -ac 2)
  else
    args+=(-c:a aac -b:a 256k -ac 2 -ar 48000)
  fi
else
  args+=(-c:a copy)
fi

args+=(-movflags +faststart -f mp4 "$tmp")
ffmpeg "${args[@]}"

if [[ "$output" == "$input" ]]; then
  mv -f "$tmp" "$input"
  trap - EXIT
else
  mv -f "$tmp" "$output"
  trap - EXIT
fi

echo
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height -of csv=p=0 "$output"
ls -lh "$output"
echo "Done: $output"

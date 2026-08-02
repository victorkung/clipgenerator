#!/usr/bin/env bash
# Ensure a video is H.264 + AAC (X / QuickTime compatible).
# Skips re-encode if already correct. Replaces input in place by default.
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

in_place=0
if [[ $# -ge 2 ]]; then
  output="$2"
else
  output="$input"
  in_place=1
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "error: ffmpeg/ffprobe required. Install with: brew install ffmpeg" >&2
  exit 1
fi

vcodec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$input" 2>/dev/null || echo "")"
acodec="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$input" 2>/dev/null || echo "")"

if [[ "$vcodec" == "h264" && ( "$acodec" == "aac" || -z "$acodec" ) ]]; then
  if [[ "$in_place" -eq 1 || "$input" == "$output" ]]; then
    echo "Already X-compatible (h264${acodec:+/}$acodec): $input"
  else
    # Copy if destination differs and source is already good
    if [[ "$input" != "$output" ]]; then
      cp "$input" "$output"
      echo "Already X-compatible; copied to: $output"
    fi
  fi
  exit 0
fi

tmp="$(mktemp "${TMPDIR:-/tmp}/to-h264.XXXXXX.mp4")"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

echo "Re-encoding to H.264 + AAC (was ${vcodec:-unknown}/${acodec:-none})..."
echo "  in:  $input"
echo "  out: $output"

# Prefer Apple VideoToolbox when available (fast on macOS); fall back to libx264.
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
  ffmpeg -y -i "$input" \
    -c:v h264_videotoolbox -b:v 8M -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    "$tmp"
else
  ffmpeg -y -i "$input" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -movflags +faststart \
    "$tmp"
fi

# Atomic replace when writing in place
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

#!/usr/bin/env bash
# Download a YouTube or X video into videos/ using repo yt-dlp defaults.
# Always ensures final file is H.264 + AAC (X-compatible).
set -euo pipefail

# bash 3.2 reads this file as it runs. Snapshot to a sibling copy and exec that
# so a later edit of download.sh cannot desync a live ingest.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${CLIPGENERATOR_DOWNLOAD_SNAP:-}" ]]; then
  snap="${ROOT}/scripts/.download.running.$$"
  cp "${BASH_SOURCE[0]}" "$snap"
  chmod +x "$snap"
  export CLIPGENERATOR_DOWNLOAD_SNAP=1
  exec /usr/bin/env bash "$snap" "$@"
fi
if [[ "${BASH_SOURCE[0]}" == *".download.running."* ]]; then
  _snap_cleanup() { rm -f "${BASH_SOURCE[0]}"; }
  trap _snap_cleanup EXIT
fi

CONFIG="${ROOT}/config/yt-dlp.conf"
TO_H264="${ROOT}/scripts/to-h264.sh"
VIDEOS="${ROOT}/videos"
MIN_HEIGHT=1080

usage() {
  cat <<'EOF'
Usage: ./scripts/download.sh [options] <URL> [URL...]

Downloads into videos/ using config/yt-dlp.conf.
Prefers ≥1080p H.264; always re-encodes to H.264+AAC if needed (X-compatible).

Before transfer: prints title, duration, and a size warning for long videos.
During transfer: line-by-line progress (% / speed / ETA). Config defaults to
4 concurrent HLS/DASH fragments (-N 4); override with -N 8 or -N 16 as needed.
X/YouTube send ~5s HLS pieces; we do not pick that size. Sound fetch always
uses ffmpeg + --hls-use-mpegts (TS concat, then decode). Do not set
--hls-use-mpegts in yt-dlp.conf — it breaks X picture+sound merge.

Wrapper options:
  --strict-1080    Fail if no format with height ≥ 1080 is available
  --with-subs      Also download English captions (manual + auto) as .vtt
  --rebuild-audio  Keep existing picture; re-fetch sound (ffmpeg HLS+mpegts) and remux
  -h, --help       Show this help

All other options are passed through to yt-dlp.

Examples:
  ./scripts/download.sh "https://www.youtube.com/watch?v=..."
  ./scripts/download.sh "https://x.com/user/status/..."
  ./scripts/download.sh --strict-1080 "URL"
  ./scripts/download.sh --with-subs "https://www.youtube.com/watch?v=..."
  ./scripts/download.sh -N 16 "https://x.com/user/status/..."
  ./scripts/download.sh --cookies-from-browser chrome "URL"
EOF
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

strict_1080=0
with_subs=0
rebuild_audio=0
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
    --rebuild-audio)
      rebuild_audio=1
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
# Opt-in: ffmpeg treats the HLS playlist as one timeline (still fetches ~5s
# parts from the CDN). Slower than -N 4; use if static remains after re-download.
if [[ "${HLS_DOWNLOADER:-}" == "ffmpeg" ]]; then
  extra_args+=(--downloader ffmpeg)
  echo "HLS_DOWNLOADER=ffmpeg — joining playlist with ffmpeg (slower, cleaner glue)"
fi
# Opt-in only. Default off: X hls+hls-audio merge to mp4 dies with this flag.
if [[ "${HLS_USE_MPEGTS:-}" == "1" ]]; then
  extra_args+=(--hls-use-mpegts)
  echo "HLS_USE_MPEGTS=1 — writing HLS fragments as MPEG-TS"
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

# Output paths are set below (picture / sound / mux). Do not inject -o here.

# Human-readable duration (seconds → H:MM:SS or M:SS)
fmt_duration() {
  local s="${1:-0}"
  # strip decimals
  s="${s%%.*}"
  if ! [[ "$s" =~ ^[0-9]+$ ]]; then
    echo "?"
    return
  fi
  local h=$((s / 3600)) m=$(((s % 3600) / 60)) sec=$((s % 60))
  if [[ "$h" -gt 0 ]]; then
    printf '%d:%02d:%02d' "$h" "$m" "$sec"
  else
    printf '%d:%02d' "$m" "$sec"
  fi
}

echo
echo "=== Resolving media ==="
echo "Saving under: $VIDEOS"
echo "Folder date:  $(date +%Y-%m-%d) (ingest/posting day — not original publish date)"
echo "(X/YouTube posts can attach full-length videos — duration below is what will download.)"
echo

# Lightweight probe so the user sees title/duration before a long transfer.
# Failures here are non-fatal; the real download still runs and reports errors.
set +e
# Use ASCII unit separator-ish delimiter (|) — titles rarely include raw pipes from yt-dlp fields.
probe_out="$(
  yt-dlp \
    --config-locations "$CONFIG" \
    --skip-download \
    --no-warnings \
    --print "%(title)s|%(duration)s|%(id)s|%(webpage_url)s" \
    "${extra_args[@]+"${extra_args[@]}"}" \
    "${pass_args[@]}" 2>/dev/null
)"
probe_status=$?
set -e

expected_dur=""
if [[ "$probe_status" -eq 0 && -n "${probe_out// }" ]]; then
  while IFS='|' read -r p_title p_dur p_id p_url || [[ -n "${p_title:-}" ]]; do
    [[ -z "${p_title// }" ]] && continue
    echo "Title:    $p_title"
    echo "Duration: $(fmt_duration "$p_dur") (${p_dur%%.*}s)"
    echo "ID:       $p_id"
    [[ -n "${p_url// }" ]] && echo "URL:      $p_url"
    if [[ "$p_dur" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      p_dur_int="${p_dur%%.*}"
      expected_dur="$p_dur_int"
      if [[ "$p_dur_int" -ge 900 ]]; then
        # Rough size hint at ~3 Mbps (common for 1080p progressive)
        rough_mb=$((p_dur_int * 3 / 8))
        echo "Note:     Long video (≥15 min). Rough size ballpark ~${rough_mb}MB+ at 1080p — this can take several minutes."
      fi
    fi
    echo
  done <<<"$probe_out"
else
  echo "(Could not pre-fetch metadata; continuing with download…)"
  echo
fi

# Resolve -o template and the URL (last non-flag arg).
out_tmpl=""
url=""
user_fmt=0
skip_next=0
for i in "${!pass_args[@]}"; do
  arg="${pass_args[$i]}"
  if [[ "$skip_next" -eq 1 ]]; then
    skip_next=0
    continue
  fi
  if [[ "$arg" == "-o" || "$arg" == "--output" ]]; then
    out_tmpl="${pass_args[$((i + 1))]:-}"
    skip_next=1
    continue
  fi
  if [[ "$arg" == -o=* || "$arg" == --output=* ]]; then
    out_tmpl="${arg#*=}"
    continue
  fi
  if [[ "$arg" == "-f" || "$arg" == "--format" ]]; then
    user_fmt=1
    continue
  fi
  if [[ "$arg" != -* ]]; then
    url="$arg"
  fi
done

# Flags for yt-dlp minus -o / the URL (we set those ourselves).
passthrough=()
skip_next=0
for i in "${!pass_args[@]}"; do
  arg="${pass_args[$i]}"
  if [[ "$skip_next" -eq 1 ]]; then
    skip_next=0
    continue
  fi
  if [[ "$arg" == "-o" || "$arg" == "--output" ]]; then
    skip_next=1
    continue
  fi
  if [[ "$arg" == -o=* || "$arg" == --output=* ]]; then
    continue
  fi
  if [[ "$arg" == "$url" ]]; then
    continue
  fi
  passthrough+=("$arg")
done

work_dir=""
if [[ -n "$out_tmpl" ]]; then
  work_dir="$(dirname "$out_tmpl")"
  [[ "$work_dir" != /* ]] && work_dir="${ROOT}/${work_dir}"
  mkdir -p "$work_dir"
fi

# First regular file matching dir/prefix* (prefix must not contain globs).
# Do not use ls | head, and never put yt-dlp %(field)s in an unquoted shell word —
# bash treats `(` as a subshell and dies with: syntax error near unexpected token `('
pick_tmp() {
  local dir="$1" prefix="$2" f
  for f in "${dir}/${prefix}"*; do
    [[ -f "$f" ]] || continue
    case "$f" in
      *.part|*.ytdl|*Frag*) continue ;;
    esac
    printf '%s\n' "$f"
    return 0
  done
  return 1
}

media_has_video() {
  local f="$1" d
  [[ -f "$f" && -s "$f" ]] || return 1
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$f" >/dev/null 2>&1 || return 1
  d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null || true)"
  d="${d%%.*}"
  [[ -n "$d" && "$d" =~ ^[0-9]+$ && "$d" -gt 5 ]]
}

# True if leftover sound is long enough vs the probe duration (or >60s if unknown).
# A 15MB sliver looks "100% done" to yt-dlp and would -shortest the picture.
audio_tmp_usable() {
  local f="$1" d min
  [[ -f "$f" && -s "$f" ]] || return 1
  d="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null || true)"
  d="${d%%.*}"
  [[ -n "$d" && "$d" =~ ^[0-9]+$ && "$d" -gt 5 ]] || return 1
  if [[ -n "${expected_dur:-}" && "$expected_dur" =~ ^[0-9]+$ && "$expected_dur" -gt 0 ]]; then
    min=$((expected_dur * 90 / 100))
    [[ "$d" -ge "$min" ]]
  else
    [[ "$d" -gt 60 ]]
  fi
}

mux_picture_and_sound() {
  local picture="$1" sound="$2" dest="$3"
  local tmp
  # macOS mktemp requires the X's at the end — not clipgen-mux.XXXXXX.mp4
  tmp="$(mktemp "${TMPDIR:-/tmp}/clipgen-mux.XXXXXX")"
  echo "Muxing clean ffmpeg audio under the picture…"
  if ! ffmpeg -y -hide_banner -loglevel error \
      -i "$picture" -i "$sound" \
      -map 0:v:0 -map 1:a:0 \
      -c:v copy \
      -c:a copy \
      -avoid_negative_ts make_zero \
      -shortest -movflags +faststart -f mp4 "$tmp" \
      || [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    echo "error: mux picture+sound failed (picture/sound temps kept in the folder — retry mux, do not re-download)" >&2
    return 1
  fi
  mv -f "$tmp" "$dest"
  echo "Wrote $dest"
}

echo "=== Downloading ==="
echo "Picture: native fragments (fast). Sound: ffmpeg HLS as MPEG-TS (one listen)."
echo

status=0
if [[ -z "${url:-}" ]]; then
  echo "error: could not find a URL in the arguments" >&2
  exit 1
fi
if [[ -z "$work_dir" ]]; then
  today="$(date +%Y-%m-%d)"
  work_dir="${VIDEOS}/${today} download"
  mkdir -p "$work_dir"
fi

dest_mp4="${work_dir}/source.mp4"
# API used to pass source.%(ext)s — always mux to source.mp4. A literal
# …/foo.mp4 -o still wins (rebuild-audio).
if [[ -n "$out_tmpl" && "$out_tmpl" == *.mp4 && "$out_tmpl" != *"%("* ]]; then
  dest_mp4="$out_tmpl"
  [[ "$dest_mp4" != /* ]] && dest_mp4="${ROOT}/${dest_mp4}"
fi

picture="$dest_mp4"
sound="${work_dir}/source.audio.clean.m4a"
# Literal names only. %(ext)s in a shell word is a parse error on bash 3.2.
pic_tmp="${work_dir}/.source.video.tmp.mp4"
sound_tmp="${work_dir}/.source.audio.tmp.m4a"

if [[ "$rebuild_audio" -eq 1 ]]; then
  if [[ -f "$dest_mp4" ]]; then
    echo "Rebuild audio only — keeping $dest_mp4 picture"
    picture="$dest_mp4"
  else
    leftover="$(pick_tmp "$work_dir" ".source.video.tmp." || true)"
    if [[ -n "${leftover:-}" ]] && media_has_video "$leftover"; then
      echo "Rebuild audio — using leftover picture $leftover"
      picture="$leftover"
    else
      echo "error: --rebuild-audio needs an existing video at $dest_mp4" >&2
      exit 1
    fi
  fi
else
  leftover="$(pick_tmp "$work_dir" ".source.video.tmp." || true)"
  if [[ -n "${leftover:-}" ]] && media_has_video "$leftover"; then
    echo "Reusing picture already on disk (skip video download): $leftover"
    picture="$leftover"
  else
    echo "--- Picture ---"
    vid_fmt="bv*[vcodec^=avc1][height>=${MIN_HEIGHT}]/bv*[height>=${MIN_HEIGHT}]/bv*"
    if [[ "$strict_1080" -eq 1 ]]; then
      vid_fmt="bv*[vcodec^=avc1][height>=${MIN_HEIGHT}]/bv*[height>=${MIN_HEIGHT}]"
    fi
    vid_args=()
    if [[ "$user_fmt" -eq 0 ]]; then
      vid_args+=(-f "$vid_fmt")
    fi
    if [[ "${HLS_DOWNLOADER:-}" == "ffmpeg" ]]; then
      vid_args+=(--downloader ffmpeg)
    fi
    set +e
    PYTHONUNBUFFERED=1 yt-dlp \
      --config-locations "$CONFIG" \
      --no-quiet --progress --newline \
      "${vid_args[@]}" \
      -o "$pic_tmp" \
      "${extra_args[@]+"${extra_args[@]}"}" \
      "${passthrough[@]+"${passthrough[@]}"}" \
      "$url"
    yt_status=$?
    set -e
    picture="$(pick_tmp "$work_dir" ".source.video.tmp." || true)"
    if [[ "$yt_status" -ne 0 ]]; then
      if [[ -n "${picture:-}" ]] && media_has_video "$picture"; then
        echo "warning: video download exited $yt_status but picture is usable — continuing to sound" >&2
      else
        echo "error: video download failed (exit $yt_status)" >&2
        exit "$yt_status"
      fi
    fi
    if [[ -z "${picture:-}" || ! -f "$picture" ]]; then
      echo "error: video download finished but no .source.video.tmp file" >&2
      exit 1
    fi
  fi
fi

echo
echo "--- Sound (ffmpeg HLS as MPEG-TS, serial fragments) ---"
# Prefer real audio-only (YouTube m4a). X lives are muxed-only — `ba` would
# re-fetch 1080p just to peel AAC, so fall through to ≤480p muxed.
# --hls-use-mpegts is sound-only (picture+merge dies on X with this flag).
# --concurrent-fragments 1 overrides conf -N so sound is week-one serial join.
rm -f "$sound"
raw_audio="$(pick_tmp "$work_dir" ".source.audio.tmp." || true)"
if [[ -n "${raw_audio:-}" ]] && audio_tmp_usable "$raw_audio"; then
  echo "Reusing complete sound already on disk: $raw_audio"
  aud_status=0
else
  rm -f "${work_dir}"/.source.audio.tmp.*
  set +e
  PYTHONUNBUFFERED=1 yt-dlp \
    --config-locations "$CONFIG" \
    --no-quiet --progress --newline \
    --concurrent-fragments 1 \
    -f "ba[ext=m4a]/ba/b[height<=480]/b" \
    --downloader "m3u8:ffmpeg" \
    --downloader "hls:ffmpeg" \
    --hls-use-mpegts \
    -o "$sound_tmp" \
    "${extra_args[@]+"${extra_args[@]}"}" \
    "${passthrough[@]+"${passthrough[@]}"}" \
    "$url"
  aud_status=$?
  set -e
  raw_audio="$(pick_tmp "$work_dir" ".source.audio.tmp." || true)"
fi
if [[ -z "${raw_audio:-}" || ! -f "$raw_audio" ]]; then
  echo "error: audio download failed exit ${aud_status:-?} and no .source.audio.tmp file. Picture kept — rerun to resume." >&2
  exit "${aud_status:-1}"
fi
if [[ "$aud_status" -ne 0 ]]; then
  echo "warning: audio yt-dlp exited $aud_status but $raw_audio is on disk — continuing" >&2
fi

# Decode the TS/fMP4 join to AAC. async resample fills timestamp gaps with
# silence instead of leaving fragment garbage in the PCM.
if ! ffmpeg -y -hide_banner -loglevel error \
    -fflags +genpts+discardcorrupt \
    -i "$raw_audio" \
    -vn \
    -af "aresample=async=1:first_pts=0" \
    -c:a aac -b:a 192k -ac 2 -ar 48000 "$sound" \
    || [[ ! -s "$sound" ]]; then
  echo "error: could not write clean AAC from ffmpeg audio" >&2
  exit 1
fi

echo
echo "=== Mux ==="
if ! mux_picture_and_sound "$picture" "$sound" "$dest_mp4"; then
  exit 1
fi
if [[ "$picture" != "$dest_mp4" ]]; then
  rm -f "$picture"
fi
rm -f "$sound" "${work_dir}"/.source.audio.tmp.* "${work_dir}"/.source.video.tmp.* 2>/dev/null || true

if ! "$TO_H264" "$dest_mp4"; then
  echo "error: failed to ensure H.264 encoding for: $dest_mp4" >&2
  exit 1
fi

width="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$dest_mp4" 2>/dev/null || echo "?")"
height="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$dest_mp4" 2>/dev/null || echo "?")"
codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$dest_mp4" 2>/dev/null || echo "?")"
acodec="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$dest_mp4" 2>/dev/null || echo "?")"
size_human="$(du -h "$dest_mp4" | awk '{print $1}')"

echo
echo "=== Download complete ==="
echo "Path:       $dest_mp4"
echo "Resolution: ${width}x${height}"
echo "Video:      $codec"
echo "Audio:      $acodec"
echo "Size:       $size_human"
if [[ "$codec" != "h264" ]]; then
  echo "ERROR: final video codec is $codec (expected h264)" >&2
  status=1
fi
if [[ "$height" =~ ^[0-9]+$ ]] && [[ "$height" -lt "$MIN_HEIGHT" ]]; then
  echo "WARNING: height is ${height}p (below preferred ${MIN_HEIGHT}p minimum)." >&2
fi
echo

exit "$status"

#!/bin/sh
set -eu

INPUT="${EPISODE_FILE:-}"
PRESET="${1:-classic-high}"

log() {
  echo "[ipod-video] $*"
}

# Current Podsync passes EPISODE_FILE relative to its data directory.
if [ -n "$INPUT" ] && [ "${INPUT#/}" = "$INPUT" ]; then
  INPUT="/app/data/$INPUT"
fi

if [ -z "$INPUT" ] || [ ! -f "$INPUT" ]; then
  log "ERROR: EPISODE_FILE missing or not found: $INPUT"
  exit 1
fi

case "$PRESET" in
  classic-high)
    SIZE_FILTER='scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,setsar=1'
    LEVEL='3.0'
    VIDEO_BITRATE='1200k'
    MAXRATE='1500k'
    BUFSIZE='3000k'
    LABEL='Classic iPod High Quality (640x480)'
    ;;
  max-compat)
    SIZE_FILTER='scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2,setsar=1'
    LEVEL='1.3'
    VIDEO_BITRATE='700k'
    MAXRATE='768k'
    BUFSIZE='1536k'
    LABEL='Maximum Compatibility (320x240)'
    ;;
  *)
    log "ERROR: unknown video preset: $PRESET"
    exit 1
    ;;
esac

DIR="$(dirname "$INPUT")"
BASE="$(basename "$INPUT")"
NAME="${BASE%.*}"
TMP="${DIR}/${NAME}.ipod-tmp.m4v"
FINAL="${DIR}/${NAME}.mp4"

log "hook started"
log "source: $INPUT"
log "preset: $LABEL"

if ! ffmpeg -hide_banner -muxers 2>/dev/null | grep -Eq '^[[:space:]D\.]*E[[:space:]]+ipod[[:space:]]'; then
  log "ERROR: FFmpeg ipod muxer is unavailable"
  exit 1
fi

log "transcoding H.264/AAC for classic iPod"
log "muxer: FFmpeg ipod"
rm -f "$TMP"

ffmpeg -y -i "$INPUT" \
  -map 0:v:0 -map 0:a:0? \
  -vf "$SIZE_FILTER" \
  -r 30 \
  -c:v libx264 \
  -profile:v baseline \
  -level:v "$LEVEL" \
  -pix_fmt yuv420p \
  -b:v "$VIDEO_BITRATE" \
  -maxrate "$MAXRATE" \
  -bufsize "$BUFSIZE" \
  -x264-params "ref=1:bframes=0:cabac=0" \
  -c:a aac \
  -profile:a aac_low \
  -ac 2 \
  -ar 48000 \
  -b:a 128k \
  -movflags +faststart \
  -f ipod \
  "$TMP"

log "verifying converted file"
ffprobe -v error \
  -show_entries stream=index,codec_name,profile,width,height,pix_fmt,level,r_frame_rate,bit_rate,sample_rate,channels \
  -of default=nw=1 "$TMP" | sed 's/^/[ipod-video] verify: /'

rm -f "$FINAL"
mv -f "$TMP" "$FINAL"
log "completed"
log "final: $FINAL"

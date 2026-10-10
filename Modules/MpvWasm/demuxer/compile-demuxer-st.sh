#!/bin/bash
# Компиляция demuxer.cpp (однопоточная сборка) — запускается после того, как собраны libav*.
set -u
B="$HOME/wasm-build"
LOG="$B/compile.log"
: > "$LOG"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
die() { log "FATAL: $*"; exit 1; }

# shellcheck disable=SC1091
source "$B/emsdk/emsdk_env.sh" >>"$LOG" 2>&1
log "emcc: $(emcc --version 2>/dev/null | head -1)"
log "avconfig: $(ls "$B/ffbuild/libavutil/avconfig.h" 2>&1)"

EXPORTS='["_malloc","_free","_demux_open","_demux_close","_demux_get_track_count","_demux_tracks_json","_demux_free_string","_demux_seek","_demux_read_packet","_demux_packet_stream_index","_demux_packet_size","_demux_packet_data","_demux_packet_keyframe","_demux_packet_pts_us","_demux_packet_dts_us","_demux_packet_duration_us","_demux_audio_open","_demux_audio_close","_demux_audio_decode_current_packet","_demux_audio_pcm_ptr","_demux_audio_pcm_samples","_demux_audio_pcm_channels","_demux_audio_sample_rate"]'

mkdir -p "$B/out"
log "em++ (single-threaded, no pthreads)"
nice -n 19 em++ "$B/demuxer.cpp" -O3 -std=c++17 \
  -I"$B/ffbuild" -I"$B/ffmpeg-7.1" \
  -L"$B/ffbuild/libavformat" -L"$B/ffbuild/libavcodec" -L"$B/ffbuild/libavutil" -L"$B/ffbuild/libswresample" \
  -lavformat -lavcodec -lswresample -lavutil -lm \
  -o "$B/out/mpvwasm-demuxer-st.js" \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=MpvWasmDemuxerModule \
  -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sWASM_BIGINT=1 \
  -sINITIAL_MEMORY=64MB \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","UTF8ToString","ccall","cwrap"]' \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  >>"$LOG" 2>&1 || die "em++ demuxer"

log "OK: $(ls -la "$B/out/" | tail -3 | tr '\n' ' ')"
md5sum "$B/out/"* | tee -a "$LOG"
# контроль: в однопоточной сборке не должно быть shared-памяти и pthread
log "shared-memory markers: $(grep -c 'shared: true' "$B/out/mpvwasm-demuxer-st.js" 2>/dev/null || echo 0)"
log "pthread markers: $(grep -c 'PThread' "$B/out/mpvwasm-demuxer-st.js" 2>/dev/null || echo 0)"
echo OK > "$B/DONE-ST"

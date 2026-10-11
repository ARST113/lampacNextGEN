#!/bin/bash
# Single-threaded (no pthreads) FFmpeg WASM demuxer build for the Lampa audio bridge.
# Runs detached on the lampac host as lampac-user, nice'd so lampac streaming is not disturbed.
set -u
B="$HOME/wasm-build"
LOG="$B/build.log"
mkdir -p "$B/out"
: > "$LOG"
rm -f "$B/DONE" "$B/FAILED"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
die() { log "FATAL: $*"; echo "FATAL: $*" > "$B/FAILED"; exit 1; }

log "start; disk: $(df -h / | tail -1); free: $(free -m | sed -n 2p)"

# ---------- 1. emsdk ----------
cd "$B" || die "no build dir"
if [ ! -d "$B/emsdk" ]; then
  log "cloning emsdk"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$B/emsdk" >>"$LOG" 2>&1 || die "git clone emsdk"
fi
cd "$B/emsdk" || die "no emsdk"
if [ ! -f "$B/emsdk/upstream/emscripten/emcc" ]; then
  log "installing emsdk 3.1.74"
  ./emsdk install 3.1.74 >>"$LOG" 2>&1 || { log "3.1.74 failed, trying latest"; ./emsdk install latest >>"$LOG" 2>&1 || die "emsdk install"; }
  ./emsdk activate latest >>"$LOG" 2>&1 || ./emsdk activate 3.1.74 >>"$LOG" 2>&1 || die "emsdk activate"
fi
# shellcheck disable=SC1091
source "$B/emsdk/emsdk_env.sh" >>"$LOG" 2>&1
log "emcc: $(emcc --version 2>/dev/null | head -1)"

# ---------- 2. ffmpeg source ----------
cd "$B" || die "cd B"
if [ ! -d "$B/ffmpeg-7.1" ]; then
  [ -f "$B/ffmpeg-7.1.tar.xz" ] || curl -fsSL -o "$B/ffmpeg-7.1.tar.xz" https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz >>"$LOG" 2>&1 || die "download ffmpeg"
  tar xf "$B/ffmpeg-7.1.tar.xz" >>"$LOG" 2>&1 || die "untar ffmpeg"
fi

DEMUXERS=matroska,mov,mpegts,mpegtsraw,avi,flv,hls,mp3,ogg,wav,flac,aac,ac3,eac3,dts,truehd,m4v
DECODERS=ac3,eac3,dca,truehd,mlp,aac,aac_latm,mp3,mp2,opus,vorbis,flac,alac,wmav2,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_bluray,pcm_dvd
PARSERS=ac3,dca,mlp,aac,aac_latm,mpegaudio,opus,vorbis,flac,h264,hevc,av1,mpeg4video

# ---------- 3. configure + make (nice'd) ----------
mkdir -p "$B/ffbuild"
cd "$B/ffbuild" || die "cd ffbuild"
if [ ! -f "$B/ffbuild/config.mak" ]; then
  log "configure ffmpeg"
  nice -n 19 emconfigure "$B/ffmpeg-7.1/configure" \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --target-os=none --arch=x86_32 --cpu=generic \
    --disable-x86asm --disable-inline-asm --disable-asm \
    --disable-pthreads --disable-w32threads --disable-os2threads \
    --disable-programs --disable-doc --disable-debug --disable-autodetect --disable-stripping \
    --enable-cross-compile --disable-shared --enable-static --enable-swresample \
    --disable-everything \
    --enable-demuxer="$DEMUXERS" --enable-decoder="$DECODERS" --enable-parser="$PARSERS" \
    --enable-protocol=file,data,crypto,http \
    --enable-bsf=null \
    >>"$LOG" 2>&1 || die "configure"
fi
if [ ! -f "$B/ffbuild/libavformat/libavformat.a" ]; then
  log "make ffmpeg (-j2, nice 19)"
  nice -n 19 emmake make -j2 >>"$LOG" 2>&1 || die "make"
fi
log "ffmpeg libs built: $(ls -la "$B/ffbuild/libavformat/libavformat.a" "$B/ffbuild/libavcodec/libavcodec.a" "$B/ffbuild/libswresample/libswresample.a" "$B/ffbuild/libavutil/libavutil.a" 2>&1 | tr '\n' ' ')"

# ---------- 4. compile demuxer.cpp (no pthreads) ----------
cd "$B" || die "cd B"
EXPORTS='["_malloc","_free","_demux_open","_demux_close","_demux_get_track_count","_demux_tracks_json","_demux_free_string","_demux_seek","_demux_read_packet","_demux_packet_stream_index","_demux_packet_size","_demux_packet_data","_demux_packet_keyframe","_demux_packet_pts_us","_demux_packet_dts_us","_demux_packet_duration_us","_demux_audio_open","_demux_audio_close","_demux_audio_decode_current_packet","_demux_audio_pcm_ptr","_demux_audio_pcm_samples","_demux_audio_pcm_channels","_demux_audio_sample_rate"]'
log "compiling demuxer.cpp (single-threaded)"
nice -n 19 em++ "$B/demuxer.cpp" -O3 -std=c++17 \
  -I"$B/ffmpeg-7.1" \
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

ls -la "$B/out/"
log "DONE $(md5sum "$B/out/"* | tr '\n' ' ')"
echo "OK" > "$B/DONE"

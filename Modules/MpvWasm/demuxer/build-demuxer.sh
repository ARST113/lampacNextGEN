#!/bin/sh
set -e

OUT_DIR="${1:-../assets}"
mkdir -p "$OUT_DIR"

export PKG_CONFIG_PATH="/src/build_libs/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

em++ demuxer.cpp -O3 -std=c++17 -o "$OUT_DIR/mpvwasm-demuxer.js" \
  $(pkg-config --cflags --libs libavformat libavcodec libavutil libswresample) \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=MpvWasmDemuxerModule \
  -sENVIRONMENT=web,worker \
  -sINITIAL_MEMORY=64MB \
  -sPTHREAD_POOL_SIZE=4 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sWASM_BIGINT=1 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","UTF8ToString","ccall","cwrap"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_demux_open","_demux_close","_demux_get_track_count","_demux_tracks_json","_demux_free_string","_demux_seek","_demux_read_packet","_demux_packet_stream_index","_demux_packet_size","_demux_packet_data","_demux_packet_keyframe","_demux_packet_pts_us","_demux_packet_dts_us","_demux_packet_duration_us","_demux_audio_open","_demux_audio_close","_demux_audio_decode_current_packet","_demux_audio_pcm_ptr","_demux_audio_pcm_samples","_demux_audio_pcm_channels","_demux_audio_sample_rate"]'

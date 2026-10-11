#!/usr/bin/env python3
# Правит ~/wasm-build/demuxer.cpp: swresample для DTS/dca собирается по параметрам
# первого кадра, а не по догадке сразу после avcodec_open2 (там формат = NONE,
# раскладка = UNSPEC, и swr_init возвращает EINVAL).
import io, os, re, shutil, sys

P = os.path.expanduser('~/wasm-build/demuxer.cpp')
src = io.open(P, encoding='utf-8').read()
orig = src

# 1. build_swr: раскладка без порядка (UNSPEC) приводится к стандартной
anchor = """  av_channel_layout_copy(&in_layout, src_layout);
  if (in_layout.nb_channels <= 0) av_channel_layout_default(&in_layout, 2);"""
repl = """  av_channel_layout_copy(&in_layout, src_layout);
  if (in_layout.nb_channels <= 0) av_channel_layout_default(&in_layout, 2);
  if (in_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
    int nb = in_layout.nb_channels;
    av_channel_layout_uninit(&in_layout);
    av_channel_layout_default(&in_layout, nb > 0 ? nb : 2);
  }"""
assert anchor in src, 'anchor build_swr не найден'
src = src.replace(anchor, repl, 1)

# 2. demux_audio_open: не валим открытие дорожки, если параметры ещё не финальные
anchor2 = """  ret = build_swr(&out_layout, g.audio_ctx->sample_rate, in_fmt);
  av_channel_layout_uninit(&out_layout);
  av_channel_layout_uninit(&in_layout);
  if (ret < 0) return ret;"""
repl2 = """  ret = build_swr(&out_layout, g.audio_ctx->sample_rate, in_fmt);
  av_channel_layout_uninit(&out_layout);
  av_channel_layout_uninit(&in_layout);
  /* DTS/dca отдаёт окончательные формат и раскладку только с первым кадром:
   * сразу после avcodec_open2 там AV_SAMPLE_FMT_NONE и AV_CHANNEL_ORDER_UNSPEC,
   * и swr_init честно возвращает EINVAL. Дорожку не закрываем — swr соберётся
   * в append_audio_frame_pcm() по параметрам первого кадра. */
  if (ret < 0 || g.audio_ctx->sample_fmt == AV_SAMPLE_FMT_NONE ||
      g.audio_ctx->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
    if (g.swr) swr_free(&g.swr);
    g.swr_in_fmt = AV_SAMPLE_FMT_NONE;
    g.swr_in_rate = 0;
    g.swr_in_ch = 0;
  }"""
assert anchor2 in src, 'anchor demux_audio_open не найден'
src = src.replace(anchor2, repl2, 1)

# 3. декодирование кадра не должно требовать уже собранный swr
anchor3 = "if (!g.audio_ctx || !g.swr || !g.audio_frame || !g.packet) return -1;"
repl3 = "if (!g.audio_ctx || !g.audio_frame || !g.packet) return -1;"
assert anchor3 in src, 'anchor guard не найден'
src = src.replace(anchor3, repl3, 1)

if not os.path.exists(P + '.bak-android6'):
    shutil.copy2(P, P + '.bak-android6')
io.open(P, 'w', encoding='utf-8').write(src)
print('patched, bytes', len(orig), '->', len(src))

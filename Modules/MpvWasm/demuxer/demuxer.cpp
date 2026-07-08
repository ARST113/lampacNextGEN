#include <emscripten.h>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <sstream>
#include <string>
#include <vector>

struct DemuxState {
  AVFormatContext* fmt = nullptr;
  AVIOContext* avio = nullptr;
  unsigned char* avio_buffer = nullptr;
  std::string url;
  int64_t pos = 0;
  int64_t size = 0;
  AVPacket* packet = nullptr;
  AVCodecContext* audio_ctx = nullptr;
  SwrContext* swr = nullptr;
  AVFrame* audio_frame = nullptr;
  int audio_stream = -1;
  int audio_sample_rate = 0;
  int audio_channels = 0;
  int audio_samples = 0;
  std::vector<float> audio_pcm;
};

static DemuxState g;

EM_JS(double, js_probe_size, (const char* url_ptr), {
  var url = UTF8ToString(url_ptr);
  function parseRange(value) {
    value = String(value || "");
    var slash = value.lastIndexOf("/");
    return slash >= 0 ? Number(value.slice(slash + 1).trim() || 0) : 0;
  }
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.setRequestHeader('Range', 'bytes=0-0');
    xhr.send(null);
    if (xhr.status === 206) {
      var size = parseRange(xhr.getResponseHeader('Content-Range'));
      if (size > 0) return size;
    }
  } catch (e) {}
  try {
    var head = new XMLHttpRequest();
    head.open('HEAD', url, false);
    head.send(null);
    if (head.status >= 200 && head.status < 400) {
      var length = Number(head.getResponseHeader('Content-Length') || 0);
      if (length > 0) return length;
    }
  } catch (e) {}
  return 0;
});

EM_JS(int, js_read_range, (const char* url_ptr, double offset, int length, uint8_t* out_ptr), {
  var url = UTF8ToString(url_ptr);
  var end = offset + length - 1;
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.setRequestHeader('Range', 'bytes=' + Math.floor(offset) + '-' + Math.floor(end));
    xhr.send(null);
    if (xhr.status !== 206 && xhr.status !== 200) return -1;
    var text = xhr.responseText || "";
    var take = Math.min(text.length, length);
    for (var i = 0; i < take; i++) HEAPU8[out_ptr + i] = text.charCodeAt(i) & 255;
    return take;
  } catch (e) {
    return -1;
  }
});

static int read_packet(void*, uint8_t* buf, int buf_size) {
  if (!g.size || g.pos >= g.size) return AVERROR_EOF;
  int64_t remain = g.size - g.pos;
  int ask = (int)(remain < buf_size ? remain : buf_size);
  int read = js_read_range(g.url.c_str(), (double)g.pos, ask, buf);
  if (read <= 0) return AVERROR_EOF;
  g.pos += read;
  return read;
}

static int64_t seek_packet(void*, int64_t offset, int whence) {
  if (whence == AVSEEK_SIZE) return g.size;
  int64_t target = offset;
  if (whence == SEEK_CUR) target = g.pos + offset;
  else if (whence == SEEK_END) target = g.size + offset;
  if (target < 0) target = 0;
  if (g.size && target > g.size) target = g.size;
  g.pos = target;
  return g.pos;
}

static std::string json_escape(const char* raw) {
  std::string input = raw ? raw : "";
  std::ostringstream out;
  for (char c : input) {
    switch (c) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) out << ' ';
        else out << c;
    }
  }
  return out.str();
}

static const char* media_type_name(enum AVMediaType type) {
  if (type == AVMEDIA_TYPE_VIDEO) return "video";
  if (type == AVMEDIA_TYPE_AUDIO) return "audio";
  if (type == AVMEDIA_TYPE_SUBTITLE) return "subtitle";
  return "other";
}

static std::string b64(const uint8_t* data, int size) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  if (!data || size <= 0) return out;
  out.reserve(((size + 2) / 3) * 4);
  for (int i = 0; i < size; i += 3) {
    int v = data[i] << 16;
    if (i + 1 < size) v |= data[i + 1] << 8;
    if (i + 2 < size) v |= data[i + 2];
    out.push_back(table[(v >> 18) & 63]);
    out.push_back(table[(v >> 12) & 63]);
    out.push_back(i + 1 < size ? table[(v >> 6) & 63] : '=');
    out.push_back(i + 2 < size ? table[v & 63] : '=');
  }
  return out;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
void demux_close() {
  if (g.packet) av_packet_free(&g.packet);
  if (g.audio_frame) av_frame_free(&g.audio_frame);
  if (g.swr) swr_free(&g.swr);
  if (g.audio_ctx) avcodec_free_context(&g.audio_ctx);
  if (g.fmt) avformat_close_input(&g.fmt);
  if (g.avio) avio_context_free(&g.avio);
  if (g.avio_buffer) {
    av_free(g.avio_buffer);
    g.avio_buffer = nullptr;
  }
  g = DemuxState();
}

EMSCRIPTEN_KEEPALIVE
int demux_open(const char* url) {
  demux_close();
  if (!url || !url[0]) return -1;
  g.url = url;
  g.size = (int64_t)js_probe_size(url);
  if (g.size <= 0) return -2;

  const int buffer_size = 32768;
  g.avio_buffer = (unsigned char*)av_malloc(buffer_size);
  if (!g.avio_buffer) return -3;
  g.avio = avio_alloc_context(g.avio_buffer, buffer_size, 0, nullptr, read_packet, nullptr, seek_packet);
  if (!g.avio) return -4;

  g.fmt = avformat_alloc_context();
  if (!g.fmt) return -5;
  g.fmt->pb = g.avio;
  g.fmt->flags |= AVFMT_FLAG_CUSTOM_IO;

  int ret = avformat_open_input(&g.fmt, url, nullptr, nullptr);
  if (ret < 0) return ret;
  ret = avformat_find_stream_info(g.fmt, nullptr);
  if (ret < 0) return ret;
  g.packet = av_packet_alloc();
  return g.packet ? 0 : -6;
}

EMSCRIPTEN_KEEPALIVE
int demux_get_track_count() {
  return g.fmt ? (int)g.fmt->nb_streams : 0;
}

EMSCRIPTEN_KEEPALIVE
char* demux_tracks_json() {
  std::ostringstream out;
  out << "{\"durationUs\":" << (g.fmt ? g.fmt->duration : 0)
      << ",\"size\":" << g.size << ",\"tracks\":[";
  if (g.fmt) {
    for (unsigned int i = 0; i < g.fmt->nb_streams; i++) {
      AVStream* stream = g.fmt->streams[i];
      AVCodecParameters* par = stream->codecpar;
      const AVCodecDescriptor* desc = avcodec_descriptor_get(par->codec_id);
      AVDictionaryEntry* title = av_dict_get(stream->metadata, "title", nullptr, 0);
      if (i) out << ",";
      out << "{";
      out << "\"index\":" << i;
      out << ",\"type\":\"" << media_type_name(par->codec_type) << "\"";
      out << ",\"codecId\":" << (int)par->codec_id;
      out << ",\"codecName\":\"" << json_escape(desc ? desc->name : avcodec_get_name(par->codec_id)) << "\"";
      out << ",\"codecTag\":" << par->codec_tag;
      out << ",\"profile\":" << par->profile;
      out << ",\"level\":" << par->level;
      out << ",\"timeBaseNum\":" << stream->time_base.num;
      out << ",\"timeBaseDen\":" << stream->time_base.den;
      out << ",\"title\":\"" << json_escape(title ? title->value : "") << "\"";
      if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
        out << ",\"width\":" << par->width << ",\"height\":" << par->height;
        out << ",\"colorRange\":" << (int)par->color_range;
        out << ",\"colorPrimaries\":" << (int)par->color_primaries;
        out << ",\"colorTransfer\":" << (int)par->color_trc;
        out << ",\"colorMatrix\":" << (int)par->color_space;
      } else if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
        out << ",\"sampleRate\":" << par->sample_rate;
        out << ",\"channels\":" << par->ch_layout.nb_channels;
      }
      if (par->extradata && par->extradata_size > 0) {
        out << ",\"extradata\":\"" << b64(par->extradata, par->extradata_size) << "\"";
      }
      out << "}";
    }
  }
  out << "]}";
  std::string json = out.str();
  char* result = (char*)malloc(json.size() + 1);
  memcpy(result, json.c_str(), json.size() + 1);
  return result;
}

EMSCRIPTEN_KEEPALIVE
void demux_free_string(char* ptr) {
  free(ptr);
}

EMSCRIPTEN_KEEPALIVE
int demux_seek(int64_t timestamp_us) {
  if (!g.fmt) return -1;
  int ret = av_seek_frame(g.fmt, -1, timestamp_us, AVSEEK_FLAG_BACKWARD);
  if (ret >= 0) avformat_flush(g.fmt);
  if (g.audio_ctx) avcodec_flush_buffers(g.audio_ctx);
  if (g.packet) av_packet_unref(g.packet);
  return ret;
}

EMSCRIPTEN_KEEPALIVE
int demux_read_packet() {
  if (!g.fmt || !g.packet) return -1;
  av_packet_unref(g.packet);
  int ret = av_read_frame(g.fmt, g.packet);
  return ret >= 0 ? 1 : ret;
}

EMSCRIPTEN_KEEPALIVE int demux_packet_stream_index() { return g.packet ? g.packet->stream_index : -1; }
EMSCRIPTEN_KEEPALIVE int demux_packet_size() { return g.packet ? g.packet->size : 0; }
EMSCRIPTEN_KEEPALIVE uint8_t* demux_packet_data() { return g.packet ? g.packet->data : nullptr; }
EMSCRIPTEN_KEEPALIVE int demux_packet_keyframe() { return g.packet ? ((g.packet->flags & AV_PKT_FLAG_KEY) ? 1 : 0) : 0; }

static int64_t packet_time_us(int64_t value) {
  if (!g.packet || value == AV_NOPTS_VALUE || g.packet->stream_index < 0) return -9223372036854775807LL;
  AVStream* stream = g.fmt->streams[g.packet->stream_index];
  return av_rescale_q(value, stream->time_base, AV_TIME_BASE_Q);
}

EMSCRIPTEN_KEEPALIVE int64_t demux_packet_pts_us() { return packet_time_us(g.packet ? g.packet->pts : AV_NOPTS_VALUE); }
EMSCRIPTEN_KEEPALIVE int64_t demux_packet_dts_us() { return packet_time_us(g.packet ? g.packet->dts : AV_NOPTS_VALUE); }
EMSCRIPTEN_KEEPALIVE int64_t demux_packet_duration_us() { return packet_time_us(g.packet ? g.packet->duration : AV_NOPTS_VALUE); }

EMSCRIPTEN_KEEPALIVE
void demux_audio_close() {
  if (g.audio_frame) av_frame_free(&g.audio_frame);
  if (g.swr) swr_free(&g.swr);
  if (g.audio_ctx) avcodec_free_context(&g.audio_ctx);
  g.audio_stream = -1;
  g.audio_sample_rate = 0;
  g.audio_channels = 0;
  g.audio_samples = 0;
  g.audio_pcm.clear();
}

EMSCRIPTEN_KEEPALIVE
int demux_audio_open(int stream_index) {
  demux_audio_close();
  if (!g.fmt || stream_index < 0 || stream_index >= (int)g.fmt->nb_streams) return -1;
  AVStream* stream = g.fmt->streams[stream_index];
  AVCodecParameters* par = stream->codecpar;
  if (par->codec_type != AVMEDIA_TYPE_AUDIO) return -2;

  const AVCodec* codec = avcodec_find_decoder(par->codec_id);
  if (!codec) return -3;
  g.audio_ctx = avcodec_alloc_context3(codec);
  if (!g.audio_ctx) return -4;
  int ret = avcodec_parameters_to_context(g.audio_ctx, par);
  if (ret < 0) return ret;
  ret = avcodec_open2(g.audio_ctx, codec, nullptr);
  if (ret < 0) return ret;

  AVChannelLayout in_layout = g.audio_ctx->ch_layout;
  if (in_layout.nb_channels <= 0) av_channel_layout_default(&in_layout, par->ch_layout.nb_channels > 0 ? par->ch_layout.nb_channels : 2);
  AVChannelLayout out_layout;
  av_channel_layout_copy(&out_layout, &in_layout);

  g.audio_channels = out_layout.nb_channels;
  g.audio_sample_rate = g.audio_ctx->sample_rate;
  g.swr = swr_alloc();
  if (!g.swr) return -5;
  av_opt_set_chlayout(g.swr, "in_chlayout", &in_layout, 0);
  av_opt_set_int(g.swr, "in_sample_rate", g.audio_ctx->sample_rate, 0);
  av_opt_set_sample_fmt(g.swr, "in_sample_fmt", g.audio_ctx->sample_fmt, 0);
  av_opt_set_chlayout(g.swr, "out_chlayout", &out_layout, 0);
  av_opt_set_int(g.swr, "out_sample_rate", g.audio_sample_rate, 0);
  av_opt_set_sample_fmt(g.swr, "out_sample_fmt", AV_SAMPLE_FMT_FLT, 0);
  ret = swr_init(g.swr);
  av_channel_layout_uninit(&out_layout);
  if (ret < 0) return ret;

  g.audio_frame = av_frame_alloc();
  if (!g.audio_frame) return -6;
  g.audio_stream = stream_index;
  return 0;
}

EMSCRIPTEN_KEEPALIVE
int demux_audio_decode_current_packet() {
  g.audio_samples = 0;
  if (!g.audio_ctx || !g.swr || !g.audio_frame || !g.packet) return -1;
  if (g.packet->stream_index != g.audio_stream) return 0;

  int ret = avcodec_send_packet(g.audio_ctx, g.packet);
  if (ret < 0) return ret;

  ret = avcodec_receive_frame(g.audio_ctx, g.audio_frame);
  if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
  if (ret < 0) return ret;

  int out_samples = swr_get_out_samples(g.swr, g.audio_frame->nb_samples);
  if (out_samples <= 0) return 0;
  g.audio_pcm.assign((size_t)out_samples * (size_t)g.audio_channels, 0.0f);
  uint8_t* out_planes[1] = { reinterpret_cast<uint8_t*>(g.audio_pcm.data()) };
  int converted = swr_convert(g.swr, out_planes, out_samples, (const uint8_t**)g.audio_frame->extended_data, g.audio_frame->nb_samples);
  av_frame_unref(g.audio_frame);
  if (converted < 0) return converted;
  g.audio_samples = converted;
  g.audio_pcm.resize((size_t)converted * (size_t)g.audio_channels);
  return converted;
}

EMSCRIPTEN_KEEPALIVE float* demux_audio_pcm_ptr() { return g.audio_pcm.empty() ? nullptr : g.audio_pcm.data(); }
EMSCRIPTEN_KEEPALIVE int demux_audio_pcm_samples() { return g.audio_samples; }
EMSCRIPTEN_KEEPALIVE int demux_audio_pcm_channels() { return g.audio_channels; }
EMSCRIPTEN_KEEPALIVE int demux_audio_sample_rate() { return g.audio_sample_rate; }

}

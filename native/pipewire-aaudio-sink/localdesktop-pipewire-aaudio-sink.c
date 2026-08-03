// Local Desktop PipeWire standalone-client AAudio proof-of-concept sink.
//
// This is the native half of the standalone-client PipeWire/AAudio experiment:
// a normal PipeWire client process, not a PipeWire/SPA plugin. It registers an
// Audio/Sink node and writes received F32 interleaved audio to Android AAudio.

#include <aaudio/AAudio.h>
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <pipewire/pipewire.h>
#include <signal.h>
#include <spa/buffer/buffer.h>
#include <spa/param/audio/format-utils.h>
#include <spa/param/buffers.h>
#include <spa/utils/result.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DEFAULT_NODE_NAME "localdesktop-aaudio-sink"
#define DEFAULT_RATE 48000
#define DEFAULT_CHANNELS 2
#define DEFAULT_BUFFER_MS 120

struct app {
    struct pw_main_loop *loop;
    struct pw_stream *stream;

    void *aaudio_lib;
    struct {
        const char *(*convertResultToText)(aaudio_result_t);
        aaudio_result_t (*createStreamBuilder)(AAudioStreamBuilder **);
        void (*streamBuilder_delete)(AAudioStreamBuilder *);
        void (*streamBuilder_setDirection)(AAudioStreamBuilder *, aaudio_direction_t);
        void (*streamBuilder_setFormat)(AAudioStreamBuilder *, aaudio_format_t);
        void (*streamBuilder_setPerformanceMode)(AAudioStreamBuilder *, aaudio_performance_mode_t);
        void (*streamBuilder_setSharingMode)(AAudioStreamBuilder *, aaudio_sharing_mode_t);
        void (*streamBuilder_setSampleRate)(AAudioStreamBuilder *, int32_t);
        void (*streamBuilder_setChannelCount)(AAudioStreamBuilder *, int32_t);
        void (*streamBuilder_setDataCallback)(
            AAudioStreamBuilder *,
            AAudioStream_dataCallback,
            void *);
        void (*streamBuilder_setErrorCallback)(
            AAudioStreamBuilder *,
            AAudioStream_errorCallback,
            void *);
        aaudio_result_t (*streamBuilder_openStream)(AAudioStreamBuilder *, AAudioStream **);
        int32_t (*stream_getSampleRate)(AAudioStream *);
        int32_t (*stream_getChannelCount)(AAudioStream *);
        int32_t (*stream_getBufferSizeInFrames)(AAudioStream *);
        aaudio_result_t (*stream_requestStart)(AAudioStream *);
        aaudio_result_t (*stream_requestStop)(AAudioStream *);
        aaudio_result_t (*stream_close)(AAudioStream *);
    } aaudio_api;
    AAudioStream *aaudio;

    const char *node_name;
    uint32_t rate;
    uint32_t channels;
    uint32_t buffer_ms;
    size_t frame_bytes;

    float *ring;
    uint32_t ring_frames;
    atomic_uint_least64_t read_frame;
    atomic_uint_least64_t write_frame;
    atomic_uint_least64_t underrun_frames;
    atomic_uint_least64_t dropped_frames;
    atomic_bool drive_enabled;
};

static void usage(const char *argv0)
{
    fprintf(stderr,
        "Usage: %s [--node-name NAME] [--rate HZ] [--channels N] [--buffer-ms MS]\n",
        argv0);
}

static bool parse_u32(const char *value, uint32_t *out)
{
    char *end = NULL;
    unsigned long parsed = strtoul(value, &end, 10);
    if (value[0] == '\0' || end == NULL || *end != '\0' || parsed == 0 || parsed > UINT32_MAX)
        return false;
    *out = (uint32_t)parsed;
    return true;
}

static int parse_args(struct app *app, int argc, char *argv[])
{
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--node-name") == 0 && i + 1 < argc) {
            app->node_name = argv[++i];
        } else if (strcmp(argv[i], "--rate") == 0 && i + 1 < argc) {
            if (!parse_u32(argv[++i], &app->rate))
                return -EINVAL;
        } else if (strcmp(argv[i], "--channels") == 0 && i + 1 < argc) {
            if (!parse_u32(argv[++i], &app->channels))
                return -EINVAL;
        } else if (strcmp(argv[i], "--buffer-ms") == 0 && i + 1 < argc) {
            if (!parse_u32(argv[++i], &app->buffer_ms))
                return -EINVAL;
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            usage(argv[0]);
            return 1;
        } else {
            usage(argv[0]);
            return -EINVAL;
        }
    }
    return 0;
}

static int alloc_ring(struct app *app)
{
    uint64_t frames = ((uint64_t)app->rate * app->buffer_ms) / 1000;
    if (frames < 256)
        frames = 256;
    if (frames > UINT32_MAX)
        return -EINVAL;

    app->ring_frames = (uint32_t)frames;
    app->frame_bytes = sizeof(float) * app->channels;
    app->ring = calloc(app->ring_frames, app->frame_bytes);
    if (app->ring == NULL)
        return -errno;

    atomic_store(&app->read_frame, 0);
    atomic_store(&app->write_frame, 0);
    atomic_store(&app->underrun_frames, 0);
    atomic_store(&app->dropped_frames, 0);
    atomic_store(&app->drive_enabled, false);
    return 0;
}

static void ring_write(struct app *app, const float *src, uint32_t frames)
{
    uint64_t read = atomic_load_explicit(&app->read_frame, memory_order_acquire);
    uint64_t write = atomic_load_explicit(&app->write_frame, memory_order_relaxed);

    for (uint32_t i = 0; i < frames; i++) {
        if (write - read >= app->ring_frames) {
            read++;
            atomic_fetch_add_explicit(&app->dropped_frames, 1, memory_order_relaxed);
            atomic_store_explicit(&app->read_frame, read, memory_order_release);
        }

        uint32_t slot = (uint32_t)(write % app->ring_frames);
        memcpy(&app->ring[slot * app->channels], &src[i * app->channels], app->frame_bytes);
        write++;
    }

    atomic_store_explicit(&app->write_frame, write, memory_order_release);
}

static void ring_read(struct app *app, float *dst, uint32_t frames)
{
    uint64_t read = atomic_load_explicit(&app->read_frame, memory_order_relaxed);
    uint64_t write = atomic_load_explicit(&app->write_frame, memory_order_acquire);

    for (uint32_t i = 0; i < frames; i++) {
        if (read < write) {
            uint32_t slot = (uint32_t)(read % app->ring_frames);
            memcpy(&dst[i * app->channels], &app->ring[slot * app->channels], app->frame_bytes);
            read++;
        } else {
            memset(&dst[i * app->channels], 0, app->frame_bytes);
            atomic_fetch_add_explicit(&app->underrun_frames, 1, memory_order_relaxed);
        }
    }

    atomic_store_explicit(&app->read_frame, read, memory_order_release);
}

static aaudio_data_callback_result_t aaudio_data_callback(
    AAudioStream *stream,
    void *userdata,
    void *audio_data,
    int32_t num_frames)
{
    (void)stream;
    struct app *app = userdata;
    if (atomic_load_explicit(&app->drive_enabled, memory_order_acquire) && app->stream != NULL)
        pw_stream_trigger_process(app->stream);
    ring_read(app, audio_data, (uint32_t)num_frames);
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

static void aaudio_error_callback(AAudioStream *stream, void *userdata, aaudio_result_t error)
{
    (void)stream;
    struct app *app = userdata;
    const char *text = app->aaudio_api.convertResultToText != NULL
        ? app->aaudio_api.convertResultToText(error)
        : "unknown";
    fprintf(stderr, "[pipewire-aaudio-sink] AAudio error: %s\n", text);
}

static int load_aaudio(struct app *app)
{
    app->aaudio_lib = dlopen("libaaudio.so", RTLD_NOW | RTLD_LOCAL);
    if (app->aaudio_lib == NULL) {
        fprintf(stderr, "[pipewire-aaudio-sink] failed to dlopen libaaudio.so: %s\n", dlerror());
        return -ENOENT;
    }

#define LOAD_AAUDIO_FIELD(field, symbol) \
    do { \
        app->aaudio_api.field = dlsym(app->aaudio_lib, symbol); \
        if (app->aaudio_api.field == NULL) { \
            fprintf(stderr, "[pipewire-aaudio-sink] missing AAudio symbol %s: %s\n", symbol, dlerror()); \
            return -ENOSYS; \
        } \
    } while (0)

    LOAD_AAUDIO_FIELD(convertResultToText, "AAudio_convertResultToText");
    LOAD_AAUDIO_FIELD(createStreamBuilder, "AAudio_createStreamBuilder");
    LOAD_AAUDIO_FIELD(streamBuilder_delete, "AAudioStreamBuilder_delete");
    LOAD_AAUDIO_FIELD(streamBuilder_setDirection, "AAudioStreamBuilder_setDirection");
    LOAD_AAUDIO_FIELD(streamBuilder_setFormat, "AAudioStreamBuilder_setFormat");
    LOAD_AAUDIO_FIELD(streamBuilder_setPerformanceMode, "AAudioStreamBuilder_setPerformanceMode");
    LOAD_AAUDIO_FIELD(streamBuilder_setSharingMode, "AAudioStreamBuilder_setSharingMode");
    LOAD_AAUDIO_FIELD(streamBuilder_setSampleRate, "AAudioStreamBuilder_setSampleRate");
    LOAD_AAUDIO_FIELD(streamBuilder_setChannelCount, "AAudioStreamBuilder_setChannelCount");
    LOAD_AAUDIO_FIELD(streamBuilder_setDataCallback, "AAudioStreamBuilder_setDataCallback");
    LOAD_AAUDIO_FIELD(streamBuilder_setErrorCallback, "AAudioStreamBuilder_setErrorCallback");
    LOAD_AAUDIO_FIELD(streamBuilder_openStream, "AAudioStreamBuilder_openStream");
    LOAD_AAUDIO_FIELD(stream_getSampleRate, "AAudioStream_getSampleRate");
    LOAD_AAUDIO_FIELD(stream_getChannelCount, "AAudioStream_getChannelCount");
    LOAD_AAUDIO_FIELD(stream_getBufferSizeInFrames, "AAudioStream_getBufferSizeInFrames");
    LOAD_AAUDIO_FIELD(stream_requestStart, "AAudioStream_requestStart");
    LOAD_AAUDIO_FIELD(stream_requestStop, "AAudioStream_requestStop");
    LOAD_AAUDIO_FIELD(stream_close, "AAudioStream_close");

#undef LOAD_AAUDIO_FIELD
    return 0;
}

static int open_aaudio(struct app *app)
{
    AAudioStreamBuilder *builder = NULL;
    aaudio_result_t res;

    res = load_aaudio(app);
    if (res < 0)
        return res;

    res = app->aaudio_api.createStreamBuilder(&builder);
    if (res != AAUDIO_OK)
        return -EIO;

    app->aaudio_api.streamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
    app->aaudio_api.streamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
    app->aaudio_api.streamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    app->aaudio_api.streamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_SHARED);
    app->aaudio_api.streamBuilder_setSampleRate(builder, (int32_t)app->rate);
    app->aaudio_api.streamBuilder_setChannelCount(builder, (int32_t)app->channels);
    app->aaudio_api.streamBuilder_setDataCallback(builder, aaudio_data_callback, app);
    app->aaudio_api.streamBuilder_setErrorCallback(builder, aaudio_error_callback, app);

    res = app->aaudio_api.streamBuilder_openStream(builder, &app->aaudio);
    app->aaudio_api.streamBuilder_delete(builder);
    if (res != AAUDIO_OK)
        return -EIO;

    app->rate = (uint32_t)app->aaudio_api.stream_getSampleRate(app->aaudio);
    app->channels = (uint32_t)app->aaudio_api.stream_getChannelCount(app->aaudio);

    fprintf(stderr,
        "[pipewire-aaudio-sink] opened AAudio stream: rate=%u channels=%u buffer_frames=%d\n",
        app->rate,
        app->channels,
        app->aaudio_api.stream_getBufferSizeInFrames(app->aaudio));

    res = app->aaudio_api.stream_requestStart(app->aaudio);
    if (res != AAUDIO_OK)
        return -EIO;

    return 0;
}

static void close_aaudio(struct app *app)
{
    if (app->aaudio != NULL) {
        app->aaudio_api.stream_requestStop(app->aaudio);
        app->aaudio_api.stream_close(app->aaudio);
        app->aaudio = NULL;
    }
    if (app->aaudio_lib != NULL) {
        dlclose(app->aaudio_lib);
        app->aaudio_lib = NULL;
    }
}

static void on_stream_state_changed(
    void *userdata,
    enum pw_stream_state old,
    enum pw_stream_state state,
    const char *error)
{
    struct app *app = userdata;
    atomic_store_explicit(
        &app->drive_enabled,
        state == PW_STREAM_STATE_STREAMING,
        memory_order_release);
    fprintf(stderr,
        "[pipewire-aaudio-sink] stream state %s -> %s%s%s\n",
        pw_stream_state_as_string(old),
        pw_stream_state_as_string(state),
        error ? ": " : "",
        error ? error : "");
}

static void on_stream_param_changed(void *userdata, uint32_t id, const struct spa_pod *param)
{
    struct app *app = userdata;
    struct spa_audio_info info = { 0 };
    const struct spa_pod *params[2];
    uint8_t buffer[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    uint32_t buffer_frames;
    uint32_t buffer_bytes;
    int res;

    if (param == NULL || id != SPA_PARAM_Format)
        return;
    if (spa_format_parse(param, &info.media_type, &info.media_subtype) < 0)
        return;
    if (info.media_type != SPA_MEDIA_TYPE_audio || info.media_subtype != SPA_MEDIA_SUBTYPE_raw)
        return;
    if (spa_format_audio_raw_parse(param, &info.info.raw) < 0)
        return;

    fprintf(stderr,
        "[pipewire-aaudio-sink] negotiated PipeWire format: rate=%u channels=%u format=%u\n",
        info.info.raw.rate,
        info.info.raw.channels,
        info.info.raw.format);

    if (info.info.raw.rate != app->rate || info.info.raw.channels != app->channels) {
        fprintf(stderr,
            "[pipewire-aaudio-sink] warning: negotiated format differs from AAudio stream\n");
    }

    buffer_frames = app->rate / 100;
    if (buffer_frames < 256)
        buffer_frames = 256;
    buffer_bytes = buffer_frames * app->frame_bytes;

    params[0] = spa_pod_builder_add_object(
        &builder,
        SPA_TYPE_OBJECT_ParamBuffers,
        SPA_PARAM_Buffers,
        SPA_PARAM_BUFFERS_buffers,
        SPA_POD_CHOICE_RANGE_Int(8, 2, 16),
        SPA_PARAM_BUFFERS_blocks,
        SPA_POD_Int(1),
        SPA_PARAM_BUFFERS_size,
        SPA_POD_CHOICE_RANGE_Int(buffer_bytes, app->frame_bytes * 256, app->frame_bytes * 8192),
        SPA_PARAM_BUFFERS_stride,
        SPA_POD_Int((int32_t)app->frame_bytes),
        SPA_PARAM_BUFFERS_align,
        SPA_POD_Int(16),
        SPA_PARAM_BUFFERS_dataType,
        SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemPtr)));
    params[1] = spa_pod_builder_add_object(
        &builder,
        SPA_TYPE_OBJECT_ParamMeta,
        SPA_PARAM_Meta,
        SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_Header),
        SPA_PARAM_META_size,
        SPA_POD_Int(sizeof(struct spa_meta_header)));

    res = pw_stream_update_params(app->stream, params, 2);
    if (res < 0) {
        fprintf(stderr,
            "[pipewire-aaudio-sink] failed to update stream params: %s\n",
            spa_strerror(res));
    }
}

static void on_stream_process(void *userdata)
{
    struct app *app = userdata;
    struct pw_buffer *pw_buf;
    struct spa_buffer *buf;
    struct spa_data *data;
    uint32_t offset;
    uint32_t size;
    uint32_t frames;
    const float *samples;

    pw_buf = pw_stream_dequeue_buffer(app->stream);
    if (pw_buf == NULL) {
        pw_log_warn("out of buffers: %m");
        return;
    }

    buf = pw_buf->buffer;
    data = &buf->datas[0];
    if (data->data != NULL && data->chunk != NULL) {
        offset = data->chunk->offset;
        if (offset > data->maxsize)
            offset = data->maxsize;

        size = data->chunk->size;
        if (size > data->maxsize - offset)
            size = data->maxsize - offset;

        frames = size / app->frame_bytes;
        samples = (const float *)((const uint8_t *)data->data + offset);
        ring_write(app, samples, frames);
    }

    pw_stream_queue_buffer(app->stream, pw_buf);
}

static const struct pw_stream_events stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = on_stream_state_changed,
    .param_changed = on_stream_param_changed,
    .process = on_stream_process,
};

static void do_quit(void *userdata, int signal_number)
{
    (void)signal_number;
    struct app *app = userdata;
    pw_main_loop_quit(app->loop);
}

static int connect_pipewire(struct app *app)
{
    const struct spa_pod *params[1];
    uint32_t n_params = 0;
    uint8_t buffer[1024];
    char rate[32];
    char channels[32];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    struct pw_properties *props;
    int res;

    snprintf(rate, sizeof(rate), "%u", app->rate);
    snprintf(channels, sizeof(channels), "%u", app->channels);

    props = pw_properties_new(
        PW_KEY_MEDIA_CLASS,
        "Audio/Sink",
        PW_KEY_NODE_NAME,
        app->node_name,
        PW_KEY_NODE_DESCRIPTION,
        "Local Desktop AAudio Output",
        PW_KEY_NODE_DRIVER,
        "true",
        PW_KEY_NODE_SUSPEND_ON_IDLE,
        "false",
        PW_KEY_AUDIO_RATE,
        rate,
        PW_KEY_AUDIO_CHANNELS,
        channels,
        NULL);
    if (props == NULL)
        return -errno;

    app->stream = pw_stream_new_simple(
        pw_main_loop_get_loop(app->loop),
        app->node_name,
        props,
        &stream_events,
        app);
    if (app->stream == NULL)
        return -errno;

    params[n_params++] = spa_format_audio_raw_build(
        &builder,
        SPA_PARAM_EnumFormat,
        &SPA_AUDIO_INFO_RAW_INIT(
            .format = SPA_AUDIO_FORMAT_F32,
            .channels = app->channels,
            .rate = app->rate));

    res = pw_stream_connect(
        app->stream,
        PW_DIRECTION_INPUT,
        PW_ID_ANY,
        PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS | PW_STREAM_FLAG_DRIVER |
            PW_STREAM_FLAG_RT_PROCESS,
        params,
        n_params);
    if (res < 0)
        return res;

    return 0;
}

int main(int argc, char *argv[])
{
    struct app app = {
        .node_name = DEFAULT_NODE_NAME,
        .rate = DEFAULT_RATE,
        .channels = DEFAULT_CHANNELS,
        .buffer_ms = DEFAULT_BUFFER_MS,
    };
    int res;

    res = parse_args(&app, argc, argv);
    if (res > 0)
        return 0;
    if (res < 0)
        return 2;

    pw_init(&argc, &argv);
    app.loop = pw_main_loop_new(NULL);
    if (app.loop == NULL) {
        fprintf(stderr, "[pipewire-aaudio-sink] failed to create PipeWire main loop\n");
        return 1;
    }

    pw_loop_add_signal(pw_main_loop_get_loop(app.loop), SIGINT, do_quit, &app);
    pw_loop_add_signal(pw_main_loop_get_loop(app.loop), SIGTERM, do_quit, &app);

    res = open_aaudio(&app);
    if (res < 0) {
        fprintf(stderr, "[pipewire-aaudio-sink] failed to open AAudio stream: %d\n", res);
        goto done;
    }

    res = alloc_ring(&app);
    if (res < 0) {
        fprintf(stderr, "[pipewire-aaudio-sink] failed to allocate ring: %d\n", res);
        goto done;
    }

    res = connect_pipewire(&app);
    if (res < 0) {
        fprintf(stderr, "[pipewire-aaudio-sink] failed to connect PipeWire stream: %s\n",
            spa_strerror(res));
        goto done;
    }

    fprintf(stderr,
        "[pipewire-aaudio-sink] running node=%s rate=%u channels=%u ring_frames=%u\n",
        app.node_name,
        app.rate,
        app.channels,
        app.ring_frames);
    pw_main_loop_run(app.loop);

done:
    atomic_store(&app.drive_enabled, false);
    if (app.stream != NULL)
        pw_stream_destroy(app.stream);
    close_aaudio(&app);
    free(app.ring);
    if (app.loop != NULL)
        pw_main_loop_destroy(app.loop);
    pw_deinit();

    fprintf(stderr,
        "[pipewire-aaudio-sink] stopped underrun_frames=%" PRIuLEAST64
        " dropped_frames=%" PRIuLEAST64 "\n",
        atomic_load(&app.underrun_frames),
        atomic_load(&app.dropped_frames));

    return res < 0 ? 1 : 0;
}

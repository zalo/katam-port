/* The browser half of platform/port/backend.h.
 *
 * Everything in here was in platform/main.c until the native build needed the
 * same four hooks pointing somewhere else.  The bodies are unchanged.
 */

#include <string.h>

#include <emscripten.h>
#include <emscripten/html5.h>

#include "port/port.h"
#include "port/res.h"
#include "port/backend.h"
#include "port/audio.h"
#include "render/render_list.h"
#include "render/gl_renderer.h"

/* EM_JS bodies below call UTF8ToString.  emscripten 3.1.5x stopped linking
 * the runtime helpers in by default; without this the node build traps on
 * its first log line with "UTF8ToString is not defined". */
EM_JS_DEPS(katam_host_web, "$UTF8ToString");

/* Nothing to do: the page has the module configured before main() runs, and
 * the wasm memory map is reserved by the linker (-sGLOBAL_BASE), not at run
 * time.  See docs/ARCHITECTURE.md. */
/* --- the picture: one WebGL2 canvas, both renderers, the settings menu ----
 *
 * When the page offers a WebGL2 canvas (#gpu-screen, Module.portGl) the
 * picture always goes through it: the render list when the GPU renderer is
 * chosen (docs/RENDERER.md), the PPU's framebuffer as a texture otherwise --
 * so the settings menu (platform/ui, Dear ImGui) can draw over either.  No
 * WebGL2: the page's 2D canvas, as before, and no menu.  ?renderer=gpu|ppu
 * overrides the saved setting for one visit. */
#include "ui/settings.h"
#include "ui/ui.h"
#include "port/rollback.h"
#include "port/netsim.h"

static int sGl;

EM_JS(int, PortWebHaveGlCanvas, (void), {
    return Module.portGl ? 1 : 0;
});

/* -1: no override, else PS_RENDER_*. */
EM_JS(int, PortWebRendererParam, (void), {
    var r = Module.portRenderer;
    return r === 'gpu' ? 0 : r === 'ppu' ? 1 : -1;
});

/* Sunlight proof of concept (render/light.c): a page served from .../lighting/
 * or with ?lighting=1.  1 on, 0 off. */
EM_JS(int, PortWebLightingParam, (void), {
    try {
        var q = new URLSearchParams(location.search);
        if (q.get('lighting') === '1') return 1;
        var p = location.pathname, i = p.lastIndexOf('/');
        p = p.substring(0, i);
        if (p.substring(p.lastIndexOf('/') + 1) === 'lighting') return 1;
    } catch (e) {}
    return 0;
});

/* ?normals=1: lit frames show their normal maps (render/relief_glsl.h);
 * 2 and 3: the relief atlas's sprite art and sprite normals, pixel for pixel;
 * 4: the shadow map. */
EM_JS(int, PortWebNormalsParam, (void), {
    try { var n = parseInt(new URLSearchParams(location.search).get('normals') || '0', 10);
          return n >= 1 && n <= 4 ? n : 0; }
    catch (e) { return 0; }
});

EM_JS(void, PortWebLoadSettings, (char *buf, int size), {
    var t = '';
    try { t = localStorage.getItem('katam.settings') || ''; } catch (e) { t = ''; }
    stringToUTF8(t, buf, size);
});

void PortHostSaveSettings(const char *text)
{
    EM_ASM({
        try { localStorage.setItem('katam.settings', UTF8ToString($0)); } catch (e) {}
    }, text);
}

void PortHostSetVolume(float gain)
{
    EM_ASM({
        Module.portVolume = $0;
        var pa = Module.portAudio;
        if (pa && pa.gain) pa.gain.gain.value = $0;
    }, gain);
}

void PortHostSetVsync(int on)
{
    (void)on;           /* the browser presents on its own refresh */
}

void PortHostUiOpenChanged(int open)
{
    EM_ASM({ if (Module.portUiOpenChanged) Module.portUiOpenChanged($0); }, open);
}

EM_JS(int, PortWebCoarsePointer, (void), {
    try { return (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) ? 1 : 0; }
    catch (e) { return 0; }
});

static void PortWebGlInit(void)
{
    EmscriptenWebGLContextAttributes attr;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx;
    int gpuOk;

    emscripten_webgl_init_context_attributes(&attr);
    attr.majorVersion = 2;
    attr.minorVersion = 0;
    attr.alpha = 0;
    attr.depth = 0;
    attr.stencil = 0;
    attr.antialias = 0;
    attr.preserveDrawingBuffer = 0;
    attr.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
    ctx = emscripten_webgl_create_context("#gpu-screen", &attr);
    if (ctx <= 0) {
        PortError("[katam-port] no WebGL2 context (%d) -- 2D canvas, no settings menu",
                  (int)ctx);
        EM_ASM({ if (Module.portGlFailed) Module.portGlFailed(); });
        return;
    }
    emscripten_webgl_make_context_current(ctx);
    gpuOk = GlrInit(NULL, 1);
    if (!gpuOk) {
        PortError("[katam-port] gpu: renderer did not start -- 2D canvas, no settings menu");
        EM_ASM({ if (Module.portGlFailed) Module.portGlFailed(); });
        return;
    }
    sGl = 1;
    gPortShowDisplayRate = 1;   /* PortAwaitAnimationFrame paints every rAF */
    gPortUiStatus.platform = "web";
    gPortUiStatus.touch = PortWebCoarsePointer();
    gPortUiStatus.vsyncControl = 0;
    gPortUiStatus.drawGear = 0;         /* the page has its own button */
    PortShowInit(1, gpuOk);
}

void PortHostInit(int argc, char **argv)
{
    char buf[1024];
    int r;

    (void)argc;
    (void)argv;
    PortSettingsDefaults(&gPortSettings);
    PortWebLoadSettings(buf, sizeof(buf));
    PortSettingsParse(&gPortSettings, buf);
    r = PortWebRendererParam();
    if (r >= 0)
        gPortSettings.renderer = r;
    PortSettingsApplyEarly();
    gPortLightingDefault = PortWebLightingParam();
    gPortReliefView = PortWebNormalsParam();
    PortLightResolve();
    if (gPortLighting)
        PortLog("[katam-port] lighting: on (Rainbow Route sunlight, proof of concept; Settings > Display > Lighting)");
    if (PortWebHaveGlCanvas())
        PortWebGlInit();
}

/* The menu's Game / Online / Randomizer / Advanced pages: the page owns
 * all of it (web/shell.html, Module.portUiAction and Module.portUiQuery).
 * Called from inside the menu's frame -- the frame that handled the click,
 * which is what lets an action open a file picker or go fullscreen. */
EM_JS(int, PortHostUiAction, (const char *name, int arg), {
    var f = Module.portUiAction;
    if (!f) return 0;
    try { return f(UTF8ToString(name), arg) ? 1 : 0; }
    catch (e) { console.error('[katam-port] menu action', e); return 0; }
});

EM_JS(int, PortHostUiQuery, (const char *key, char *buf, int size), {
    var f = Module.portUiQuery, v = '';
    if (f) { try { v = f(UTF8ToString(key)); } catch (e) { v = ''; } }
    if (v === undefined || v === null) v = '';
    return stringToUTF8(String(v), buf, size);
});

/* For the page: its own gear button and keyboard. */
EMSCRIPTEN_KEEPALIVE int PortUiIsOpenJs(void) { return PortUiIsOpen(); }

/* For comparing looks on one picture (tools, the console):
 * Module._PortWebFreeze(1) holds the game on its frame, as the menu's pause
 * does, and keeps presenting it; Module.ccall('PortWebSetting', null,
 * ['string'], ['lightrelief=0']) applies settings lines as the menu would. */
static int sFreeze;
EMSCRIPTEN_KEEPALIVE void PortWebFreeze(int on) { sFreeze = on; }
EMSCRIPTEN_KEEPALIVE void PortWebSetting(const char *text)
{
    PortSettingsParse(&gPortSettings, text);
    PortSettingsClamp(&gPortSettings);
    PortSettingsChanged();
}

/* The playtest page (web/playtest/): a room bundle compiled in the browser.
 * Set before the ROM handshake releases main(), so the session build links
 * it; reload re-links one mid-session (local only) -- the page warps next. */
EMSCRIPTEN_KEEPALIVE void PortResSetRoomBundle(const u8 *data, u32 size) { Res_SetRoomBundleMemory(data, size); }
EMSCRIPTEN_KEEPALIVE int PortResReloadRooms(const u8 *data, u32 size) { return Res_ReloadRooms(data, size); }
/* Pictures drawn and frames simulated per second (the menu's numbers), for
 * a test harness checking that paints between frames are being drawn. */
EMSCRIPTEN_KEEPALIVE double PortWebDrawRateJs(void) { return gPortUiStatus.drawFps; }
EMSCRIPTEN_KEEPALIVE double PortWebSimRateJs(void) { return gPortUiStatus.simFps; }

/* Everything the port says goes to two places: the browser console, and the
 * page's own log.
 *
 * emscripten_console_log calls console.log directly, which is right for
 * devtools and useless for a bug report -- the crash panel builds its report
 * from the page log, so the port's own diagnostics were the one thing missing
 * from the report that exists to carry them.  Someone hitting a crash on a
 * phone has no console at all.
 *
 * Module.portDiag is optional: the headless harness does not define it. */
EM_JS(void, PortConsole, (const char *s, int isErr), {
    var text = UTF8ToString(s);
    if (isErr) console.error(text); else console.log(text);
    if (Module.portDiag) {
        try { Module.portDiag(text, isErr); } catch (e) { /* never break logging */ }
    }
});

/* One game frame per requestAnimationFrame is only right on a 60 Hz panel.
 * rAF fires at the monitor's refresh rate, so a 120 Hz display used to run
 * the game at double speed.  Ticks are waited out until the GBA's own frame
 * period has elapsed instead -- 59.7275 Hz, the same constant and the same
 * reasoning as the native host's PaceFrame: the game's clock is the one
 * that matters, and the audio clock fights anything else.
 *
 * The deadline accumulates in fractional milliseconds so the average rate
 * is exact on any refresh rate.  On a 60 Hz panel that means one repeated
 * frame every few seconds -- the 0.46% by which 60 Hz outruns the GBA,
 * paid in the open instead of by the audio queue; and two netplay peers on
 * different monitors advance at the same rate instead of one perpetually
 * predicting the other.  After a stall (hidden tab, suspend) the deadline
 * re-anchors to the clock rather than sprinting through the gap.
 *
 * The other direction matters just as much: browsers also deliver rAF
 * SLOWER than the panel -- Chrome's Energy Saver and macOS Low Power Mode
 * throttle it to 30 Hz outright -- and waiting out a tick that is already
 * overdue turned that into a half-speed game, which reads as "super laggy"
 * rather than as the frame-rate cut it is.  So lateness up to a small debt
 * ceiling is repaid, not forgiven: a frame whose deadline has already
 * passed runs immediately, no vsync wait, at most three in a row so the
 * event loop (sockets, input) always breathes.  At 30 Hz rAF that is two
 * game frames per paint -- correct speed, half the drawn frames.  Only a
 * gap past the ceiling (a real stall: tab hidden, machine asleep)
 * re-anchors and lets the lost time go.
 *
 * A hidden tab gets no rAF at all -- browsers stop it dead -- which used to
 * stop the game dead too.  Alone that was fine; in netplay it starves the
 * other player: cover one of two windows and the visible one drowns in
 * communication errors.  So a hidden tab paces itself off the timer clock
 * at the same 59.7275 Hz.  (Browsers exempt audibly-playing tabs from
 * timer throttling, and the game plays audio; a *muted* hidden tab still
 * winds down to ~1 Hz, which nothing here can help.)  The 250 ms guard
 * only bridges the transition: a wait that began visible would otherwise
 * sleep until the tab is looked at again.
 *
 * Headless (no `document`) means the node harness: one plain rAF await per
 * frame, unpaced -- tests outrun the clock, and always have -- and none of
 * the timers above, because the rollback tests pause an instance by parking
 * its rAF registrations, and a guard timer firing from outside any
 * instance's execution window re-registers on the wrong ledger.
 *
 * Interpolation (`interp`): a paint that comes before the next frame is due
 * returns 1 instead of being waited through, so the caller can draw the
 * in-between picture for it (platform/ui/present.c) and call again; the
 * call after that picks the wait up where it left off.  0: run the frame.
 * Only visible-tab paints do this -- nothing is drawn for a hidden one. */
EM_ASYNC_JS(int, PortWebAwaitFrame, (int interp), {
    if (typeof document === 'undefined') {
        await new Promise(function (resolve) { requestAnimationFrame(resolve); });
        return 0;
    }
    /* Fast-forward (the playtest page's boot): no pacing, a yield to the
     * page every 8 frames so it stays responsive; then the clock restarts. */
    if (Module.portTurbo && Module.portTurbo()) {
        Module.portFrameDue = 0;
        if (((Module.portTurboN = (Module.portTurboN || 0) + 1) & 7) === 0)
            await new Promise(function (resolve) { setTimeout(resolve, 0); });
        return 0;
    }
    var PERIOD = 1000 / 59.7275;
    var due = Module.portFrameDue || 0;
    var st = Module.portPace ||
        (Module.portPace = { t0: 0, sims: 0, waits: 0, catchups: 0,
                             skips: 0, cpuMax: 0, lastExit: 0 });
    /* Every five seconds, one summary -- and only when something is off
     * (heavy catch-up use, or a game running slow), so a healthy session
     * logs nothing.  This is the line a lag report needs: it separates "the
     * browser starves us of vsyncs" from "the frames themselves are slow". */
    var report = Module.portPaceLine || (Module.portPaceLine = function (s, t) {
        if (!s.t0) { s.t0 = t; return; }
        var secs = (t - s.t0) / 1000;
        if (secs < 5) return;
        var sims = s.sims / secs;
        if (s.catchups / secs > 5 || sims < 55)
            console.log('[katam-port] pace: ' + sims.toFixed(1) + ' frames/s, '
                + (s.waits / secs).toFixed(1) + ' vsync waits/s, '
                + s.catchups + ' catch-up frames, worst frame cpu '
                + s.cpuMax.toFixed(1) + ' ms'
                + (sims > 55 && s.waits / secs < 50
                   ? ' -- the browser is throttling animation (power saver?); '
                     + 'speed kept by extra frames between paints'
                   : ''));
        s.t0 = t; s.sims = 0; s.waits = 0; s.catchups = 0; s.cpuMax = 0;
    });
    var now = performance.now();
    var resumed = Module.portPaceWaiting;
    Module.portPaceWaiting = 0;
    /* A resumed wait (interpolation) is the same frame: no new counting. */
    if (!resumed) {
        if (st.lastExit && now - st.lastExit > st.cpuMax)
            st.cpuMax = now - st.lastExit;
        st.sims++;

        /* The catch-up path: a full frame of real debt, not a stall's worth,
         * and the last two frames were not themselves catch-ups.  The threshold
         * matters: at `due - 2` this fired during ordinary vsync pacing
         * whenever a frame's own work ran long enough, and at a 59.94 Hz-family
         * refresh that meant a burst of skip/double oscillation each time the
         * GBA clock's phase drifted across a vsync boundary -- the painted rate
         * halved for a second or two every beat period (~5 s) while the game's
         * speed stayed perfect, so nothing logged.  A throttled browser
         * accumulates a frame of debt every frame and clears the bar
         * immediately; vsync pacing never does. */
        if (due > 0 && st.skips < 3 && now >= due + PERIOD && now <= due + 8 * PERIOD) {
            st.skips++;
            st.catchups++;
            Module.portFrameDue = due + PERIOD;
            report(st, now);
            st.lastExit = performance.now();
            return 0;
        }
        st.skips = 0;
    }
    for (;;) {
        if (document.hidden) {
            await new Promise(function (resolve) { setTimeout(resolve, 4); });
            now = performance.now();
        } else {
            now = await new Promise(function (resolve) {
                var guard = setTimeout(function () { resolve(-1); }, 250);
                requestAnimationFrame(function (t) {
                    clearTimeout(guard);
                    resolve(t);
                });
            });
            if (now < 0)
                continue;
            st.waits++;
            if (now < due - 2 && interp) {
                Module.portPaceWaiting = 1;
                return 1;
            }
        }
        if (now >= due - 2)
            break;
    }
    /* Lateness within the debt ceiling carries forward -- the catch-up path
     * above repays it next frame.  Only a real stall lets the time go. */
    Module.portFrameDue = (now > due + 8 * PERIOD) ? now + PERIOD : due + PERIOD;
    report(st, now);
    st.lastExit = performance.now();
    return 0;
});

/* When the frame that just ran was due on that schedule. */
EM_JS(double, PortWebFrameDueMs, (void), {
    return (Module.portFrameDue || 0) - 1000 / 59.7275;
});

/* setTimeout(0), not requestAnimationFrame: a hidden tab throttles rAF to
 * nothing, and a catch-up that happens to run in a background tab should not
 * take a thousand times longer there.  The clamp on nested zero timeouts (~1
 * ms after the first few) is why PortPresentFrame calls this rarely rather
 * than every caught-up frame. */
EM_ASYNC_JS(void, PortAwaitYield, (void), {
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
});

EM_JS(void, PortWebPresent, (const u32 *pixels, int w, int h), {
    if (Module.portPresent)
        Module.portPresent(pixels, w, h);
});

EM_JS(void, PortWebCanvasInfo, (int *out), {
    var c = Module.portGlCanvas;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (Module.portFitCanvas) Module.portFitCanvas();
    HEAP32[out >> 2] = c ? c.width : 1;
    HEAP32[(out >> 2) + 1] = c ? c.height : 1;
    HEAPF32[(out >> 2) + 2] = dpr;
});

/* A paint's worth of waiting while the game is paused for the menu. */
EM_ASYNC_JS(void, PortWebAwaitPaint, (void), {
    await new Promise(function (resolve) {
        if (typeof document !== 'undefined' && document.hidden) setTimeout(resolve, 50);
        else requestAnimationFrame(function () { resolve(); });
    });
});

static void Show(const u32 *pixels, int w, int h, int fresh)
{
    int info[3];
    float dpr;

    PortWebCanvasInfo(info);
    memcpy(&dpr, &info[2], sizeof(dpr));
    if (fresh && PortWebFrameDueMs() > 0.0)
        PortShowFrameDue(PortWebFrameDueMs());
    if (fresh)
        PortShowNewFrame(info[0], info[1], dpr, emscripten_get_now(), pixels, w, h);
    else
        PortShowAgain(info[0], info[1], dpr, emscripten_get_now());
}

void PortBlitFramebuffer(const u32 *pixels, int w, int h)
{
    if (sGl) {
        Show(pixels, w, h, 1);
        PortWebPresent(pixels, 0, 0);       /* the page's frame counter */
        return;
    }
    PortWebPresent(pixels, w, h);
}

extern void m4aSoundMain(void);
extern void m4aSoundVSync(void);

/* Sound that keeps time when the game does not.
 *
 * The game makes one block of sound per frame, so a frame that arrives late
 * leaves the speakers with nothing -- and a device that only manages 40 frames
 * a second leaves them with nothing twenty times a second.  When the queue is
 * a whole block behind, the sound driver alone is run again to make up the
 * difference: it is a few percent of a frame's work, and the music and any
 * effect already playing carry on at their proper speed while the picture
 * catches up.  The game itself is not stepped, so nothing it decides changes;
 * a song simply reaches its end a little sooner in game frames than it would
 * have.  Only with a live device (never headless, where runs must repeat
 * exactly), never online, and at most twice per frame. */
EM_JS(int, PortAudioLive, (void), {
    var pa = Module.portAudio;
    return (pa && pa.queued && pa.rep && pa.ctx && pa.ctx.state === 'running'
            && !(Module.portTurbo && Module.portTurbo())) ? 1 : 0;
});

static void AudioTopUp(void)
{
    int n;

    if (!PortAudioLive())
        return;
    for (n = 0; n < 2 && PortAudioStarving(); n++) {
        m4aSoundMain();
        m4aSoundVSync();
    }
}

/* The menu pause: a host-level frame skip -- the game is not asked for its
 * next frame while the menu is open, and the last picture is re-presented
 * under it.  Not online (either session driver), where a peer would stall. */
void PortAwaitAnimationFrame(void)
{
    int online = PortRbActive() || PortNetActive();

    while (sGl && (PortUiIsOpen() || sFreeze) && !online) {
        PortWebAwaitPaint();
        Show(NULL, 0, 0, 0);
    }
    gPortUiStatus.netplay = online;
    if (!online)
        AudioTopUp();
    /* Paints between frames show the interpolated picture. */
    while (PortWebAwaitFrame(sGl && gPortShowDisplayRate && gPortSettings.interp
                             && PortShowUsingGpu()) == 1)
        Show(NULL, 0, 0, 0);
}

/* The stall-loop pump (port/backend.h).  The page wires portNetIdle to the
 * netplay driver's receive-queue flush; a page without netplay never
 * defines it and the loop just yields. */
EM_JS(void, PortNetIdle, (void), {
    if (Module.portNetIdle) {
        try { Module.portNetIdle(); } catch (e) { /* never break the loop */ }
    }
});

EM_ASYNC_JS(void, PortAwaitRom, (void), {
    await Module.portRomReady;
});

/* The port's own C data, above the reserved map and below the end of linear
 * memory.  DmaFill passes the address of a local holding the fill value, so a
 * perfectly ordinary transfer has a source up here -- reading the bound from
 * the module rather than hardcoding it keeps this honest if INITIAL_MEMORY
 * changes. */
int PortHostRangeOk(uintptr_t addr, u32 len)
{
    return addr >= PORT_GLOBAL_BASE
        && addr + len <= (uintptr_t)__builtin_wasm_memory_size(0) * 65536u;
}

/* --- the determinism harness (platform/inputlog.c) ----------------------- */

/* Module.portFrameState(frame, keys, sim, vid, sram, pix, dumpPtr, dumpLen), if the
 * page or harness defined one.  The dump is only valid during the call. */
EM_JS(void, PortWebFrameState, (u32 frame, u32 keys, u32 sim, u32 vid, u32 sram,
                                u32 pix, const u8 *dump, u32 dumpLen), {
    if (Module.portFrameState)
        Module.portFrameState(frame, keys, sim >>> 0, vid >>> 0, sram >>> 0,
                              pix >>> 0, dump, dumpLen);
});

void PortHostFrameState(u32 frame, u16 keys, const u32 *hashes,
                        const u8 *dump, u32 dumpLen)
{
    PortWebFrameState(frame, keys, hashes[0], hashes[1], hashes[2], hashes[3],
                      dump, dumpLen);
}

/* A wasm function pointer is a table index -- a small integer -- and nothing
 * distinguishes it from any other small integer in game memory, so there is
 * nothing to canonicalise here.  See platform/native/symtab.c. */
u32 PortHostCanonWord(u32 w)
{
    return w;
}

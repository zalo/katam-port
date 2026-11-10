/* The game's menu: a Dear ImGui view over gPortSettings (settings.h), and
 * on the web page everything else the page can do (the ROM and save files,
 * fullscreen, touch pads, the randomizer, the log), driven
 * through the host's action/readout hooks (ui.h, web/shell.html).
 *
 * Drawn into the game's own GL context after the picture (present.c), in
 * framebuffer pixels.  Built for a thumb first: everything scales with the
 * device pixel ratio (and more on a coarse pointer), the body scrolls by
 * dragging, and a touch is only turned into a press once it is clearly a
 * tap, a hold or a sideways drag (a slider) -- a vertical swipe scrolls
 * instead of pressing whatever it started on.
 */

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "imgui.h"

extern "C" {
void PortLog(const char *fmt, ...);
void PortError(const char *fmt, ...);
#include "ui/settings.h"
#include "ui/ui.h"
extern int gPortLighting;   /* render/render_list.h: the effective switch */
}
#include "ui/ui_internal.h"

#if defined(__has_include)
#if __has_include("build_label.h")
#include "build_label.h"
#endif
#endif
#ifndef KATAM_BUILD_LABEL
#define KATAM_BUILD_LABEL "dev build"
#endif

extern "C" {
PortUiStatus gPortUiStatus;
}

static int sReady, sOpen, sOpenFrames;
static int sEs;
static float sFontPx;           /* atlas built at this size */
static double sNow, sLast;

/* Touch gesture state, in framebuffer pixels. */
static int sTouchDown, sTouchPending, sTouchMode;   /* mode: 0 ?, 1 scroll, 2 press */
static float sTouchX0, sTouchY0, sTouchLastY;
static double sTouchT0;
static float sScrollPx;
#define TOUCH_SLOP_PX (10.0f * sTouchScale)
#define TOUCH_HOLD_MS 350.0
static float sTouchScale = 1.0f;

void UiLogError(const char *msg)
{
    PortError("[katam-port] ui: %s", msg);
}

extern "C" int PortUiInit(int es)
{
    sEs = es;
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO &io = ImGui::GetIO();
    io.IniFilename = NULL;
    io.LogFilename = NULL;
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.BackendRendererName = "katam_gl3";
    io.BackendPlatformName = "katam_host";
    if (!UiGlInit(es))
        return 0;
    sReady = 1;
    PortLog("[katam-port] settings menu ready (Dear ImGui %s) -- F1 or Tab opens it",
            IMGUI_VERSION);
    return 1;
}

extern "C" int PortUiIsOpen(void) { return sOpen; }

extern "C" void PortUiSetOpen(int open)
{
    open = !!open;
    if (open == sOpen)
        return;
    sOpen = open;
    sOpenFrames = 0;
    sTouchDown = sTouchPending = 0;
    sTouchMode = 0;
    if (sReady) {
        ImGuiIO &io = ImGui::GetIO();
        io.AddMouseButtonEvent(0, false);
        io.ClearInputKeys();
    }
    PortHostUiOpenChanged(open);
}

extern "C" void PortUiToggle(void) { PortUiSetOpen(!sOpen); }

/* --- input ---------------------------------------------------------------- */

static void Source(int touch)
{
    ImGui::GetIO().AddMouseSourceEvent(touch ? ImGuiMouseSource_TouchScreen
                                             : ImGuiMouseSource_Mouse);
}

static void BeginPress(float x, float y)
{
    ImGuiIO &io = ImGui::GetIO();

    Source(1);
    io.AddMousePosEvent(x, y);
    io.AddMouseButtonEvent(0, true);
    sTouchMode = 2;
    sTouchPending = 0;
}

extern "C" void PortUiPointer(int kind, float x, float y, int touch)
{
    if (!sReady)
        return;
    ImGuiIO &io = ImGui::GetIO();

    if (!touch) {
        Source(0);
        io.AddMousePosEvent(x, y);
        if (kind == PORT_UI_DOWN) io.AddMouseButtonEvent(0, true);
        if (kind == PORT_UI_UP || kind == PORT_UI_CANCEL) io.AddMouseButtonEvent(0, false);
        return;
    }
    switch (kind) {
    case PORT_UI_DOWN:
        sTouchDown = 1;
        sTouchPending = 1;
        sTouchMode = 0;
        sTouchX0 = x; sTouchY0 = y; sTouchLastY = y;
        sTouchT0 = sNow;
        Source(1);
        io.AddMousePosEvent(x, y);
        break;
    case PORT_UI_MOVE:
        if (!sTouchDown)
            break;
        if (sTouchPending) {
            float dx = fabsf(x - sTouchX0), dy = fabsf(y - sTouchY0);

            if (dy > TOUCH_SLOP_PX && dy >= dx) {
                sTouchMode = 1;
                sTouchPending = 0;
            } else if (dx > TOUCH_SLOP_PX) {
                BeginPress(sTouchX0, sTouchY0);
            }
        }
        if (sTouchMode == 1) {
            sScrollPx += y - sTouchLastY;
        } else if (sTouchMode == 2) {
            Source(1);
            io.AddMousePosEvent(x, y);
        }
        sTouchLastY = y;
        break;
    case PORT_UI_UP:
    case PORT_UI_CANCEL:
        if (!sTouchDown)
            break;
        if (sTouchPending && kind == PORT_UI_UP) {
            BeginPress(sTouchX0, sTouchY0);     /* a tap */
        }
        if (sTouchMode == 2) {
            Source(1);
            io.AddMouseButtonEvent(0, false);
        }
        sTouchDown = sTouchPending = 0;
        sTouchMode = 0;
        break;
    }
}

extern "C" void PortUiWheel(float dx, float dy)
{
    if (!sReady)
        return;
    ImGui::GetIO().AddMouseWheelEvent(dx, dy);
}

extern "C" void PortUiKey(int key, int down)
{
    static const ImGuiKey kMap[] = {
        ImGuiKey_None, ImGuiKey_Tab, ImGuiKey_LeftArrow, ImGuiKey_RightArrow,
        ImGuiKey_UpArrow, ImGuiKey_DownArrow, ImGuiKey_PageUp, ImGuiKey_PageDown,
        ImGuiKey_Home, ImGuiKey_End, ImGuiKey_Enter, ImGuiKey_Escape,
        ImGuiKey_Space, ImGuiKey_Backspace,
    };
    if (!sReady || key <= 0 || key >= (int)(sizeof(kMap) / sizeof(kMap[0])))
        return;
    if (key == PORT_UIK_ESCAPE && down && sOpen) {
        PortUiSetOpen(0);
        return;
    }
    ImGui::GetIO().AddKeyEvent(kMap[key], down != 0);
}

/* --- style ---------------------------------------------------------------- */

static void SetupStyle(float scale)
{
    ImGuiStyle &st = ImGui::GetStyle();
    st = ImGuiStyle();
    ImGui::StyleColorsDark(&st);
    st.WindowRounding = 8.0f;
    st.FrameRounding = 5.0f;
    st.GrabRounding = 5.0f;
    st.WindowPadding = ImVec2(12, 10);
    st.FramePadding = ImVec2(10, gPortUiStatus.touch ? 8 : 5);
    st.ItemSpacing = ImVec2(8, gPortUiStatus.touch ? 9 : 6);
    st.ItemInnerSpacing = ImVec2(8, 6);
    st.ScrollbarSize = gPortUiStatus.touch ? 18 : 14;
    st.GrabMinSize = gPortUiStatus.touch ? 22 : 12;
    st.TouchExtraPadding = gPortUiStatus.touch ? ImVec2(2, 2) : ImVec2(0, 0);
    st.Colors[ImGuiCol_WindowBg] = ImVec4(0.08f, 0.09f, 0.11f, 0.96f);
    st.Colors[ImGuiCol_Header] = ImVec4(0.17f, 0.21f, 0.29f, 1.0f);
    st.Colors[ImGuiCol_HeaderHovered] = ImVec4(0.23f, 0.30f, 0.42f, 1.0f);
    st.Colors[ImGuiCol_Button] = ImVec4(0.17f, 0.20f, 0.26f, 1.0f);
    st.Colors[ImGuiCol_ButtonHovered] = ImVec4(0.25f, 0.33f, 0.47f, 1.0f);
    st.Colors[ImGuiCol_ButtonActive] = ImVec4(0.30f, 0.44f, 0.66f, 1.0f);
    st.ScaleAllSizes(scale);
}

static void EnsureScale(float dpr)
{
    float base = dpr * gPortSettings.uiScale * (gPortUiStatus.touch ? 1.2f : 1.15f);
    float px;

    if (base < 1.0f) base = 1.0f;
    if (base > 8.0f) base = 8.0f;
    /* ProggyClean is drawn on a 13-px grid; whole (and half) multiples stay
     * close to crisp. */
    px = 13.0f * floorf(base * 2.0f + 0.5f) * 0.5f;
    if (px < 13.0f) px = 13.0f;
    if (px == sFontPx)
        return;
    ImGuiIO &io = ImGui::GetIO();
    ImFontConfig cfg;
    cfg.SizePixels = px;
    cfg.OversampleH = cfg.OversampleV = 1;
    cfg.PixelSnapH = true;
    io.Fonts->Clear();
    io.Fonts->AddFontDefault(&cfg);
    UiGlRebuildFont();
    SetupStyle(px / 13.0f);
    sTouchScale = px / 13.0f;
    sFontPx = px;
}

/* --- the menu ------------------------------------------------------------- */

static bool Radio(const char *label, int *v, int value)
{
    return ImGui::RadioButton(label, v, value);
}

/* SameLine only if `next` still fits on this line: a phone in portrait gets
 * one option per row instead of labels running off the panel. */
static void SameLineIfFits(const char *next)
{
    float w = ImGui::GetFrameHeight() + ImGui::GetStyle().ItemInnerSpacing.x
            + ImGui::CalcTextSize(next).x;
    float x = ImGui::GetItemRectMax().x + ImGui::GetStyle().ItemSpacing.x;
    float right = ImGui::GetWindowPos().x + ImGui::GetWindowContentRegionMax().x;
    if (x + w <= right)
        ImGui::SameLine();
}

static void Hint(const char *text)
{
    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.62f, 0.66f, 0.72f, 1.0f));
    ImGui::TextWrapped("%s", text);
    ImGui::PopStyleColor();
}

static void Warn(const char *text)
{
    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.93f, 0.72f, 0.25f, 1.0f));
    ImGui::TextWrapped("%s", text);
    ImGui::PopStyleColor();
}

static bool Section(const char *label)
{
    ImGui::Spacing();
    return ImGui::CollapsingHeader(label, ImGuiTreeNodeFlags_DefaultOpen);
}

/* --- what the host owns: actions and readouts (ui.h) ----------------------- */

#ifndef __EMSCRIPTEN__
/* Native: the ROM is chosen at start-up and the save is a file next to it;
 * nothing here is the menu's to drive (platform/native/host_sdl.c). */
extern "C" int PortHostUiAction(const char *name, int arg) { (void)name; (void)arg; return 0; }
extern "C" int PortHostUiQuery(const char *key, char *buf, int size)
{
    (void)key;
    if (size > 0) buf[0] = '\0';
    return 0;
}
#endif

static bool Web(void)
{
    return gPortUiStatus.platform && strcmp(gPortUiStatus.platform, "web") == 0;
}

/* A readout from the host.  A small ring of buffers, so a few can be in use
 * at once within one line of the menu. */
static const char *Q(const char *key)
{
    static char ring[8][512];
    static int at;
    char *b = ring[at++ & 7];
    b[0] = '\0';
    PortHostUiQuery(key, b, (int)sizeof(ring[0]));
    return b;
}

static bool QOn(const char *key) { return Q(key)[0] == '1'; }

static bool Act(const char *name, int arg = 0) { return PortHostUiAction(name, arg) != 0; }

/* An action that hands the screen to the page sets this: the menu closes
 * after this frame rather than in the middle of drawing it. */
static int sCloseAfter;

static float ButtonW(const char *label)
{
    return ImGui::CalcTextSize(label, NULL, true).x + ImGui::GetStyle().FramePadding.x * 2.0f;
}

static void SameLineIfFitsButton(const char *next)
{
    float x = ImGui::GetItemRectMax().x + ImGui::GetStyle().ItemSpacing.x;
    float right = ImGui::GetWindowPos().x + ImGui::GetWindowContentRegionMax().x;
    if (x + ButtonW(next) <= right)
        ImGui::SameLine();
}

/* A button that asks once more before doing something that cannot be
 * undone: the first press turns it into "<label>?  Yes" for a few seconds. */
static bool ConfirmButton(const char *label, const char *id)
{
    static char armed[32];
    static double armedAt;
    bool fire = false;

    if (armed[0] && sNow - armedAt > 4000.0)
        armed[0] = '\0';
    ImGui::PushID(id);
    if (strcmp(armed, id) == 0) {
        char yes[96];
        snprintf(yes, sizeof(yes), "Really %s?##yes", label);
        ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.55f, 0.20f, 0.18f, 1.0f));
        ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.68f, 0.26f, 0.22f, 1.0f));
        if (ImGui::Button(yes)) {
            fire = true;
            armed[0] = '\0';
        }
        ImGui::PopStyleColor(2);
    } else if (ImGui::Button(label)) {
        snprintf(armed, sizeof(armed), "%s", id);
        armedAt = sNow;
    }
    ImGui::PopID();
    return fire;
}

static void Heading(const char *label)
{
    ImGui::Spacing();
    ImGui::SeparatorText(label);
}

/* --- pages ------------------------------------------------------------------ */

enum { PG_GAME, PG_DISPLAY, PG_AUDIO, PG_CONTROLS, PG_RANDO, PG_ADVANCED, PG_COUNT };
static const char *const kPageNames[PG_COUNT] = {
    "Game", "Display", "Audio", "Controls", "Randomizer", "Advanced",
};
static int sPage = -1;

static bool PageShown(int p)
{
    if (Web())
        return true;
    /* Native: the ROM, the save and the randomizer are the
     * command line's (--rom, --rando, ...), not the menu's. */
    return p == PG_DISPLAY || p == PG_AUDIO || p == PG_CONTROLS || p == PG_ADVANCED;
}

static void PageGame(void)
{
    Heading("ROM");
    Hint(Q("rom.info"));
    if (ImGui::Button("Load a different ROM..."))
        Act("rom.load");
    SameLineIfFitsButton("Forget stored ROM");
    ImGui::BeginDisabled(!QOn("rom.stored"));
    if (ConfirmButton("Forget stored ROM", "romforget"))
        Act("rom.forget");
    ImGui::EndDisabled();
    Hint("A different ROM restarts the page with it. The ROM is kept only in this "
         "browser, on this device; Forget erases that copy (you pick the file again next visit).");

    Heading("Save data");
    Hint(Q("save.info"));
    bool haveRom = QOn("save.rom");
    ImGui::BeginDisabled(!haveRom);
    if (ImGui::Button("Export save..."))
        Act("save.export");
    SameLineIfFitsButton("Import save...");
    if (ImGui::Button("Import save..."))
        Act("save.import");
    ImGui::EndDisabled();
    SameLineIfFitsButton("Delete stored save");
    ImGui::BeginDisabled(!QOn("save.stored"));
    if (ConfirmButton("Delete stored save", "savedelete"))
        Act("save.delete");
    ImGui::EndDisabled();
    Hint("A plain 64 KiB SRAM image (.sav), the same file an emulator reads. "
         "Export one now and then: it is your backup.");

    Heading("Session");
    if (ConfirmButton("Reset game", "reset"))
        Act("reset");
    Hint("Restarts from power-on (reloads the page). Your save is kept.");
}

static int PageDisplay(void)
{
    PortSettings &s = gPortSettings;
    const PortUiStatus &st = gPortUiStatus;
    int changed = 0;

    if (Web()) {
        bool fs = QOn("fullscreen");
        if (ImGui::Button(fs ? "Exit fullscreen" : "Fullscreen"))
            Act("fullscreen");
        ImGui::SameLine();
        Hint(fs ? "Esc also leaves it." : "F11 works too.");
    }

    if (Section("Renderer")) {
        ImGui::BeginDisabled(!st.gpuAvailable);
        changed |= Radio("GPU (render list)", &s.renderer, PS_RENDER_GPU);
        ImGui::EndDisabled();
        SameLineIfFits("PPU (emulated)");
        changed |= Radio("PPU (emulated)", &s.renderer, PS_RENDER_PPU);
        if (!st.gpuAvailable)
            Hint("GPU renderer unavailable here; the PPU draws.");
        else if (s.renderer == PS_RENDER_PPU)
            Hint("The PPU draws the GBA's 240x160 only: zoom, aspect and HUD below apply to the GPU renderer.");
    }

    if (Section("Camera zoom")) {
        static const float kPresets[] = { 0.5f, 0.67f, 0.8f, 1.0f, 1.25f, 1.5f, 2.0f };
        static const char *const kNames[] = { "0.5x", "0.67x", "0.8x", "1x", "1.25x", "1.5x", "2x" };
        float z = s.zoom;

        float pm = ImGui::CalcTextSize(" + ").x + ImGui::GetStyle().FramePadding.x * 2;
        ImGui::PushItemWidth(-(pm * 2 + ImGui::GetStyle().ItemSpacing.x * 2));
        if (ImGui::SliderFloat("##zoom", &z, 0.5f, 2.0f, "%.2fx", ImGuiSliderFlags_AlwaysClamp)) {
            s.zoom = z;
            changed = 1;
        }
        ImGui::PopItemWidth();
        ImGui::SameLine();
        if (ImGui::Button(" - ")) { s.zoom = s.zoom / 1.1f; changed = 1; }
        ImGui::SameLine();
        if (ImGui::Button(" + ")) { s.zoom = s.zoom * 1.1f; changed = 1; }
        for (int i = 0; i < (int)(sizeof(kPresets) / sizeof(kPresets[0])); i++) {
            if (i) ImGui::SameLine();
            if (ImGui::GetContentRegionAvail().x < ImGui::CalcTextSize(kNames[i]).x + ImGui::GetStyle().FramePadding.x * 2)
                ImGui::NewLine();
            bool on = fabsf(s.zoom - kPresets[i]) < 0.005f;
            if (on) ImGui::PushStyleColor(ImGuiCol_Button, ImGui::GetStyleColorVec4(ImGuiCol_ButtonActive));
            if (ImGui::Button(kNames[i])) { s.zoom = kPresets[i]; changed = 1; }
            if (on) ImGui::PopStyleColor();
        }
        Hint("Below 1x shows more of the room, above 1x less. 1x = 160 rows of the world, as on the GBA.");
        bool dz = s.dynZoom != 0;
        if (ImGui::Checkbox("Dynamic zoom (eases in at rest)", &dz)) {
            s.dynZoom = dz;
            changed = 1;
        }
    }

    if (Section("Aspect ratio")) {
        for (int a = 0; a < PS_ASPECT_COUNT; a++)
            changed |= Radio(PortAspectName(a), &s.aspect, a);
        if (st.gpu) {
            char line[160];
            snprintf(line, sizeof(line), "World view now: %dx%d%s (zoom %.2fx)",
                     st.viewW, st.viewH, st.world ? "" : " (menu screens stay 240x160)",
                     (double)st.zoomNow);
            Hint(line);
            if (st.world && PortLayoutPastSpawnMargin(st.viewW, st.viewH))
                Warn("This view reaches past the game's spawn margin (48 px beyond 240x160), "
                     "which a netplay session keeps as it shipped: expect enemies and items "
                     "to pop in and out near the edges.");
            else if (st.world && (st.viewW > 240 || st.viewH > 160))
                Hint("Wider than the GBA: the game's spawn margin widens with this view, "
                     "which changes the simulation (recordings capture it).");
        }
    }

    if (Section("Scaling")) {
        changed |= Radio("Integer", &s.scaling, PS_SCALE_INTEGER);
        SameLineIfFits("Fit (sharp)");
        changed |= Radio("Fit (sharp)", &s.scaling, PS_SCALE_FIT);
        SameLineIfFits("Smooth");
        changed |= Radio("Smooth", &s.scaling, PS_SCALE_SMOOTH);
        ImGui::TextUnformatted("Borders:");
        static const unsigned kBox[] = { 0x000000, 0x0C0E11, 0x2A2E36, 0x3A2A55 };
        static const char *const kBoxN[] = { "Black", "Dark", "Grey", "Purple" };
        for (int i = 0; i < 4; i++) {
            ImGui::SameLine();
            ImVec4 c(((kBox[i] >> 16) & 255) / 255.0f, ((kBox[i] >> 8) & 255) / 255.0f,
                     (kBox[i] & 255) / 255.0f, 1.0f);
            ImGui::PushID(i);
            if (ImGui::ColorButton(kBoxN[i], c, ImGuiColorEditFlags_NoTooltip,
                                   ImVec2(ImGui::GetFrameHeight() * 1.4f, ImGui::GetFrameHeight()))) {
                s.letterbox = kBox[i];
                changed = 1;
            }
            ImGui::PopID();
        }
    }

    if (Section("HUD")) {
        changed |= Radio("Pinned to the corners", &s.hud, PS_HUD_CORNERS);
        SameLineIfFits("Original strip");
        changed |= Radio("Original strip", &s.hud, PS_HUD_STRIP);
        ImGui::TextUnformatted("Size:");
        for (int i = 0; i <= PS_HUD_SCALE_MAX; i++) {
            char name[16];
            if (i == 0) snprintf(name, sizeof(name), "Auto");
            else snprintf(name, sizeof(name), "%dx", i);
            ImGui::SameLine();
            if (ImGui::GetContentRegionAvail().x < ImGui::CalcTextSize(name).x + ImGui::GetStyle().FramePadding.x * 2)
                ImGui::NewLine();
            bool on = s.hudScale == i;
            ImGui::PushID(100 + i);
            if (on) ImGui::PushStyleColor(ImGuiCol_Button, ImGui::GetStyleColorVec4(ImGuiCol_ButtonActive));
            if (ImGui::Button(name)) { s.hudScale = i; changed = 1; }
            if (on) ImGui::PopStyleColor();
            ImGui::PopID();
        }
        if (st.gpu && st.world) {
            char line[160];
            snprintf(line, sizeof(line), "HUD now %.2f window pixels per GBA pixel.",
                     (double)st.hudScaleNow);
            Hint(line);
        }
        Hint("Auto keeps the HUD the size it has at zoom 1, whatever the zoom; "
             "a fixed size is capped so the whole HUD fits the picture. "
             "Corners vs strip only differs when the picture is wider than the HUD.");
    }

    if (Section("Frames")) {
        bool fps = s.showFps != 0;
        if (ImGui::Checkbox("Show FPS", &fps)) { s.showFps = fps; changed = 1; }
        if (st.vsyncControl) {
            bool vs = s.vsync != 0;
            ImGui::SameLine();
            if (ImGui::Checkbox("VSync", &vs)) { s.vsync = vs; changed = 1; }
        }
        bool sc = s.smoothCam != 0, ip = s.interp != 0;
        ImGui::BeginDisabled(s.renderer != PS_RENDER_GPU);
        if (ImGui::Checkbox("Smooth camera", &sc)) { s.smoothCam = sc; changed = 1; }
        SameLineIfFits("Interpolation");
        if (ImGui::Checkbox("Interpolation", &ip)) { s.interp = ip; changed = 1; }
        ImGui::EndDisabled();
        ImGui::Text("Game %.1f frames/s, drawn %.1f/s", (double)st.simFps, (double)st.drawFps);
        Hint("The game always runs at the GBA's 59.73 Hz. Smooth camera scrolls by fractions of a "
             "game pixel; Interpolation draws in-between frames on a faster display (up to one "
             "frame of extra delay).");
    }

    if (Section("Lighting")) {
        /* render/light.c.  Map parameters (mode, softness, angle) rebuild
         * the shadow map, at most 5 times a second while a slider moves. */
        bool on = gPortLighting > 0;
        ImGui::BeginDisabled(s.renderer != PS_RENDER_GPU);
        if (ImGui::Checkbox("Sunlight and shadows (Rainbow Route)", &on)) {
            s.lightOn = on ? 1 : 0;
            changed = 1;
        }
        ImGui::BeginDisabled(!on);
        changed |= Radio("Sun", &s.lightMode, 0);
        SameLineIfFits("Point lights");
        changed |= Radio("Point lights", &s.lightMode, 1);
        ImGui::PushItemWidth(-1);
        changed |= ImGui::SliderFloat("##lk", &s.lightStrength, 0.0f, 3.0f, "Strength %.2f", ImGuiSliderFlags_AlwaysClamp);
        changed |= ImGui::SliderFloat("##ls", &s.lightShadow, 0.0f, 0.8f, "Shadow darkness %.2f", ImGuiSliderFlags_AlwaysClamp);
        changed |= ImGui::SliderFloat("##lf", &s.lightSoft, 0.0f, 1.0f, "Shadow softness %.2f", ImGuiSliderFlags_AlwaysClamp);
        changed |= ImGui::SliderFloat("##lp", &s.lightDepth, 0.0f, 48.0f, "Light into the ground %.0f px", ImGuiSliderFlags_AlwaysClamp);
        ImGui::BeginDisabled(s.lightMode != 0);
        {
            bool anim = s.lightSunAnim != 0;
            if (ImGui::Checkbox("Sun crosses the sky (sunrise to sunset)", &anim)) {
                s.lightSunAnim = anim ? 1 : 0;
                changed = 1;
            }
        }
        ImGui::BeginDisabled(!s.lightSunAnim);
        changed |= ImGui::SliderFloat("##lv", &s.lightSunSpeed, 0.5f, 30.0f, "Sun speed %.1f deg/s", ImGuiSliderFlags_AlwaysClamp | ImGuiSliderFlags_Logarithmic);
        ImGui::EndDisabled();
        ImGui::BeginDisabled(s.lightSunAnim != 0);
        changed |= ImGui::SliderFloat("##la", &s.lightAngle, -75.0f, 75.0f, "Sun angle %.0f deg (+ left, - right)", ImGuiSliderFlags_AlwaysClamp);
        ImGui::EndDisabled();
        ImGui::EndDisabled();
        changed |= ImGui::SliderFloat("##lw", &s.lightWarm, 0.0f, 1.0f, "Warmth of lit areas %.2f", ImGuiSliderFlags_AlwaysClamp);
        changed |= ImGui::SliderFloat("##lc", &s.lightCool, 0.0f, 1.0f, "Coolness of shade %.2f", ImGuiSliderFlags_AlwaysClamp);
        ImGui::BeginDisabled(s.lightMode != 1);
        changed |= ImGui::SliderFloat("##lg", &s.lightGlow, 0.0f, 2.0f, "Glow (point lights) %.2f", ImGuiSliderFlags_AlwaysClamp);
        ImGui::EndDisabled();
        /* Normal maps from the art itself (render/relief_glsl.h). */
        changed |= ImGui::SliderFloat("##lr", &s.lightRelief, 0.0f, 2.0f, "Relief (normal maps) %.2f", ImGuiSliderFlags_AlwaysClamp);
        ImGui::BeginDisabled(s.lightRelief <= 0.0f);
        {
            bool bgr = s.lightReliefBg != 0;
            if (ImGui::Checkbox("Relief on backgrounds too (experimental)", &bgr)) {
                s.lightReliefBg = bgr ? 1 : 0;
                changed = 1;
            }
        }
        changed |= ImGui::SliderFloat("##lh", &s.lightShine, 0.0f, 1.0f, "Shine %.2f", ImGuiSliderFlags_AlwaysClamp);
        changed |= ImGui::SliderFloat("##lz", &s.lightHeight, 0.2f, 2.0f, "Light height %.2f", ImGuiSliderFlags_AlwaysClamp);
        ImGui::EndDisabled();
        changed |= ImGui::SliderFloat("##ld", &s.lightSprShadow, 0.0f, 1.0f, "Character shadows %.2f (0 off)", ImGuiSliderFlags_AlwaysClamp);
        ImGui::BeginDisabled(s.lightSprShadow <= 0.0f);
        changed |= ImGui::SliderFloat("##le", &s.lightCharReach, 16.0f, 160.0f, "Character shadow length %.0f px", ImGuiSliderFlags_AlwaysClamp);
        changed |= ImGui::SliderFloat("##lq", &s.lightCharDepth, 0.0f, 48.0f, "Character shadows into the ground %.0f px", ImGuiSliderFlags_AlwaysClamp);
        ImGui::EndDisabled();
        ImGui::PopItemWidth();
        ImGui::EndDisabled();
        if (ImGui::Button("Reset lighting")) {
            PortSettings d;
            PortSettingsDefaults(&d);
            s.lightMode = d.lightMode;
            s.lightStrength = d.lightStrength;
            s.lightShadow = d.lightShadow;
            s.lightSoft = d.lightSoft;
            s.lightAngle = d.lightAngle;
            s.lightWarm = d.lightWarm;
            s.lightCool = d.lightCool;
            s.lightGlow = d.lightGlow;
            s.lightRelief = d.lightRelief;
            s.lightShine = d.lightShine;
            s.lightHeight = d.lightHeight;
            s.lightSunAnim = d.lightSunAnim;
            s.lightSunSpeed = d.lightSunSpeed;
            s.lightSprShadow = d.lightSprShadow;
            s.lightReliefBg = d.lightReliefBg;
            s.lightDepth = d.lightDepth;
            s.lightCharReach = d.lightCharReach;
            s.lightCharDepth = d.lightCharDepth;
            changed = 1;
        }
        ImGui::EndDisabled();
        Hint("Proof of concept: GPU renderer, Rainbow Route rooms only. Shadows are cast by the "
             "level's solid tiles, and by Kirby and the enemies (Character shadows). Relief gives "
             "sprites a normal map made from their own pixels each frame (after Sprite Normals "
             "by Hugo Duprez, MIT); backgrounds only if you ask for it.");
    }

    if (Section("Menu size")) {
        /* Applied on release: resizing the panel under the finger that is
         * dragging the slider would move the slider away from it. */
        static float pending = -1.0f;
        if (pending < 0.0f || !ImGui::IsAnyItemActive()) pending = s.uiScale;
        ImGui::PushItemWidth(-1);
        ImGui::SliderFloat("##ui", &pending, 0.6f, 2.0f, "Menu size %.2fx", ImGuiSliderFlags_AlwaysClamp);
        if (ImGui::IsItemDeactivatedAfterEdit()) {
            s.uiScale = pending;
            changed = 1;
        }
        ImGui::PopItemWidth();
    }
    return changed;
}

static int PageAudio(void)
{
    PortSettings &s = gPortSettings;
    int changed = 0;
    float bw = ImGui::GetFontSize() * 4.2f;

    Heading("Output");
    ImGui::PushItemWidth(-bw * 1.4f);
    changed |= ImGui::SliderInt("##vol", &s.volume, 0, 100, "Volume %d%%");
    ImGui::PopItemWidth();
    ImGui::SameLine();
    bool m = s.mute != 0;
    if (ImGui::Checkbox("Mute", &m)) { s.mute = m; changed = 1; }
    if (Web())
        Hint("A browser starts sound on the first key press or tap.");
    return changed;
}

static void PageControls(void)
{
    const PortUiStatus &st = gPortUiStatus;

    Heading("Keyboard");
    ImGui::TextWrapped("D-pad: arrows / WASD. A: J / Z. B: K / X.");
    ImGui::TextWrapped("L: Q. R: E. Start: Enter. Select: Backspace / R-Shift.");
    ImGui::TextWrapped("This menu: F1 or Tab (Esc closes), or the gear button.");
    if (!Web())
        ImGui::TextWrapped("F11 fullscreen, F12 screenshot, 1-6 window scale.");
    else
        ImGui::TextWrapped("F11: fullscreen (your browser's own).");

    if (Web()) {
        Heading("Touch");
        bool on = QOn("touch");
        if (ImGui::Checkbox("On-screen touch pads", &on))
            Act("touch");
        Hint("On by default on a phone or tablet. On iPhone, Share > Add to Home Screen "
             "and launch it from there: Safari will not let a page go fullscreen, but a "
             "home-screen launch drops the browser bars, which is the same thing.");
    }
    (void)st;
    Hint("The game pauses while this menu is open.");
}

static void PageRando(void)
{
    unsigned v[4] = { 0, 1, 1, 1 };
    const char *r = Q("rando");
    int pools;

    sscanf(r, "%u,%u,%u,%u", &v[0], &v[1], &v[2], &v[3]);
    pools = (int)v[0];
    Heading("Enemies");
    if (Radio("As it shipped", &pools, 0)) Act("rando.pools", 0);
    SameLineIfFits("Shuffled");
    if (Radio("Shuffled", &pools, 1)) Act("rando.pools", 1);
    SameLineIfFits("Shuffled, bosses too");
    if (Radio("Shuffled, bosses too", &pools, 7)) Act("rando.pools", 7);

    if (pools != 0) {
        Heading("Seed");
        ImGui::AlignTextToFramePadding();
        ImGui::Text("Seed %u", v[3]);
        ImGui::SameLine();
        if (ImGui::Button("Reroll"))
            Act("rando.reroll");
        SameLineIfFitsButton("Enter a seed...");
        if (ImGui::Button("Enter a seed..."))
            Act("rando.seed");
        Heading("Rules");
        bool size = v[1] != 0, abil = v[2] != 0;
        if (ImGui::Checkbox("Match enemy sizes", &size)) Act("rando.size");
        if (ImGui::Checkbox("Keep abilities where they were", &abil)) Act("rando.ability");
    }
    Hint("Every enemy is one byte in the room's level data, so this swaps the byte as the "
         "room loads and the game builds a different enemy in the same spot from its own code. "
         "A seed is the whole run: the same number gives the same game every time. "
         "Takes effect at the next door. Match enemy sizes keeps a room's video-memory demand "
         "near what it was built for -- turning it off can overflow the tile heap. "
         "Bosses are the risky pool. Remembered between visits.");
}

static int PageAdvanced(void)
{
    const PortUiStatus &st = gPortUiStatus;
    int changed = 0;

    if (Web()) {
        Heading("Diagnostics");
        bool d = QOn("diag");
        if (ImGui::Checkbox("Diagnostics readout over the picture", &d))
            Act("diag");
        Heading("Log");
        if (ImGui::Button("Copy log"))
            Act("log.copy");
        ImGui::SameLine();
        Hint("for a bug report");
        static char logBuf[16384];
        logBuf[0] = '\0';
        PortHostUiQuery("log", logBuf, (int)sizeof(logBuf));
        float h = ImGui::GetTextLineHeightWithSpacing() * 12.0f;
        ImGui::BeginChild("log", ImVec2(0, h), ImGuiChildFlags_Borders, ImGuiWindowFlags_HorizontalScrollbar);
        ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.70f, 0.74f, 0.80f, 1.0f));
        ImGui::TextUnformatted(logBuf);
        ImGui::PopStyleColor();
        if (ImGui::GetScrollY() >= ImGui::GetScrollMaxY() - 2.0f)
            ImGui::SetScrollHereY(1.0f);
        ImGui::EndChild();
    }

    if (Web()) {
        Heading("Developer flags");
        Hint("Page-address flags, for development: ?renderer=gpu|ppu|2d, ?rom=<link>. "
             "Online play is parked (it desyncs) and has no menu entry: ?online=1 opens "
             "its lobby, ?room=CODE joins a game, ?world= / ?room=<name> are the older "
             "relay sessions (docs/design/NETPLAY-V2.md).");
    }

    Heading("Settings");
    if (ConfirmButton("Reset display and audio settings", "defaults")) {
        PortSettingsDefaults(&gPortSettings);
        changed = 1;
    }
    Hint("Settings change only how the game is shown and heard, never the game itself.");

    Heading("Build");
    ImGui::Text("Build %s  (%s)", KATAM_BUILD_LABEL, st.platform ? st.platform : "?");
    if (st.gpuDesc && st.gpuDesc[0])
        Hint(st.gpuDesc);
    return changed;
}

static void PageTabs(void)
{
    ImGuiStyle &style = ImGui::GetStyle();
    bool first = true;

    if (sPage < 0 || !PageShown(sPage))
        sPage = Web() ? PG_GAME : PG_DISPLAY;
    for (int p = 0; p < PG_COUNT; p++) {
        if (!PageShown(p))
            continue;
        if (!first)
            SameLineIfFitsButton(kPageNames[p]);
        first = false;
        bool on = p == sPage;
        if (on) {
            ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.30f, 0.44f, 0.66f, 1.0f));
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.34f, 0.50f, 0.74f, 1.0f));
        }
        if (ImGui::Button(kPageNames[p]))
            sPage = p;
        if (on)
            ImGui::PopStyleColor(2);
    }
    (void)style;
}

static int MenuBody(void)
{
    int changed = 0;

    switch (sPage) {
    case PG_GAME:     PageGame(); break;
    case PG_DISPLAY:  changed = PageDisplay(); break;
    case PG_AUDIO:    changed = PageAudio(); break;
    case PG_CONTROLS: PageControls(); break;
    case PG_RANDO:    PageRando(); break;
    case PG_ADVANCED: changed = PageAdvanced(); break;
    }
    ImGui::Spacing();
    return changed;
}

static void DrawMenu(int fbW, int fbH)
{
    ImGuiStyle &style = ImGui::GetStyle();
    float m = ImGui::GetFontSize() * 0.6f;
    float w = ImGui::GetFontSize() * 40.0f;
    int changed;

    if (w > fbW - 2 * m) w = fbW - 2 * m;
    ImGui::GetBackgroundDrawList()->AddRectFilled(ImVec2(0, 0), ImVec2((float)fbW, (float)fbH),
                                                  IM_COL32(0, 0, 0, 110));
    ImGui::SetNextWindowPos(ImVec2((fbW - w) * 0.5f, m));
    ImGui::SetNextWindowSize(ImVec2(w, fbH - 2 * m));
    ImGui::Begin("KATAM menu", NULL,
                 ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                 ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse |
                 ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoScrollbar);
    ImGui::AlignTextToFramePadding();
    ImGui::TextUnformatted("Kirby & The Amazing Mirror");
    {
        const char *lbl = "Resume";
        float bwid = ImGui::CalcTextSize(lbl).x + style.FramePadding.x * 4;
        ImGui::SameLine(ImGui::GetContentRegionMax().x - bwid);
        if (ImGui::Button(lbl, ImVec2(bwid, 0)))
            PortUiSetOpen(0);
    }
    PageTabs();
    ImGui::Separator();
    ImGui::BeginChild("body", ImVec2(0, 0), ImGuiChildFlags_None, ImGuiWindowFlags_None);
    if (sScrollPx != 0.0f) {
        ImGui::SetScrollY(ImGui::GetScrollY() - sScrollPx);
        sScrollPx = 0.0f;
    }
    {
        /* A page opens at its top. */
        static int lastPage = -1;
        if (lastPage != sPage) {
            ImGui::SetScrollY(0.0f);
            lastPage = sPage;
        }
    }
    changed = MenuBody();
    ImGui::EndChild();
    ImGui::End();

    /* A tap on the dimmed game outside the panel closes it. */
    if (sOpenFrames > 2 && ImGui::IsMouseReleased(0)
        && !ImGui::IsWindowHovered(ImGuiHoveredFlags_AnyWindow)
        && !ImGui::IsAnyItemActive() && ImGui::GetIO().MouseDragMaxDistanceSqr[0] < 400.0f)
        PortUiSetOpen(0);
    if (changed) {
        PortSettingsClamp(&gPortSettings);
        PortSettingsChanged();
    }
}
static void DrawGear(int fbW)
{
    float fs = ImGui::GetFontSize();
    ImGui::SetNextWindowPos(ImVec2(fbW - fs * 0.4f, fs * 0.4f), 0, ImVec2(1.0f, 0.0f));
    ImGui::SetNextWindowBgAlpha(0.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0f);
    ImGui::Begin("##gear", NULL, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize |
                 ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing |
                 ImGuiWindowFlags_NoNav);
    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, 0.75f);
    if (ImGui::Button("Menu"))
        PortUiSetOpen(1);
    ImGui::PopStyleVar();
    ImGui::End();
    ImGui::PopStyleVar();
}

extern "C" void PortUiDraw(int fbW, int fbH, float dpr, double nowMs)
{
    if (!sReady)
        return;
    ImGuiIO &io = ImGui::GetIO();

    sNow = nowMs;
    if (sTouchDown && sTouchPending && nowMs - sTouchT0 > TOUCH_HOLD_MS)
        BeginPress(sTouchX0, sTouchY0);         /* a hold: press, then drag */
    EnsureScale(dpr);
    io.DisplaySize = ImVec2((float)fbW, (float)fbH);
    io.DisplayFramebufferScale = ImVec2(1.0f, 1.0f);
    io.DeltaTime = (sLast > 0 && nowMs > sLast) ? (float)((nowMs - sLast) / 1000.0) : 1.0f / 60.0f;
    if (io.DeltaTime > 0.25f) io.DeltaTime = 0.25f;
    sLast = nowMs;

    ImGui::NewFrame();
    if (sOpen) {
        sOpenFrames++;
        DrawMenu(fbW, fbH);
    } else if (gPortUiStatus.drawGear) {
        DrawGear(fbW);
    }
    if (gPortSettings.showFps) {
        char t[64];
        float fs = ImGui::GetFontSize();
        snprintf(t, sizeof(t), "%.1f fps", (double)gPortUiStatus.drawFps);
        ImDrawList *dl = ImGui::GetForegroundDrawList();
        ImVec2 sz = ImGui::CalcTextSize(t);
        dl->AddRectFilled(ImVec2(fs * 0.3f, fs * 0.3f), ImVec2(fs * 0.7f + sz.x, fs * 0.7f + sz.y),
                          IM_COL32(0, 0, 0, 150), 4.0f);
        dl->AddText(ImVec2(fs * 0.5f, fs * 0.5f), IM_COL32(230, 235, 240, 255), t);
    }
    ImGui::Render();
    UiGlRender(ImGui::GetDrawData(), fbW, fbH);
    if (sCloseAfter) {
        sCloseAfter = 0;
        PortUiSetOpen(0);
    }
}

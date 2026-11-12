/* Co-op: other players as puppet Kirbys (stage 1), shared progress (stage
 * 2), shared enemies (stage 3) and shared boss health (stage 4); see
 * docs/COOP-HANDOFF.md.  Two parts in one file
 * (one script tag): the logic, KatamCoop (UMD, no DOM; node loads it with
 * require), then the page glue below it, which only runs in a browser.
 *
 * --- part 1: the logic -------------------------------------------------------
 *
 * Every player runs their own game; the room (netplay/session.mjs, sim
 * 'coop/1') only relays each player's own Kirby pose to the others.  No
 * lockstep, no rollback, no shared input.  This file
 *
 *   - samples the local pose every presented frame (PortCoopLocalPose) and
 *     sends one POSE_UP every 2nd frame carrying both (net.sendPose);
 *   - keeps a small jitter buffer per remote player and plays it back a few
 *     frames behind, interpolating x/y, extrapolating briefly on underrun,
 *     freezing on a stall and then marking the puppet absent;
 *   - maps the other players onto the engine's puppet slots 1..3 by seat
 *     order (sticky; a 4th other player is simply not shown) and drives
 *     PortCoopSetPuppet / SetPose / SetAbsent every frame.
 *
 * UMD with no DOM: window.KatamCoop in a page (part 2 below is the glue:
 * URL, status chip, tab identity, visibility), require() under node
 * (tools/coop_test.mjs, netplay/test/coop.test.mjs).
 *
 *   var coop = KatamCoop.create({ Module, net, log });
 *   Module.portPresent = ... coop.tick();
 *
 * The pose bytes belong to the engine (platform/, PortCoopPoseSize bytes;
 * 36 today).  Only the header is read here:
 *   i32 x @0, i32 y @4 (24.8 fixed), u16 room @8, u8 flags @10 (bit0 hidden)
 * Interpolation lerps x and y between two poses in the same room and copies
 * the newer pose's other bytes; a room change, a hidden pose or a teleport
 * snaps.  The wire format is netplay/wire.mjs (POSE_UP / POSE_DOWN).
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports)
        module.exports = factory();
    else
        root.KatamCoop = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* coop/2: shared progress, enemies and bosses ride on the signal relay.
     * The pose is unchanged, but a room should not mix pages that share
     * progress with pages that do not; the room's version check keeps them
     * apart.  coop/3: CPU Kirbys run by one game for everyone, and spawned
     * objects (pose extras) -- a coop/2 page would run helpers of its own
     * that the others cannot see.  coop/4: the extras carry shared enemies'
     * shots as hazards and the sounds of the other games, and enemies go
     * after any player -- a coop/3 page would drop the longer frames. */
    var SIM = 'coop/4';
    var FRAME_MS = 1000 / 59.7275;
    var T_POSE_UP = 0x40;
    var F_PAUSED = 1, F_KEY = 2;          /* message flags */
    var P_HIDDEN = 1;                     /* pose flags @10 */
    var SLOTS = 3;                        /* puppet slots 1..3 */

    /* Jitter buffer policy (docs: the stage-1 transport plan). */
    var WINDOW_MS = 2000;                 /* offset/jitter estimate window */
    var D_MIN = 3, D_MAX = 12;            /* playback delay, frames */
    var EXTRAP_MAX = 6;                   /* frames of extrapolation, then hold */
    var STALL_MS = 1500;                  /* no pose this long: absent */
    var TELEPORT = 48 * 256;              /* 48 px in one step: snap */
    var MAX_SAMPLES = 96;

    /* Send policy. */
    var SEND_MIN_MS = 31;                 /* <= ~32 msg/s even on odd frame pacing */
    var SEND_MAX_MS = 50;                 /* a lone sample goes after this */
    var IDLE_AFTER = 30;                  /* unchanged samples before idling */
    var IDLE_MS = 250;                    /* 4 msg/s while idle */

    var REQUIRED = ['_PortCoopPoseSize', '_PortCoopEnable', '_PortCoopReady', '_PortCoopSetPuppet',
                    '_PortCoopSetPose', '_PortCoopSetAbsent', '_PortCoopLocalPose', '_PortCoopPoseBuffer'];

    /* Stage 2, shared progress (platform/coop_world.c).  Optional: a build
     * without them still shows puppets. */
    var WORLD = ['_PortCoopWorldShare', '_PortCoopWorldTake', '_PortCoopWorldApply', '_PortCoopWorldNews',
                 '_PortCoopRecordBuffer', '_PortCoopWorldCount', '_PortCoopWorldTracking'];
    var NEWS = { SHARD: 1, BIGCHEST: 2, SPRAY: 4, MUSIC: 8, VITALITY: 16, SWITCH: 32, CHEST: 64,
                 MAP: 128, ENCOUNTER: 256, STORY: 512, OTHER: 1024 };
    var REC_FULL = 1, RECORD_MAX = 1024;

    /* Spawned objects and CPU Kirbys (platform/coop_fx.c, coop.c).  Optional:
     * an older build simply shows neither.  Both ride with the pose: an
     * "extras" blob per pose message (net.sendPose's second argument),
     *   u8 1, u8 n, then per pose sent: u16 seq, u8 nCpu, nCpu x {u8 slot,
     *   pose}, u16 fxLen, fxLen bytes (PortCoopFxTake's frame). */
    var FX = ['_PortCoopFxShare', '_PortCoopFxBuffer', '_PortCoopFxTake', '_PortCoopFxSet', '_PortCoopSlotPose'];
    var FX_REC = 18, FX_SOURCES = 8;
    /* sprites, hazards, then a count and the sounds (port/coop.h) */
    var FX_BYTES = 4 + 32 * 18 + 10 * 24 + 1 + 16 * 8;
    var F2_INLEVEL = 2, F2_TUTORIAL = 4;  /* pose byte 27 */
    var AUTH_GRACE = 5000;                /* ms; see authority() */

    /* The live room (platform/coop_room.c): blocks broken, buttons, ability
     * stars.  Optional.  Signals: {tb} tile breaks to everyone, {ts} the
     * breaks of my room to a player who walks in, {sp: [id, room, x, y,
     * ability, type, flags]} a star I dropped, {tk: [ownerMid, id]} a star
     * swallowed, {bh} buttons hit. */
    var ROOM = ['_PortCoopRoomShare', '_PortCoopTilesTake', '_PortCoopTilesApply', '_PortCoopTilesSnapshot',
                '_PortCoopTilesSetSnapshot', '_PortCoopStarTake', '_PortCoopStarSpawn', '_PortCoopStarTaken',
                '_PortCoopRoomForget', '_PortCoopButtonsTake', '_PortCoopButtonsApply'];

    /* Stage 3, shared enemies (platform/coop_enemy.c).  Optional too. */
    var ENEMY = ['_PortCoopEnemyShare', '_PortCoopEnemyCollect', '_PortCoopEnemySetPoses', '_PortCoopEnemyTake',
                 '_PortCoopEnemyEvent'];
    var EN_REC = 14, EN_SEND_MS = 31, EN_DELAY = 4;

    /* The room owner's enemy snapshots, played back EN_DELAY frames behind the
     * newest with x/y interpolated per enemy (records are matched by index).
     * Snapshot bytes: u16 room, u16 n, n x {u16 idx, i32 x, i32 y, s16 hp,
     * u8 anim, u8 flags}. */
    function EnemyBuffer() { this.reset(); }
    EnemyBuffer.prototype.reset = function () { this.snaps = []; this.from = null; this.lastSeq = null; this.t = 0; this.min = null; };
    EnemyBuffer.prototype.push = function (from, seq, bytes, nowF) {
        if (from !== this.from) { this.reset(); this.from = from; }
        if (this.lastSeq === null) { this.lastSeq = seq; this.t = seq; }
        var d = ((seq - this.lastSeq + 32768) & 0xFFFF) - 32768;
        if (d <= 0) return;
        this.lastSeq = seq;
        this.t += d;
        this.snaps.push({ t: this.t, b: bytes, at: nowF });
        if (this.snaps.length > 12) this.snaps.shift();
        var off = nowF - this.t;
        /* the fastest a snapshot has come through lately; creeps up slowly so
         * a link that got slower is followed */
        this.min = this.min === null ? off : Math.min(off, this.min + 0.02);
    };
    function enRecs(b) {
        var n = b[2] | (b[3] << 8), m = {};
        for (var i = 0; i < n && 4 + (i + 1) * EN_REC <= b.length; i++) {
            var o = 4 + i * EN_REC;
            m[b[o] | (b[o + 1] << 8)] = o;
        }
        return m;
    }
    /* -> bytes for PortCoopEnemySetPoses, or null (nothing fresh) */
    EnemyBuffer.prototype.sample = function (nowF) {
        var s = this.snaps;
        if (!s.length || nowF - s[s.length - 1].at > 30) return null;
        var c = nowF - this.min - EN_DELAY;
        var k = 0;
        while (k + 1 < s.length && s[k + 1].t <= c) k++;
        var a = s[k], b = s[k + 1];
        if (!b || c <= a.t) return a.b;
        if ((a.b[0] | (a.b[1] << 8)) !== (b.b[0] | (b.b[1] << 8))) return b.b;
        var f = (c - a.t) / (b.t - a.t), out = b.b.slice(), ra = enRecs(a.b), rb = enRecs(out);
        for (var idx in rb) {
            if (ra[idx] === undefined) continue;
            var oa = ra[idx], ob = rb[idx];
            for (var q = 2; q <= 6; q += 4) {
                var va = i32(a.b, oa + q), vb = i32(out, ob + q);
                if (Math.abs(vb - va) <= 48 * 256) setI32(out, ob + q, Math.round(va + (vb - va) * f));
            }
        }
        return out;
    };

    function b64(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }
    function unb64(str) {
        var t = atob(str), b = new Uint8Array(t.length);
        for (var i = 0; i < t.length; i++) b[i] = t.charCodeAt(i);
        return b;
    }

    /* One line for what a progress record brought, or null when it is only
     * map squares and the like.  counts(kind) -> how many the local file has. */
    function describeNews(news, full, counts) {
        var bits = [];
        if (news & NEWS.SHARD) bits.push('a Mirror Shard (' + counts(NEWS.SHARD) + '/8)');
        if (news & NEWS.BIGCHEST) bits.push('an area map');
        if (news & NEWS.VITALITY) bits.push('a Vitality heart');
        if (news & NEWS.SPRAY) bits.push('a spray paint');
        if (news & NEWS.MUSIC) bits.push('music for the sound player');
        if (news & NEWS.SWITCH) bits.push('a big switch');
        if (!(news & (NEWS.SHARD | NEWS.BIGCHEST | NEWS.VITALITY | NEWS.SPRAY | NEWS.MUSIC)) && (news & NEWS.CHEST))
            bits.push('a treasure chest');
        if (news & NEWS.STORY) bits.push('story progress');
        if (!bits.length) return null;
        return (full ? 'shared progress: ' : 'found ') + bits.join(', ');
    }

    function nowMs() { return (typeof performance !== 'undefined' ? performance : Date).now(); }

    /* --- pose header ------------------------------------------------------- */

    function i32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)); }
    function setI32(b, o, v) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255; b[o + 3] = (v >> 24) & 255; }
    function poseX(b) { return i32(b, 0); }
    function poseY(b) { return i32(b, 4); }
    function poseRoom(b) { return b[8] | (b[9] << 8); }
    function poseHidden(b) { return !!(b[10] & P_HIDDEN); }

    /* Two poses x/y may be interpolated between. */
    function joinable(a, b) {
        return !poseHidden(a) && !poseHidden(b) && poseRoom(a) === poseRoom(b) &&
            Math.abs(poseX(b) - poseX(a)) <= TELEPORT && Math.abs(poseY(b) - poseY(a)) <= TELEPORT;
    }

    /* b's bytes with x/y at a + (b - a) * f (f may exceed 1: extrapolation). */
    function lerpPose(a, b, f) {
        var out = b.slice();
        setI32(out, 0, Math.round(poseX(a) + (poseX(b) - poseX(a)) * f));
        setI32(out, 4, Math.round(poseY(a) + (poseY(b) - poseY(a)) * f));
        return out;
    }

    function hiddenPose(size) {
        var b = new Uint8Array(size);
        b[10] = P_HIDDEN;
        return b;
    }

    function same(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    /* --- wire (netplay/wire.mjs; netplay/test/coop.test.mjs checks they agree) */

    function encodePoseUp(flags, poses) {
        var size = poses[0].bytes.length;
        var buf = new Uint8Array(4 + poses.length * (2 + size));
        buf[0] = T_POSE_UP;
        buf[1] = flags;
        buf[2] = poses.length;
        buf[3] = size;
        for (var i = 0, o = 4; i < poses.length; i++, o += 2 + size) {
            buf[o] = poses[i].seq & 255;
            buf[o + 1] = (poses[i].seq >> 8) & 255;
            buf.set(poses[i].bytes, o + 2);
        }
        return buf;
    }

    /* body: POSE_UP from offset 1 (what 'pose' events carry). */
    function decodePoseBody(body) {
        if (!body || body.length < 3) return null;
        var n = body[1], size = body[2];
        if (n < 1 || n > 4 || size < 8 || size > 64 || body.length !== 3 + n * (2 + size)) return null;
        var poses = [];
        for (var i = 0, o = 3; i < n; i++, o += 2 + size)
            poses.push({ seq: body[o] | (body[o + 1] << 8), bytes: body.slice(o + 2, o + 2 + size) });
        return { flags: body[0], size: size, poses: poses };
    }

    /* --- the jitter buffer --------------------------------------------------
     * Samples are stamped with the sender's clock (seq, in frames).  The
     * receiver tracks offset = arrival - seq (in local frames) as a sliding
     * minimum: the fastest a sample has come through lately.  Playback runs
     * at seq = now - offset - D, D covering the recent jitter (p95 above the
     * minimum, +2), so a sample normally arrives D frames before it plays.
     *
     *   underrun (nothing newer yet)   extrapolate along the last step for up
     *                                  to EXTRAP_MAX frames, then hold
     *   nothing for STALL_MS           absent (until the next sample)
     *   KEY, or a sample after a stall reset: the newest sample shows at once,
     *                                  no backlog is replayed
     *   a backlog (HoL burst, our own frozen frames)   the cursor jumps to the
     *                                  target; old samples are discarded */
    function JitterBuffer() { this.reset(); this.resets = 0; }

    JitterBuffer.prototype.reset = function () {
        this.samples = [];      /* {t, b}, ascending t */
        this.win = [];          /* {at, d} arrivals within WINDOW_MS */
        this.lastSeq = null;
        this.lastT = 0;
        this.lastArrival = -Infinity;
        this.cursor = null;
        this.lastNow = null;
        this.paused = false;
        this.D = D_MIN;
        this.dAt = 0;
        this.resets++;
    };

    JitterBuffer.prototype._unwrap = function (seq) {
        if (this.lastSeq === null) {
            this.lastSeq = seq;
            this.lastT = seq;
            return seq;
        }
        var d = ((seq - this.lastSeq + 32768) & 0xFFFF) - 32768;
        if (d > 0) { this.lastSeq = seq; this.lastT += d; return this.lastT; }
        return this.lastT + d;
    };

    /* seq on this buffer's timeline, without moving it (extras arrive with or
     * just after the pose they belong to) */
    JitterBuffer.prototype.tOf = function (seq) {
        if (this.lastSeq === null) return seq;
        return this.lastT + (((seq - this.lastSeq + 32768) & 0xFFFF) - 32768);
    };
    JitterBuffer.prototype.newest = function () {
        var s = this.samples;
        return s.length ? s[s.length - 1].b : null;
    };

    JitterBuffer.prototype.push = function (seq, bytes, now, flags) {
        if ((flags & F_KEY) || now - this.lastArrival > STALL_MS)
            this.reset();
        var t = this._unwrap(seq);
        var s = this.samples;
        if (s.length && t <= s[s.length - 1].t) {
            if (t === s[s.length - 1].t) s[s.length - 1].b = bytes;
            return;              /* older than what we have: TCP keeps order, so a dup */
        }
        s.push({ t: t, b: bytes });
        if (s.length > MAX_SAMPLES) s.splice(0, s.length - MAX_SAMPLES);
        this.win.push({ at: now, d: now / FRAME_MS - t });
        while (this.win.length > 1 && this.win[0].at < now - WINDOW_MS) this.win.shift();
        this.lastArrival = now;
        this.paused = !!(flags & F_PAUSED);
    };

    /* -> {state: 'none' | 'pose' | 'absent', bytes?, away} */
    JitterBuffer.prototype.sample = function (now) {
        var s = this.samples;
        if (!s.length) return { state: 'none', away: true };
        if (now - this.lastArrival > STALL_MS) return { state: 'absent', away: true };
        var nowF = now / FRAME_MS;
        var min = Infinity, ds = [];
        for (var i = 0; i < this.win.length; i++) if (this.win[i].d < min) min = this.win[i].d;
        /* one sample far later than the rest is a hiccup, not the link's jitter */
        for (i = 0; i < this.win.length; i++) if (this.win[i].d <= min + 2 * D_MAX) ds.push(this.win[i].d);
        ds.sort(function (a, b) { return a - b; });
        var p95 = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))];
        /* up at once (late samples would underrun), down slowly (each
         * change of D is a visible change of speed) */
        var want = Math.max(D_MIN, Math.min(D_MAX, Math.ceil(p95 - min) + 2));
        if (want > this.D) this.D = want;
        else if (want < this.D && now - this.dAt > 600) { this.D--; this.dAt = now; }
        if (want >= this.D) this.dAt = now;
        var target = nowF - min - this.D;
        if (this.cursor === null || Math.abs(target - this.cursor) > 30) {
            this.cursor = target;
        } else {
            var dt = Math.max(0, nowF - this.lastNow);
            /* real time, eased toward the target; never backwards */
            this.cursor += dt + Math.max(-0.5 * dt, Math.min(0.5 * dt + 0.5, (target - this.cursor) * 0.1));
        }
        this.lastNow = nowF;
        var c = this.cursor;
        var away = this.paused || now - this.lastArrival > 500;
        var last = s[s.length - 1];
        if (c <= s[0].t) return { state: 'pose', bytes: s[0].b, away: away };
        if (c >= last.t) {
            if (this.samples.length > 2) s.splice(0, s.length - 2);
            var prev = s.length > 1 ? s[s.length - 2] : null;
            if (!prev || !joinable(prev.b, last.b) || this.paused)
                return { state: 'pose', bytes: last.b, away: away };
            var ex = Math.min(c - last.t, EXTRAP_MAX);
            return { state: 'pose', bytes: lerpPose(prev.b, last.b, 1 + ex / (last.t - prev.t)), away: away };
        }
        var k = 0;
        while (k + 1 < s.length && s[k + 1].t <= c) k++;
        if (k > 1) { s.splice(0, k - 1); k = 1; }     /* keep one behind, for extrapolation */
        var a = s[k], b = s[k + 1];
        if (!joinable(a.b, b.b)) return { state: 'pose', bytes: a.b, away: away };
        return { state: 'pose', bytes: lerpPose(a.b, b.b, (c - a.t) / (b.t - a.t)), away: away };
    };

    /* --- the session --------------------------------------------------------- */

    /* opts: {Module, net, log?, now?} -> coop.  net: a KatamNet connection
     * made with hello.sim = KatamCoop.SIM. */
    function create(opts) {
        var M = opts.Module, net = opts.net;
        var log = opts.log || function () {};
        var now = opts.now || nowMs;
        var missing = REQUIRED.filter(function (n) { return typeof M[n] !== 'function'; });
        var size = missing.length ? 0 : M._PortCoopPoseSize();
        var remotes = {};                 /* mid -> {mid, name, seat, jb, slot, fx, cpuSeen, src} */
        /* slot -> who it shows: a member id (a player), 'c<mid>:<slot>' (a CPU
         * Kirby that member's game runs for everyone), 'x<slot>' (nobody: a
         * page that does not run the CPU Kirbys shows none of its own) */
        var slots = [null, null, null, null];
        var cpus = {};                    /* 'c<mid>:<slot>' -> {key, mid, id, jb, slot, out} */
        var puppetOn = [false, false, false, false];
        var enabled = false, wasReady = false, paused = false;
        var tx = { pending: [], lastAt: -Infinity, last: null, unchanged: 0, key: true, pausedSent: false };
        var stats = { sent: 0, sentPoses: 0, recv: 0, sizeMismatch: 0, mismatchFrom: null, frames: 0 };
        var applied = [null, null, null, null];  /* the bytes last given to SetPose, per slot */
        var hiddenOthers = 0;
        /* spawned objects and CPU Kirbys */
        var fxOk = !missing.length && FX.every(function (n) { return typeof M[n] === 'function'; });
        var cpu = { on: opts.cpus !== false, auth: null };
        var fx = { on: opts.fx !== false, shareSet: null, srcUsed: [], stats: { framesSent: 0, framesRecv: 0, framesSet: 0, cpuSent: 0, cpuRecv: 0, unmapped: {} } };
        /* the live room */
        var roomOk = fxOk && ROOM.every(function (n) { return typeof M[n] === 'function'; });
        var room = { on: opts.room !== false, shareSet: null,
                     stats: { tilesSent: 0, tilesRecv: 0, tilesApplied: 0, snapsSent: 0, snapsRecv: 0,
                              starsSent: 0, starsRecv: 0, starsMade: 0, takenSent: 0, takenRecv: 0 } };
        /* shared enemies */
        var enemyOk = !missing.length && ENEMY.every(function (n) { return typeof M[n] === 'function'; });
        var enemy = { share: opts.enemies !== false, shareSet: null, buf: new EnemyBuffer(), inbox: [], lastSent: -Infinity,
                      owner: null, stats: { snapsSent: 0, snapsRecv: 0, snapsUsed: 0, evSent: 0, evRecv: 0 } };
        /* shared progress */
        var worldOk = !missing.length && WORLD.every(function (n) { return typeof M[n] === 'function'; });
        var world = { share: opts.share !== false, shareSet: null, inbox: [], fullTo: {},
                      stats: { sent: 0, sentFull: 0, recv: 0, applied: 0, queued: 0, bad: 0, news: 0 } };

        if (missing.length) log('[coop] this build has no co-op engine exports (' + missing.join(', ') + ') -- puppets off');
        else if (size < 11 || size > 64) { log('[coop] pose size ' + size + ' is unusable'); missing = ['_PortCoopPoseSize']; }

        function heap() { return M.HEAPU8; }
        function bufPtr(slot) { return M._PortCoopPoseBuffer() + slot * size; }

        function remote(mid) {
            var r = remotes[mid];
            if (!r) r = remotes[mid] = { mid: mid, name: 'Player', seat: -1, jb: new JitterBuffer(), slot: 0, out: null,
                                         fx: [], fxResets: -1, cpuSeen: {}, src: -1 };
            return r;
        }
        function cpuKey(mid, id) { return 'c' + mid + ':' + id; }
        function cpuOf(mid, id) {
            var k = cpuKey(mid, id), c = cpus[k];
            if (!c) c = cpus[k] = { key: k, mid: +mid, id: id, jb: new JitterBuffer(), slot: 0, out: null };
            return c;
        }
        function isBlank(k) { return typeof k === 'string' && k.charAt(0) === 'x'; }
        function slotOfKey(k) {
            if (typeof k === 'number') return remotes[k] ? remotes[k].slot : 0;
            return cpus[k] ? cpus[k].slot : 0;
        }

        function others() {
            var ms = (net.roster && net.roster.members) || [];
            return ms.filter(function (m) { return m.mid !== net.mid && m.connected && m.role !== 'pending'; });
        }

        /* keep: the slot stays a puppet (it only changes who it shows) */
        function freeSlot(slot, keep) {
            var k = slots[slot];
            slots[slot] = null;
            applied[slot] = null;
            if (typeof k === 'number' && remotes[k]) remotes[k].slot = 0;
            else if (k !== null && cpus[k]) cpus[k].slot = 0;
            if (keep) return;
            if (puppetOn[slot] && !missing.length) M._PortCoopSetPuppet(slot, 0);
            puppetOn[slot] = false;
        }
        function place(slot, k) {
            if (slots[slot] !== null) freeSlot(slot, true);
            slots[slot] = k;
            applied[slot] = null;
            if (typeof k === 'number') remotes[k].slot = slot;
            else if (cpus[k]) cpus[k].slot = slot;
        }

        /* Who runs the CPU Kirbys for everyone: the lowest member id among the
         * players in a level and past their tutorial (null: nobody is).  Every
         * page computes the same from the same poses; a brief disagreement
         * means two copies of the helpers, or none, for a moment. */
        /* A player stays able to run them for AUTH_GRACE after they last
         * could: a door, a warp or a level load must not move the helpers
         * (each move respawns them), leaving the game or going back into a
         * tutorial does.  A player who leaves the room stops at once. */
        var canSeen = {};
        function canRun(b) { return b && (b[27] & F2_INLEVEL) && !(b[27] & F2_TUTORIAL); }
        function authority(t) {
            if (canRun(tx.last)) canSeen[net.mid] = t;
            for (var mid in remotes) {
                var r = remotes[mid];
                if (t - r.jb.lastArrival <= STALL_MS && canRun(r.jb.newest())) canSeen[mid] = t;
            }
            var best = null;
            for (var m in canSeen) {
                if (t - canSeen[m] > AUTH_GRACE || (+m !== net.mid && !remotes[m])) { delete canSeen[m]; continue; }
                if (best === null || +m < best) best = +m;
            }
            return best;
        }

        /* Sticky: a player keeps their slot while connected; free slots go to
         * the rest in seat order (then join order), then to the CPU Kirbys the
         * runner's game sends (when that is not this page), and a page that
         * does not run the CPU Kirbys fills what is left with nobody, so it
         * has no helpers of its own that the others cannot see.  Players
         * come first: a CPU Kirby gives its slot up to a player. */
        function roster() {
            var os = others(), here = {};
            os.forEach(function (m) {
                here[m.mid] = true;
                var r = remote(m.mid);
                r.name = m.name; r.seat = m.seat;
            });
            for (var mid in remotes) if (!here[mid]) {
                if (remotes[mid].src >= 0) {
                    fx.srcUsed[remotes[mid].src] = false;
                    if (roomOk) M._PortCoopRoomForget(remotes[mid].src);
                }
                delete remotes[mid];
            }
            for (var k in cpus) if (!here[cpus[k].mid]) delete cpus[k];
            for (var fm in world.fullTo) if (!here[fm]) delete world.fullTo[fm];
            assign();
        }
        function assign() {
            var os = others(), t = now();
            os.sort(function (a, b) { return ((a.seat < 0 ? 1e9 : a.seat) - (b.seat < 0 ? 1e9 : b.seat)) || a.mid - b.mid; });
            var humans = os.map(function (m) { return m.mid; }).filter(function (mid) { return remotes[mid]; });
            var auth = cpu.on && fxOk ? authority(t) : null;
            cpu.auth = auth;
            var helpers = [];
            if (auth !== null && auth !== net.mid && remotes[auth]) {
                var seen = remotes[auth].cpuSeen;
                for (var id in seen) if (t - seen[id] < STALL_MS) helpers.push(cpuKey(auth, +id));
                helpers.sort();
            }
            var want = {}, s;
            humans.concat(helpers).forEach(function (k) { want[k] = true; });
            for (s = 1; s <= SLOTS; s++) {
                var cur = slots[s];
                if (cur !== null && !isBlank(cur) && !want[cur]) freeSlot(s, auth !== null && auth !== net.mid);
            }
            function take(k, evict) {
                if (slotOfKey(k)) return true;
                var s2;
                for (s2 = 1; s2 <= SLOTS; s2++) if (slots[s2] === null) { place(s2, k); return true; }
                for (s2 = 1; s2 <= SLOTS; s2++) if (isBlank(slots[s2])) { place(s2, k); return true; }
                if (evict) for (s2 = SLOTS; s2 >= 1; s2--)
                    if (typeof slots[s2] === 'string') { place(s2, k); return true; }
                return false;
            }
            var shown = 0;
            humans.forEach(function (mid) { if (take(mid, true)) shown++; });
            helpers.forEach(function (k) { take(k, false); });
            hiddenOthers = os.length - shown;
            var blanks = auth !== null && auth !== net.mid;
            for (s = 1; s <= SLOTS; s++) {
                if (slots[s] === null && blanks) slots[s] = 'x' + s;
                else if (isBlank(slots[s]) && !blanks) freeSlot(s);
            }
        }

        /* Our own colour: the seat's (pink, yellow, red, green, then the
         * spray paints), so everyone sees everyone in the same colour; the
         * engine keeps a chosen spray paint instead (PortCoopSetLocalColor). */
        var myColor = null;
        function seatColor() {
            var ms = ((net.roster && net.roster.members) || []).slice();
            var me = null;
            for (var i = 0; i < ms.length; i++) if (ms[i].mid === net.mid) me = ms[i];
            if (!me) return null;
            var n = me.seat;
            if (!(n >= 0)) {
                ms.sort(function (a, b) { return a.mid - b.mid; });
                n = ms.indexOf(me);
            }
            return n < 4 ? n : 4 + (n - 4) % 10;
        }
        function colorTick() {
            if (typeof M._PortCoopSetLocalColor !== 'function') return;
            var c = seatColor();
            if (c === null || c === myColor) return;
            myColor = c;
            M._PortCoopSetLocalColor(c);
        }

        net.on('roster', roster);
        net.on('welcome', function () {
            /* (re)connected: start every stream over */
            for (var mid in remotes) { remotes[mid].jb.reset(); remotes[mid].fx = []; }
            for (var ck in cpus) cpus[ck].jb.reset();
            tx.key = true;
            world.fullTo = {};      /* deltas sent while we were away were lost */
        });
        /* extras: the CPU Kirbys a sender runs, and what its spawned objects
         * drew, per pose (see FX above) */
        function extras(from, str) {
            var r = remotes[from], b, t = now();
            if (!r || !fxOk) return;
            try { b = unb64(str); } catch (e) { return; }
            if (b.length < 2 || b[0] !== 1) return;
            if (r.fxResets !== r.jb.resets) { r.fx = []; r.fxResets = r.jb.resets; }
            for (var i = 0, n = b[1], o = 2; i < n; i++) {
                if (o + 3 > b.length) return;
                var seq = b[o] | (b[o + 1] << 8), nc = b[o + 2];
                o += 3;
                for (var j = 0; j < nc; j++) {
                    if (o + 1 + size > b.length) return;
                    var id = b[o];
                    if (id >= 1 && id <= SLOTS) {
                        cpuOf(from, id).jb.push(seq, b.slice(o + 1, o + 1 + size), t, 0);
                        r.cpuSeen[id] = t;
                        fx.stats.cpuRecv++;
                    }
                    o += 1 + size;
                }
                if (o + 2 > b.length) return;
                var fl = b[o] | (b[o + 1] << 8);
                o += 2;
                if (fl) {
                    if (fl < 4 || fl > FX_BYTES || o + fl > b.length) return;
                    r.fx.push({ t: r.jb.tOf(seq), b: b.slice(o, o + fl) });
                    if (r.fx.length > 24) r.fx.shift();
                    fx.stats.framesRecv++;
                    o += fl;
                }
            }
        }
        net.on('signal', function (m) {
            var d = m && m.data;
            if (d && typeof d.x === 'string') { extras(m.from, d.x); return; }
            if (d && (typeof d.tb === 'string' || typeof d.ts === 'string' || typeof d.bh === 'string'
                      || Array.isArray(d.sp) || Array.isArray(d.tk))) {
                roomSignal(m.from, d);
                return;
            }
            if (d && Array.isArray(d.call)) {
                /* someone called the helpers, and this page runs them */
                if (cpu.auth === net.mid && typeof M._PortCoopAnswerCall === 'function' && remotes[m.from]) {
                    var c = d.call.map(function (v) { return v | 0; });
                    var came = M._PortCoopAnswerCall(c[0], c[1], c[2]);
                    log('[coop] ' + nameOf(m.from) + ' called the helpers: ' + came + ' on the way');
                }
                return;
            }
            if (d && enemyOk && enemy.share && (typeof d.en === 'string' || typeof d.ev === 'string')) {
                var eb;
                try { eb = unb64(typeof d.en === 'string' ? d.en : d.ev); } catch (e) { return; }
                if (typeof d.en === 'string') {
                    if (eb.length < 4 || eb.length > RECORD_MAX) return;
                    enemy.stats.snapsRecv++;
                    enemy.inbox.push({ from: m.from, seq: d.s | 0, bytes: eb, nowF: now() / FRAME_MS });
                } else if (eb.length % 8 === 0 && eb.length <= 8 * 64) {
                    enemy.stats.evRecv++;
                    enemy.inbox.push({ from: m.from, ev: eb });
                }
                if (enemy.inbox.length > 128) enemy.inbox.shift();
                return;
            }
            if (!d || typeof d.prog !== 'string' || !worldOk || !world.share) return;
            var b;
            try { b = unb64(d.prog); } catch (e) { world.stats.bad++; return; }
            if (b.length < 10 || b.length > RECORD_MAX) { world.stats.bad++; return; }
            world.stats.recv++;
            world.inbox.push({ from: m.from, bytes: b });
            if (world.inbox.length > 256) world.inbox.shift();
        });
        net.on('pose', function (from, body) {
            var p = decodePoseBody(body);
            if (!p) return;
            stats.recv++;
            if (p.size !== size) { stats.sizeMismatch++; stats.mismatchFrom = from; return; }
            var r = remote(from), t = now();
            for (var i = 0; i < p.poses.length; i++)
                r.jb.push(p.poses[i].seq, p.poses[i].bytes, t, i === 0 ? p.flags : (p.flags & ~F_KEY));
        });

        /* This frame's extras: the CPU Kirbys this page runs for everyone (when
         * it is the one that does), and what spawned objects drew. */
        function sampleExtras() {
            if (!fxOk) return null;
            var list = [], fb = null, s, p = bufPtr(4);
            if (cpu.on && cpu.auth === net.mid)
                for (s = 1; s <= SLOTS; s++)
                    if (slots[s] === null && M._PortCoopSlotPose(s, p)) list.push({ id: s, b: heap().slice(p, p + size) });
            var fp = M._PortCoopFxBuffer(), n = M._PortCoopFxTake(fp, FX_BYTES);
            if (n >= 4) { fb = heap().slice(fp, fp + n); fx.lastOut = fb; }
            if (!list.length && !fb) return null;
            fx.stats.cpuSent += list.length;
            if (fb) fx.stats.framesSent++;
            return { cpus: list, fx: fb };
        }
        function encodeExtras(poses) {
            var any = false, len = 2, i, j;
            for (i = 0; i < poses.length; i++) {
                var x = poses[i].x;
                len += 5;
                if (!x) continue;
                any = true;
                len += x.cpus.length * (1 + size) + (x.fx ? x.fx.length : 0);
            }
            if (!any) return undefined;
            var out = new Uint8Array(len), o = 2;
            out[0] = 1;
            out[1] = poses.length;
            for (i = 0; i < poses.length; i++) {
                var e = poses[i].x;
                out[o] = poses[i].seq & 255; out[o + 1] = (poses[i].seq >> 8) & 255;
                out[o + 2] = e ? e.cpus.length : 0;
                o += 3;
                if (e) for (j = 0; j < e.cpus.length; j++) { out[o] = e.cpus[j].id; out.set(e.cpus[j].b, o + 1); o += 1 + size; }
                var fl = e && e.fx ? e.fx.length : 0;
                out[o] = fl & 255; out[o + 1] = fl >> 8;
                o += 2;
                if (fl) { out.set(e.fx, o); o += fl; }
            }
            return b64(out);
        }

        /* The live room.  Breaks and stars made here go to everyone; a player
         * whose pose arrives in my room (from another one) gets my room's
         * breaks; what arrives is applied by the engine, which checks the
         * room and the tile itself. */
        function roomTick() {
            if (!roomOk || !room.shareSet) return;
            var p = M._PortCoopFxBuffer(), n, i, b;
            n = M._PortCoopTilesTake(p, 320);
            if (n > 0) {
                net.sendSignal(null, { tb: b64(heap().slice(p, p + n)) });
                room.stats.tilesSent += n / 5;
            }
            n = M._PortCoopButtonsTake(p, 32);
            if (n > 0) net.sendSignal(null, { bh: b64(heap().slice(p, p + n)) });
            n = M._PortCoopStarTake(p, 16);
            for (i = 0; i < n; i++) {
                b = heap().slice(p + i * 12, p + i * 12 + 12);
                var dv = new DataView(b.buffer);
                if (b[0] === 1) {
                    net.sendSignal(null, { sp: [b[1], dv.getUint16(4, true), dv.getInt16(6, true), dv.getInt16(8, true),
                                                b[3], b[10], b[11]] });
                    room.stats.starsSent++;
                } else if (b[0] === 2) {
                    var owner = b[2] === 255 ? net.mid : null;
                    for (var om in remotes) if (remotes[om].src === b[2]) owner = +om;
                    if (owner !== null) { net.sendSignal(null, { tk: [owner, b[1]] }); room.stats.takenSent++; }
                }
            }
            var mine = tx.last && canRun(tx.last) ? poseRoom(tx.last) : null;
            for (var mid in remotes) {
                var r = remotes[mid], nb = r.jb.newest(), rr = nb && (nb[27] & F2_INLEVEL) ? poseRoom(nb) : null;
                if (rr !== r.lastRoom && rr !== null && rr === mine) {
                    var len = M._PortCoopTilesSnapshot(p, 516);
                    if (len > 4) {
                        net.sendSignal(+mid, { ts: b64(heap().slice(p, p + len)) });
                        room.stats.snapsSent++;
                    }
                }
                r.lastRoom = rr;
            }
        }
        function roomSignal(from, d) {
            if (!roomOk || !room.shareSet) return;
            var p = M._PortCoopFxBuffer(), b;
            try {
                if (typeof d.tb === 'string') {
                    b = unb64(d.tb);
                    if (b.length % 5 || b.length > 320) return;
                    heap().set(b, p);
                    room.stats.tilesRecv += b.length / 5;
                    room.stats.tilesApplied += M._PortCoopTilesApply(p, b.length);
                } else if (typeof d.bh === 'string') {
                    b = unb64(d.bh);
                    if (b.length % 4 || b.length > 32) return;
                    heap().set(b, p);
                    M._PortCoopButtonsApply(p, b.length);
                } else if (typeof d.ts === 'string') {
                    b = unb64(d.ts);
                    if (b.length < 4 || b.length > 516) return;
                    heap().set(b, p);
                    M._PortCoopTilesSetSnapshot(p, b.length);
                    room.stats.snapsRecv++;
                }
            } catch (e) { return; }
            if (Array.isArray(d.sp) && d.sp.length >= 7 && remotes[from]) {
                var v = d.sp.map(function (x) { return x | 0; }), r = remotes[from];
                if (srcOf(r) < 0) return;
                var who = (v[6] >> 4) & 3, slot = slotOfKey(who === 0 ? +from : cpuKey(from, who));
                room.stats.starsRecv++;
                room.stats.starsMade += M._PortCoopStarSpawn(r.src, v[0] & 255, v[1], v[2], v[3], v[4], v[5], v[6] & 15, slot || 0);
            }
            if (Array.isArray(d.tk) && d.tk.length >= 2) {
                var ow = d.tk[0] | 0, id = d.tk[1] & 255;
                room.stats.takenRecv++;
                if (ow === net.mid) M._PortCoopStarTaken(255, id);
                else if (remotes[ow] && remotes[ow].src >= 0) M._PortCoopStarTaken(remotes[ow].src, id);
            }
        }

        /* The local player used the phone: the game that runs the helpers
         * sends them (that game's own phone needs nothing from here). */
        var callBuf = 0;
        function callTick() {
            if (typeof M._PortCoopTakeCall !== 'function') return;
            if (!callBuf) callBuf = M._malloc(12);
            if (!M._PortCoopTakeCall(callBuf)) return;
            var v = new Int32Array(heap().buffer, callBuf, 3);
            if (cpu.auth !== null && cpu.auth !== net.mid && net.state === 'open')
                net.sendSignal(cpu.auth, { call: [v[0], v[1], v[2]] });
        }

        function send(t) {
            var open = net.state === 'open';
            var anyone = open && others().length > 0;
            if (!anyone) {
                tx.pending = [];
                tx.key = true;
                return;
            }
            var ptr = bufPtr(0);
            var b = M._PortCoopLocalPose(ptr) ? heap().slice(ptr, ptr + size) : hiddenPose(size);
            var seq = Math.round(t / FRAME_MS) & 0xFFFF;
            var ext = sampleExtras();
            var pend = tx.pending;
            if (pend.length && pend[pend.length - 1].seq === seq) { pend[pend.length - 1].bytes = b; pend[pend.length - 1].x = ext; }
            else pend.push({ seq: seq, bytes: b, x: ext });
            if (pend.length > 4) pend.splice(0, pend.length - 4);
            /* a sample left over from before a freeze would arrive seconds late and
             * make the receiver think the link is that jittery */
            while (pend.length > 1 && ((seq - pend[0].seq) & 0xFFFF) > 8) pend.shift();
            if (paused) {
                if (!tx.pausedSent) {
                    net.sendPose(encodePoseUp(F_PAUSED | (tx.key ? F_KEY : 0), [pend[pend.length - 1]]));
                    tx.pausedSent = true;
                    tx.key = false;
                    stats.sent++;
                }
                tx.pending = [];
                return;
            }
            tx.unchanged = same(b, tx.last) && !ext ? tx.unchanged + 1 : 0;
            tx.last = b;
            var since = t - tx.lastAt;
            var idle = tx.unchanged >= IDLE_AFTER;
            var due = tx.key || (idle ? since >= IDLE_MS
                                      : (pend.length >= 2 && since >= SEND_MIN_MS) || since >= SEND_MAX_MS);
            if (!due) return;
            var poses = idle ? [pend[pend.length - 1]] : pend;
            if (net.sendPose(encodePoseUp(tx.key ? F_KEY : 0, poses), encodeExtras(poses))) {
                stats.sent++;
                stats.sentPoses += poses.length;
                tx.key = false;
            }
            tx.pending = [];
            tx.lastAt = t;
        }

        function apply(t) {
            var ready = !!M._PortCoopReady();
            if (ready && !wasReady)
                for (var s0 = 1; s0 <= SLOTS; s0++) puppetOn[s0] = false;   /* re-assert after a level load */
            wasReady = ready;
            if (!ready) return;
            var open = net.state === 'open';
            for (var s = 1; s <= SLOTS; s++) {
                var mid = slots[s];
                if (mid === null) continue;
                if (!puppetOn[s]) { M._PortCoopSetPuppet(s, 1); puppetOn[s] = true; }
                /* players before CPU Kirbys, for the enemies (coop.c) */
                if (typeof M._PortCoopSetPuppetCpu === 'function') M._PortCoopSetPuppetCpu(s, typeof mid === 'number' ? 0 : 1);
                var r = typeof mid === 'number' ? remotes[mid] : cpus[mid];
                var out = open && r ? r.jb.sample(t) : { state: 'absent', away: true };
                if (r) r.out = out;
                if (out.state === 'pose') {
                    var ptr = bufPtr(s);
                    heap().set(out.bytes, ptr);
                    M._PortCoopSetPose(s, ptr);
                    applied[s] = out.bytes;
                } else {
                    M._PortCoopSetAbsent(s);
                    applied[s] = null;
                }
            }
            applyFx();
        }

        /* The engine's source number for a remote player (ghosts, stars). */
        function srcOf(r) {
            if (r.src < 0)
                for (var q = 0; q < FX_SOURCES; q++) if (!fx.srcUsed[q]) { fx.srcUsed[q] = true; r.src = q; break; }
            return r.src;
        }

        /* Each sender's spawned objects, at the frame its pose is being played
         * at, with its Kirby palettes moved to the slots showing those Kirbys. */
        function applyFx() {
            if (!fxOk) return;
            var fp = M._PortCoopFxBuffer();
            for (var mid in remotes) {
                var r = remotes[mid], fr = null;
                if (srcOf(r) < 0) continue;
                if (r.fxResets !== r.jb.resets) { r.fx = []; r.fxResets = r.jb.resets; }
                var c = r.jb.cursor;
                if (!r.fx.length || c === null || !r.out || r.out.state !== 'pose') continue;
                while (r.fx.length && r.fx[0].t < c - 6) r.fx.shift();
                for (var i = r.fx.length - 1; i >= 0; i--) if (r.fx[i].t <= c + 0.5) { fr = r.fx[i]; break; }
                if (!fr || c - fr.t > 2.5) continue;
                var b = fr.b.slice(), n = b[2];
                for (var k = 0; k < n && 4 + (k + 1) * FX_REC <= b.length; k++) {
                    var o = 4 + k * FX_REC + 10, pal = b[o];
                    if (pal >= 8) continue;
                    var ks = pal & 3, sl = slotOfKey(ks === 0 ? +mid : cpuKey(mid, ks));
                    b[o] = sl ? ((pal & 4) | sl) : 0xFF;
                    if (!sl) { var uk = mid + ':' + pal; fx.stats.unmapped[uk] = (fx.stats.unmapped[uk] || 0) + 1; }
                }
                heap().set(b, fp);
                M._PortCoopFxSet(r.src, fp, b.length);
                fx.stats.framesSet++;
            }
        }

        /* A player's Kirby colour, '#rrggbb', from a pose: their own colour
         * (bytes 32..35, platform/kirby_color.c) or one of the game's
         * fourteen (byte 24).  null when unknown. */
        function colorOf(b) {
            if (!b || b.length < 36) return null;
            var c = b[32] | (b[33] << 8), v;
            if (c & 0x8000) {
                var r = c & 31, g = (c >> 5) & 31, bl = (c >> 10) & 31;
                v = (((r << 3) | (r >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((bl << 3) | (bl >> 2));
            } else if (b[24] < 14 && typeof M._PortKirbyColorSwatch === 'function') {
                v = M._PortKirbyColorSwatch(b[24], 0);
                if (v < 0) return null;
            } else return null;
            return '#' + ('00000' + v.toString(16)).slice(-6);
        }

        /* Where to put the other players' names: platform/ui/coop_tags.c.
         * Ids are draw ids -- the puppet slots today; players drawn outside
         * gKirbys (more than four) will add ids of their own. */
        var TAG_MAX = 16, tagBuf = 0;
        function midOfDrawId(id) {
            var k = id >= 1 && id <= SLOTS ? slots[id] : null;
            return typeof k === 'number' ? k : null;   /* CPU Kirbys get no tag */
        }
        function bytesOfDrawId(id) {
            return id >= 1 && id <= SLOTS ? applied[id] : null;
        }
        function tags() {
            if (missing.length || typeof M._PortCoopTags !== 'function') return null;
            if (!tagBuf) tagBuf = M._malloc(4 * (4 + 4 * TAG_MAX));
            var n = M._PortCoopTags(tagBuf, TAG_MAX), list = [];
            if (n <= 0) return { rect: null, list: list };
            var f = new Float32Array(heap().buffer, tagBuf, 4 + 4 * n);
            for (var i = 0; i < n; i++) {
                var id = f[4 + i * 4], mid = midOfDrawId(id);
                if (mid === null || mid === undefined) continue;
                list.push({ mid: mid, name: nameOf(mid), x: f[5 + i * 4], y: f[6 + i * 4],
                            off: f[7 + i * 4] === 2, color: colorOf(bytesOfDrawId(id)) });
            }
            return { rect: [f[0], f[1], f[2], f[3]], list: list };
        }

        function nameOf(mid) {
            var ms = (net.roster && net.roster.members) || [];
            for (var i = 0; i < ms.length; i++)
                if (ms[i].mid === mid) return ms[i].name === 'Player' && ms[i].seat >= 0 ? 'Player ' + (ms[i].seat + 1) : ms[i].name;
            return 'Someone';
        }

        function notice(mid, news, full) {
            world.stats.news++;
            var line = describeNews(news, full, function (k) { return M._PortCoopWorldCount(k); });
            if (!line) return;
            var who = mid === null ? 'The room' : nameOf(mid);
            log('[coop] ' + who + ' ' + line);
            if (self.onNotice) {
                try { self.onNotice({ who: who, mid: mid, text: line, news: news, full: full }); } catch (e) { /* page */ }
            }
        }

        /* Which room the local player is in (null: not in one). */
        function myRoom() {
            return tx.last && !poseHidden(tx.last) ? poseRoom(tx.last) : null;
        }
        /* The players in a room as this page sees them: itself, and every
         * shown remote whose played-back pose is there.  The owner is the
         * lowest member id; two pages that briefly disagree both run their
         * own enemies, which is what happens without co-op at all. */
        function roomMembers(room) {
            var list = [];
            if (room === null) return list;
            if (myRoom() === room) list.push(net.mid);
            for (var mid in remotes) {
                var r = remotes[mid];
                if (r.slot && r.out && r.out.state === 'pose' && !r.out.away && !poseHidden(r.out.bytes)
                    && poseRoom(r.out.bytes) === room) list.push(+mid);
            }
            return list;
        }

        function enemyTick(t) {
            if (!enemyOk) return;
            if (enemy.shareSet !== enemy.share) {
                M._PortCoopEnemyShare(enemy.share ? 1 : 0);
                enemy.shareSet = enemy.share;
            }
            if (!enemy.share) { enemy.inbox = []; return; }
            var buf = M._PortCoopRecordBuffer(), nowF = t / FRAME_MS;
            var room = myRoom(), members = roomMembers(room);
            var owner = members.length ? Math.min.apply(null, members) : null;
            if (owner !== enemy.owner) { enemy.owner = owner; enemy.buf.reset(); }
            var slotOf = function (mid) { return remotes[mid] ? remotes[mid].slot : 0; };
            /* incoming: events always, snapshots only from this room's owner */
            while (enemy.inbox.length) {
                var e = enemy.inbox.shift();
                if (e.ev) {
                    for (var i = 0; i + 8 <= e.ev.length; i += 8) {
                        var dmg = e.ev[i + 6] | (e.ev[i + 7] << 8);
                        if (dmg & 0x8000) dmg -= 0x10000;
                        M._PortCoopEnemyEvent(e.ev[i], e.ev[i + 2] | (e.ev[i + 3] << 8), e.ev[i + 4] | (e.ev[i + 5] << 8),
                                              dmg, slotOf(e.from));
                    }
                } else if (owner !== null && e.from === owner && owner !== net.mid
                           && (e.bytes[0] | (e.bytes[1] << 8)) === room) {
                    enemy.buf.push(e.from, e.seq, e.bytes, e.nowF);
                }
            }
            if (owner !== null && owner !== net.mid) {
                var snap = enemy.buf.sample(nowF);
                if (snap) {
                    heap().set(snap, buf);
                    M._PortCoopEnemySetPoses(buf, snap.length);
                    enemy.stats.snapsUsed++;
                }
            }
            /* outgoing events */
            var os = net.state === 'open' ? others() : [];
            var n = M._PortCoopEnemyTake(buf, 64);
            if (n > 0 && os.length && net.sendSignal(null, { ev: b64(heap().slice(buf, buf + n * 8)) })) enemy.stats.evSent++;
            /* the owner streams the room's enemies to the others in it */
            if (owner !== net.mid || members.length < 2 || t - enemy.lastSent < EN_SEND_MS) return;
            var len = M._PortCoopEnemyCollect(buf, RECORD_MAX);
            if (len < 4) return;
            enemy.lastSent = t;
            var data = { en: b64(heap().slice(buf, buf + len)), s: Math.round(t / FRAME_MS) & 0xFFFF };
            members.forEach(function (mid) { if (mid !== net.mid) net.sendSignal(mid, data); });
            enemy.stats.snapsSent++;
        }

        /* Every frame: merge what came in, send what is new here.  Records are
         * opaque; the engine says what they meant. */
        function worldTick() {
            if (!worldOk) return;
            if (world.shareSet !== world.share) {
                M._PortCoopWorldShare(world.share ? 1 : 0);
                world.shareSet = world.share;
            }
            if (!world.share) { world.inbox = []; return; }
            var buf = M._PortCoopRecordBuffer();
            while (world.inbox.length) {
                var r = world.inbox.shift();
                heap().set(r.bytes, buf);
                var res = M._PortCoopWorldApply(buf, r.bytes.length);
                if (res === -1) world.stats.queued++;
                else if (res < 0) world.stats.bad++;
                else {
                    world.stats.applied++;
                    if (res) notice(r.from, res, r.bytes[2] === REC_FULL);
                }
            }
            var late = M._PortCoopWorldNews();
            if (late) notice(null, late, true);

            var os = net.state === 'open' ? others() : [];
            var len = M._PortCoopWorldTake(buf, 0);       /* always: keeps the shadow current */
            if (len > 0 && os.length) {
                var rec = heap().slice(buf, buf + len);
                if (net.sendSignal(null, { prog: b64(rec) })) {
                    world.stats.sent++;
                    if (rec[2] === REC_FULL) {
                        world.stats.sentFull++;
                        os.forEach(function (m) { world.fullTo[m.mid] = true; });
                    }
                }
            }
            if (!os.length || !M._PortCoopWorldTracking()) return;
            var need = os.filter(function (m) { return !world.fullTo[m.mid]; });
            if (!need.length) return;
            var l2 = M._PortCoopWorldTake(buf, 1);
            if (l2 <= 0) return;
            var data = { prog: b64(heap().slice(buf, buf + l2)) };
            need.forEach(function (m) {
                if (net.sendSignal(m.mid, data)) { world.fullTo[m.mid] = true; world.stats.sent++; world.stats.sentFull++; }
            });
        }

        var self = {
            onNotice: null,
            enemyStats: enemy.stats,
            enemyOk: enemyOk,
            setEnemies: function (on) { enemy.share = !!on; },
            enemies: function () { return enemyOk && enemy.share; },
            enemyOwner: function () { return enemy.owner; },
            worldStats: world.stats,
            worldOk: worldOk,
            setShare: function (on) { world.share = !!on; },
            sharing: function () { return worldOk && world.share; },
            size: size,
            missing: missing,
            stats: stats,
            /* once per presented frame */
            tick: function () {
                if (missing.length) return;
                if (!enabled) { M._PortCoopEnable(1); enabled = true; }
                var t = now();
                stats.frames++;
                colorTick();
                if (fxOk) {
                    var want = fx.on && net.state === 'open' && others().length > 0;
                    if (fx.shareSet !== want) { M._PortCoopFxShare(want ? 1 : 0); fx.shareSet = want; }
                    var wantRoom = roomOk && room.on && want;
                    if (roomOk && room.shareSet !== wantRoom) { M._PortCoopRoomShare(wantRoom ? 1 : 0); room.shareSet = wantRoom; }
                }
                assign();
                callTick();
                send(t);
                apply(t);
                enemyTick(t);
                worldTick();
                roomTick();
            },
            /* the tab is hidden (coop.js): tell the others once, then send
             * nothing; on return start every remote stream over (latest only) */
            setPaused: function (on) {
                on = !!on;
                if (on === paused) return;
                paused = on;
                tx.pausedSent = false;
                if (!on) {
                    tx.key = true;
                    for (var mid in remotes) remotes[mid].jb.reset();
                    for (var ck in cpus) cpus[ck].jb.reset();
                }
            },
            stop: function () {
                if (missing.length) return;
                for (var s = 1; s <= SLOTS; s++) if (slots[s] !== null) freeSlot(s);
                if (enabled) M._PortCoopEnable(0);
                if (worldOk && world.shareSet) M._PortCoopWorldShare(0);
                if (enemyOk && enemy.shareSet) M._PortCoopEnemyShare(0);
                enemy.shareSet = null;
                if (fxOk && fx.shareSet) M._PortCoopFxShare(0);
                fx.shareSet = null;
                if (roomOk && room.shareSet) M._PortCoopRoomShare(0);
                room.shareSet = null;
                if (typeof M._PortCoopSetLocalColor === 'function') M._PortCoopSetLocalColor(-1);
                myColor = null;
                world.shareSet = null;
                enabled = false;
            },
            slotOf: function (mid) { return remotes[mid] ? remotes[mid].slot : 0; },
            /* the name tags (page): {rect: [x0, y0, x1, y1] | null, list: [{mid, name,
             * x, y, off, color}]}, positions as fractions of the canvas */
            tags: tags,
            /* '#rrggbb' of a player's Kirby (null: not known yet), and our own */
            colorOf: function (mid) { var r = remotes[mid]; return r && r.slot ? colorOf(applied[r.slot]) : null; },
            myColor: function () { return colorOf(tx.last); },
            applied: function (slot) { return applied[slot]; },
            /* tests and the chip: who runs the CPU Kirbys, what each slot shows,
             * and the spawned-object counters (engine: PortCoopFxStat) */
            cpuState: function () {
                var cs = {};
                for (var k in cpus) cs[k] = cpus[k].slot;
                return { auth: cpu.auth, me: net.mid, slots: slots.slice(), on: cpu.on && fxOk, cpus: cs };
            },
            roomStats: function () {
                var e = [];
                if (roomOk && typeof M._PortCoopRoomStat === 'function') for (var i = 0; i < 12; i++) e.push(M._PortCoopRoomStat(i));
                return { page: room.stats, engine: e };
            },
            fxStats: function () {
                var e = [];
                if (fxOk) for (var i = 0; i < 20; i++) e.push(M._PortCoopFxStat(i));
                return { page: fx.stats, engine: e, lastOut: fx.lastOut || null };
            },
            /* for the status chip */
            status: function () {
                var list = others().map(function (m) {
                    var r = remotes[m.mid];
                    return { mid: m.mid, name: m.name, seat: m.seat, slot: r ? r.slot : 0,
                             away: !r || !r.out || !!r.out.away, rtt: m.rtt };
                });
                return { state: net.state, players: list, hidden: hiddenOthers, missing: missing,
                         sizeMismatch: stats.sizeMismatch, paused: paused };
            },
        };
        return self;
    }

    /* --- tab identity ------------------------------------------------------------
     * The room gives a returning identity its old member record back, and a
     * second socket with the same identity evicts the first ('replaced').  So
     * the identity is per tab (sessionStorage: survives a reload), and -- since
     * duplicating a tab copies sessionStorage -- it is used only while this
     * page holds a Web Lock named after it (soh-web, AnchorWeb.cpp): the tab
     * it came from holds it, so a duplicate waits LOCK_WAIT_MS and mints a
     * fresh one.  A reloading page lets go of its lock as it unloads.
     *
     * o: {storage: {get(), set(v)}, locks: navigator.locks | null,
     *     mint: () => string, name?: lock prefix, waitMs?}  -> Promise<id> */
    function claimIdentity(o) {
        var prefix = o.name || 'katam-coop-id-';
        var wait = o.waitMs === undefined ? 1500 : o.waitMs;
        var stored = null;
        try { stored = o.storage.get(); } catch (e) { /* none */ }
        function hold(id) {
            /* keep the lock for the page's lifetime */
            if (!o.locks) return;
            o.locks.request(prefix + id, { ifAvailable: true }, function (lock) {
                if (!lock) return undefined;
                return new Promise(function () {});
            }).catch(function () {});
        }
        function fresh() {
            var id = o.mint();
            try { o.storage.set(id); } catch (e) { /* private mode */ }
            hold(id);
            return id;
        }
        if (!stored) return Promise.resolve(fresh());
        if (!o.locks) return Promise.resolve(stored);
        return new Promise(function (resolve) {
            var done = false;
            var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                if (ctl) ctl.abort();
                resolve(fresh());
            }, wait);
            o.locks.request(prefix + stored, ctl ? { signal: ctl.signal } : {}, function () {
                if (done) return undefined;
                done = true;
                clearTimeout(timer);
                resolve(stored);
                return new Promise(function () {});
            }).catch(function () {});
        });
    }

    return {
        claimIdentity: claimIdentity,
        SIM: SIM, FRAME_MS: FRAME_MS, REQUIRED: REQUIRED, F_PAUSED: F_PAUSED, F_KEY: F_KEY,
        STALL_MS: STALL_MS, D_MAX: D_MAX, EXTRAP_MAX: EXTRAP_MAX,
        create: create, JitterBuffer: JitterBuffer, encodePoseUp: encodePoseUp,
        decodePoseBody: decodePoseBody, poseX: poseX, poseY: poseY, poseRoom: poseRoom,
        poseHidden: poseHidden, lerpPose: lerpPose,
        WORLD: WORLD, NEWS: NEWS, ENEMY: ENEMY, FX: FX, ROOM: ROOM, EnemyBuffer: EnemyBuffer, describeNews: describeNews, b64: b64, unb64: unb64,
    };
}));

/* --- part 2: the page ---------------------------------------------------------
 *
 *   ?coop=BCDF                      join that co-op room
 *   ?coop=1  (or ?coop=new)         create one; the URL becomes ?coop=CODE
 *   a page served at .../mp/         the same as ?coop=1 when no code is given
 *                                   in place (no reload)
 *   &coopRelay=http://127.0.0.1:8787   a non-default server (dev relay,
 *                                   wrangler dev).  Not ?relay=: that one
 *                                   switches on the v1 link cable in the shell.
 *
 * Everyone keeps their own save and runs their own game; nothing here holds
 * the game, blanks save memory or reloads the page.  Without ?coop this file
 * only defines window.KatamCoopPage.  It never acts alongside ?room=,
 * ?online or ?world= (the lockstep lobby and the v1 world).
 *
 * The logic is part 1 (window.KatamCoop); the connection is
 * web/net_session.js (window.KatamNet), loaded before this.  This is the glue: URL, tab
 * identity, ROM hash, the per-frame hook, page visibility, and a small
 * status chip with the code, who is here and an invite link.
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || !window.KatamNet || !window.KatamCoop) return;
    var Net = window.KatamNet, Coop = window.KatamCoop;
    var q = new URLSearchParams(location.search);
    var raw = q.get('coop');
    window.KatamCoopPage = { claims: false };
    /* the page published at /mp/ is the co-op one: a plain visit creates a room */
    if (raw === null && /\/mp\/(index\.html)?$/.test(location.pathname)
        && !q.get('room') && !q.has('online') && !q.get('world')) raw = '1';
    if (raw === null) return;
    if (q.get('room') || q.has('online') || q.get('world')) {
        console.warn('[coop] ?coop is ignored next to ?room / ?online / ?world');
        return;
    }
    var M = window.Module;
    if (!M || !M.portRomReady) return;
    window.KatamCoopPage.claims = true;
    var RELAY = q.get('coopRelay');
    var BASE = (RELAY || Net.DEFAULT_BASE).replace(/\/+$/, '');
    var creating = /^(1|new|true|)$/i.test(raw);
    var S = {
        code: creating ? null : Net.normalizeCode(raw),
        error: creating || Net.normalizeCode(raw) ? null : (Net.explainCode(raw) || 'Not a valid code'),
        net: null, coop: null, open: false, stale: false, copied: 0,
    };
    var log = function (t) { if (M.portDiag) { try { M.portDiag(t, 0); } catch (e) { /* */ } } else console.log(t); };

    /* --- styles and DOM ---------------------------------------------------- */
    var css = [
        '#coopchip{position:fixed;z-index:55;left:calc(10px + env(safe-area-inset-left));top:calc(10px + env(safe-area-inset-top));',
        ' max-width:min(340px,calc(100vw - 20px));background:rgba(20,22,26,.88);border:1px solid var(--edge,#2b3038);',
        ' border-radius:14px;font:12px/1.4 var(--mono,monospace);color:var(--text,#d5d9e0);user-select:text;-webkit-user-select:text}',
        '#coopchip .cc-head{display:flex;gap:6px;align-items:center;padding:4px 10px;cursor:pointer;min-height:26px;',
        ' background:none;border:0;color:inherit;font:inherit;width:100%;text-align:left}',
        '#coopchip .cc-dot{width:8px;height:8px;border-radius:50%;background:#555;flex:0 0 auto}',
        '#coopchip .cc-dot.on{background:#3fb950}#coopchip .cc-dot.wait{background:var(--warn,#e8b23a)}',
        '#coopchip .cc-dot.bad{background:var(--err,#ff7b72)}',
        '#coopchip .cc-body{display:none;padding:2px 10px 9px}#coopchip.open .cc-body{display:block}',
        '#coopchip ul{list-style:none;margin:4px 0;padding:0}#coopchip li{padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '#coopchip .cc-dim{color:var(--dim,#838b98)}#coopchip .cc-err{color:var(--err,#ff7b72);white-space:normal}',
        '#coopchip .cc-row{display:flex;gap:6px;margin-top:6px}',
        '#coopchip input{flex:1 1 auto;min-width:0;font:inherit;color:inherit;background:var(--void,#0c0e11);',
        ' border:1px solid var(--edge,#2b3038);border-radius:7px;padding:4px 6px}',
        '#coopchip button.cc-b{font:inherit;color:inherit;background:var(--panel-2,#232730);border:1px solid var(--edge,#2b3038);',
        ' border-radius:7px;padding:4px 9px;cursor:pointer}',
        '#coopchip label.cc-opt{display:flex;gap:6px;align-items:center;justify-content:flex-start;margin-top:6px;cursor:pointer}',
        '#coopchip label.cc-opt input{flex:0 0 auto;width:auto;margin:0}',
        '#coopnotes{position:fixed;z-index:55;left:calc(10px + env(safe-area-inset-left));top:calc(48px + env(safe-area-inset-top));',
        ' display:flex;flex-direction:column;gap:4px;pointer-events:none;max-width:min(340px,calc(100vw - 20px))}',
        '#coopnotes div{background:rgba(20,22,26,.9);border:1px solid var(--edge,#2b3038);border-radius:10px;padding:4px 10px;',
        ' font:12px/1.4 var(--mono,monospace);color:var(--text,#d5d9e0);transition:opacity .5s}',
        '#coopnotes div.out{opacity:0}',
        '#coopchip .cc-sw{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;',
        ' vertical-align:-1px;box-shadow:0 0 0 1px rgba(0,0,0,.6)}',
        '#cooptags{position:fixed;left:0;top:0;width:0;height:0;z-index:54;pointer-events:none}',
        '#cooptags .ct{position:absolute;left:0;top:0;white-space:nowrap;padding:1px 7px 1px 6px;',
        ' border-radius:9px;background:rgba(16,18,22,.72);color:#eef0f3;font:600 12px/1.3 var(--mono,monospace);',
        ' border-bottom:2px solid #aaa;text-shadow:0 1px 1px #000;will-change:transform}',
        '#cooptags .ct.off{opacity:.85;font-weight:400}',
        '#cooptags .ct i{font-style:normal;margin-right:4px;opacity:.9}',
    ].join('\n');
    var chip = document.createElement('div');
    chip.id = 'coopchip';
    chip.setAttribute('role', 'status');
    chip.innerHTML = '<button type="button" class="cc-head"><span class="cc-dot"></span><span class="cc-t"></span></button>' +
        '<div class="cc-body"></div>';
    var head = chip.firstChild, body = chip.lastChild;
    head.onclick = function () { S.open = !S.open; render(); placeNotes(); };
    body.addEventListener('click', function (e) {
        var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (a === 'copy') copyLink();
        else if (a === 'new') newRoom();
        else if (a === 'rejoin') rejoin();
        else if (a === 'color') openColor();
    });
    body.addEventListener('change', function (e) {
        var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (a === 'share') {
            try { localStorage.katamCoopShare = e.target.checked ? '1' : '0'; } catch (err) { /* private mode */ }
            if (S.coop) S.coop.setShare(e.target.checked);
        } else if (a === 'names') {
            try { localStorage.katamCoopNames = e.target.checked ? '1' : '0'; } catch (err) { /* private mode */ }
            drawTags();
        } else if (a === 'enemies') {
            try { localStorage.katamCoopEnemies = e.target.checked ? '1' : '0'; } catch (err) { /* private mode */ }
            if (S.coop) S.coop.setEnemies(e.target.checked);
        } else if (a === 'name') {
            var n = String(e.target.value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
            try { localStorage.katamNetName = n; } catch (err) { /* private mode */ }
            if (S.net && n) S.net.rename(n);
        } else return;
        lastBody = null;
        render();
    });
    /* typing in the name field must not drive Kirby */
    body.addEventListener('keydown', function (e) {
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-a') === 'name') {
            e.stopPropagation();
            if (e.key === 'Enter') e.target.blur();
        }
    }, true);
    var notes = document.createElement('div');
    notes.id = 'coopnotes';
    notes.setAttribute('aria-live', 'polite');
    var tagLayer = document.createElement('div');
    tagLayer.id = 'cooptags';
    tagLayer.setAttribute('aria-hidden', 'true');
    function mount() {
        var st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);
        document.body.appendChild(tagLayer);
        document.body.appendChild(chip);
        document.body.appendChild(notes);
        render();
        requestAnimationFrame(tagFrame);
    }

    /* --- name tags over the other players (platform/ui/coop_tags.c) ---------- */
    function namesWanted() {
        try { return localStorage.katamCoopNames !== '0'; } catch (e) { return true; }
    }
    function gameCanvas() {
        var c = M.portGlCanvas || document.getElementById('screen');
        return c && c.offsetParent !== null ? c : (M.portGlCanvas || document.getElementById('screen'));
    }
    var tagEls = {};                      /* mid -> element */
    function tagFrame() {
        drawTags();
        requestAnimationFrame(tagFrame);
    }
    function drawTags() {
        var t = S.coop && namesWanted() && document.visibilityState !== 'hidden' ? S.coop.tags() : null;
        var seen = {}, cv = t && t.rect ? gameCanvas() : null, placed = [];
        if (cv && t.list.length) {
            var r = cv.getBoundingClientRect();
            /* the picture's own rectangle inside the canvas, in page pixels */
            var px0 = r.left + t.rect[0] * r.width, py0 = r.top + t.rect[1] * r.height;
            var px1 = r.left + t.rect[2] * r.width, py1 = r.top + t.rect[3] * r.height;
            var fs = Math.max(11, Math.min(15, Math.round((py1 - py0) / 34)));
            t.list.forEach(function (g) {
                var el = tagEls[g.mid];
                if (!el) {
                    el = tagEls[g.mid] = document.createElement('div');
                    el.className = 'ct';
                    el.appendChild(document.createElement('i'));
                    el.appendChild(document.createElement('span'));
                    tagLayer.appendChild(el);
                }
                seen[g.mid] = true;
                if (el.lastChild.textContent !== g.name) el.lastChild.textContent = g.name;
                el.style.fontSize = fs + 'px';
                el.style.borderBottomColor = g.color || '#aaa';
                var w = el.offsetWidth || 60, h = el.offsetHeight || 18, m = 4;
                /* the tag's bottom centre sits just above the Kirby's head */
                var x = r.left + g.x * r.width, y = r.top + g.y * r.height - 3, arrow = '';
                if (g.off || x < px0 || x > px1 || y < py0 + h || y > py1) {
                    /* in the room but off the picture: pinned to its edge,
                     * pointing the way */
                    if (x < px0 + w / 2 + m) arrow = '\u25C0';
                    else if (x > px1 - w / 2 - m) arrow = '\u25B6';
                    else if (y < py0 + h + m) arrow = '\u25B2';
                    else if (y > py1 - m) arrow = '\u25BC';
                    x = Math.max(px0 + w / 2 + m, Math.min(px1 - w / 2 - m, x));
                    y = Math.max(py0 + h + m, Math.min(py1 - m, y));
                }
                if (el.firstChild.textContent !== arrow) el.firstChild.textContent = arrow;
                el.firstChild.style.display = arrow ? '' : 'none';
                el.classList.toggle('off', !!arrow);
                placed.push({ el: el, x: x, y: y, w: w, h: h });
            });
            /* tags on top of each other: lift the later ones clear */
            for (var i = 1; i < placed.length; i++) {
                for (var j = 0, guard = 0; j < i && guard < 64; j++) {
                    var a = placed[i], b = placed[j];
                    if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2) {
                        a.y = Math.min(a.y, b.y) - (a.h + b.h) / 2 - 2;
                        j = -1;                 /* check again from the start */
                        guard++;
                    }
                }
            }
            placed.forEach(function (p) {
                p.el.style.transform = 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y) + 'px) translate(-50%,-100%)';
                p.el.style.display = '';
            });
        }
        for (var mid in tagEls) {
            if (seen[mid]) continue;
            if (tagEls[mid].parentNode) tagEls[mid].parentNode.removeChild(tagEls[mid]);
            delete tagEls[mid];
        }
    }

    /* the settings menu's Kirby page (platform/ui/ui_menu.cpp) */
    function openColor() {
        var ok = typeof M._PortUiOpenPageJs === 'function' && M._PortUiOpenPageJs(1);
        if (!ok) note('The colour picker is in the settings menu, which needs WebGL2 -- this browser has it off.');
    }
    /* a line under the chip for a few seconds: what other players found */
    function placeNotes() {
        var r = chip.getBoundingClientRect();
        notes.style.top = Math.round(r.bottom + 6) + 'px';
    }
    function note(text) {
        placeNotes();
        var d = document.createElement('div');
        d.textContent = text;
        notes.appendChild(d);
        while (notes.childNodes.length > 4) notes.removeChild(notes.firstChild);
        setTimeout(function () { d.className = 'out'; }, 5000);
        setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 5600);
    }
    function shareWanted() {
        try { return localStorage.katamCoopShare !== '0'; } catch (e) { return true; }
    }
    function enemiesWanted() {
        try { return localStorage.katamCoopEnemies !== '0'; } catch (e) { return true; }
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function link(code) {
        var u = new URL(location.href);
        u.search = '';
        u.hash = '';
        u.searchParams.set('coop', code);
        if (RELAY) u.searchParams.set('coopRelay', RELAY);
        return u.toString();
    }

    /* ?coop=1 -> ?coop=CODE, keeping the page's other parameters */
    function rewriteUrl(code) {
        var u = new URL(location.href);
        u.searchParams.set('coop', code);
        try { history.replaceState(history.state, '', u.toString()); } catch (e) { /* file:// etc. */ }
    }

    function copyLink() {
        if (!S.code) return;
        var l = link(S.code);
        var done = function () { S.copied = Date.now(); render(); };
        if (navigator.clipboard && navigator.clipboard.writeText)
            navigator.clipboard.writeText(l).then(done, function () { selectLink(); });
        else selectLink();
    }
    function selectLink() {
        var i = body.querySelector('input');
        if (i) { i.focus(); i.select(); }
    }

    function render() {
        var dot = head.firstChild, t = head.lastChild;
        var net = S.net, st = S.coop ? S.coop.status() : null;
        var n = st ? st.players.length + 1 : 1;
        var cls = 'cc-dot', line;
        if (S.error) { cls += ' bad'; line = 'Co-op: ' + (S.code || 'error'); }
        else if (!S.code) { cls += ' wait'; line = 'Co-op: making a room...'; }
        else if (!net || net.state === 'connecting') { cls += ' wait'; line = 'Co-op ' + S.code + ': connecting'; }
        else if (net.state === 'lost') { cls += ' wait'; line = 'Co-op ' + S.code + ': reconnecting'; }
        else if (net.state === 'closed') { cls += ' bad'; line = 'Co-op ' + S.code + ': disconnected'; }
        else { cls += ' on'; line = 'Co-op ' + S.code + ' · ' + n + (n === 1 ? ' player' : ' players'); }
        if (st && st.hidden) line += ' (+' + st.hidden + ' not shown)';
        dot.className = cls;
        t.textContent = line;
        chip.classList.toggle('open', S.open || !!S.error);
        var h = '';
        if (S.error) h += '<div class="cc-err">' + esc(S.error) + '</div>';
        if (st && st.missing.length)
            h += '<div class="cc-err">This build cannot draw other players yet (no co-op engine support). ' +
                'You are in the room, but puppets are off.</div>';
        if (st && st.sizeMismatch)
            h += '<div class="cc-err">Someone here runs a different build; their Kirby cannot be shown. Reload both pages.</div>';
        if (st) {
            var dot = function (c) { return c ? '<span class="cc-sw" style="background:' + c + '"></span>' : ''; };
            h += '<ul><li>' + dot(S.coop.myColor()) + 'You' + (st.paused ? ' <span class="cc-dim">(away)</span>' : '') + '</li>';
            st.players.forEach(function (p) {
                h += '<li>' + dot(S.coop.colorOf(p.mid)) + esc(p.name === 'Player' && p.seat >= 0 ? 'Player ' + (p.seat + 1) : p.name) +
                    (p.slot ? (p.away ? ' <span class="cc-dim">(away)</span>' : '') : ' <span class="cc-dim">(not shown)</span>') +
                    (p.rtt != null ? ' <span class="cc-dim">' + p.rtt + ' ms</span>' : '') + '</li>';
            });
            h += '</ul>';
            if (st.hidden)
                h += '<div class="cc-dim">Up to 3 other players are shown; ' + st.hidden +
                    (st.hidden === 1 ? ' more is' : ' more are') + ' in the room but not drawn.</div>';
        }
        if (st)
            h += '<div class="cc-row"><input data-a="name" maxlength="24" placeholder="Your name" aria-label="Your name" value="' +
                esc(storedName()) + '">' +
                (typeof M._PortUiOpenPageJs === 'function'
                    ? '<button type="button" class="cc-b" data-a="color" title="Pick your Kirby\'s colour (settings menu)">Colour</button>' : '') +
                '</div>';
        if (st && typeof M._PortCoopTags === 'function')
            h += '<label class="cc-opt" title="Each player\'s name above their Kirby">' +
                '<input type="checkbox" data-a="names"' + (namesWanted() ? ' checked' : '') + '>Show names</label>';
        if (st && S.coop && S.coop.worldOk)
            h += '<label class="cc-opt" title="Chests, shards, spray paints, big switches and the map are shared with everyone here">' +
                '<input type="checkbox" data-a="share"' + (S.coop.sharing() ? ' checked' : '') + '>Share progress</label>';
        if (st && S.coop && S.coop.enemyOk)
            h += '<label class="cc-opt" title="Enemies in your room move and die together; minibosses and bosses share their health">' +
                '<input type="checkbox" data-a="enemies"' + (S.coop.enemies() ? ' checked' : '') + '>Share enemies and bosses</label>';
        if (S.code)
            h += '<div class="cc-row"><input readonly value="' + esc(link(S.code)) + '" aria-label="Invite link">' +
                '<button type="button" class="cc-b" data-a="copy">' + (Date.now() - S.copied < 2000 ? 'Copied' : 'Copy link') + '</button></div>';
        if (S.stale || (net && net.state === 'closed'))
            h += '<div class="cc-row">' +
                (net && net.lastError && net.lastError.code === 'replaced'
                    ? '<button type="button" class="cc-b" data-a="rejoin">Rejoin here</button>' : '') +
                '<button type="button" class="cc-b" data-a="new">Start a new room</button></div>';
        /* not while the name is being typed: that would drop the focus */
        var ae = document.activeElement;
        if (ae && body.contains(ae) && ae.getAttribute('data-a') === 'name') return;
        if (h !== lastBody) { body.innerHTML = h; lastBody = h; }
        if (notes.childNodes.length) placeNotes();
    }
    var lastBody = null;

    /* --- connection ----------------------------------------------------------- */

    function sha1Hex(bytes) {
        if (!window.crypto || !crypto.subtle) return Promise.resolve('nosubtle');
        return crypto.subtle.digest('SHA-1', bytes).then(function (d) {
            var a = new Uint8Array(d), s = '';
            for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
            return s;
        });
    }

    var storage = {
        get: function () { return sessionStorage.katamCoopIdentity || null; },
        set: function (v) { sessionStorage.katamCoopIdentity = v; },
    };
    function identity() {
        return Coop.claimIdentity({
            storage: storage, locks: navigator.locks || null,
            mint: function () { return Net.randomHex(16); },
        });
    }

    function storedName() {
        try { return localStorage.katamNetName || ''; } catch (e) { return ''; }
    }

    var romHash = null;
    function hashRom() {
        if (romHash) return romHash;
        var size = (M._shell && M._shell.rom && M._shell.rom.size) || 16 * 1024 * 1024;
        romHash = sha1Hex(M.HEAPU8.slice(0x08000000, 0x08000000 + size));
        return romHash;
    }

    function stopSession() {
        if (S.coop) S.coop.stop();
        if (S.net) S.net.close();
        S.coop = null;
        S.net = null;
    }

    function connect(id) {
        return hashRom().then(function (rom) {
            stopSession();
            var net = Net.connect({
                base: BASE, code: S.code, identity: id, log: log,
                liveness: 8000, backoff: Net.jitteredBackoff,
                hello: {
                    sim: Coop.SIM, rom: rom, content: 'vanilla',
                    name: storedName() || 'Player', platform: 'web',
                    caps: { seats: 4, sync: false }, want: 'play',
                },
            });
            S.net = net;
            S.coop = Coop.create({ Module: M, net: net, log: log, share: shareWanted(), enemies: enemiesWanted() });
            S.coop.onNotice = function (n) { note(n.who + ' ' + n.text); };
            window.katamCoop = { net: net, coop: S.coop };
            ['state', 'roster', 'welcome'].forEach(function (ev) { net.on(ev, render); });
            net.on('error', function (e) {
                S.error = Net.explainError(e);
                render();
            });
            visibility();
            render();
        });
    }

    function join() {
        S.error = null;
        S.stale = false;
        Net.lookupRoom(BASE, S.code).then(function (r) {
            if (r.status === 200) {
                if (raw !== S.code) rewriteUrl(S.code);     /* typed lower-case, or a pasted link */
                return identity().then(connect);
            }
            S.stale = r.status === 404;
            S.error = r.status === 404 ? 'No co-op room ' + S.code + ' (rooms close 20 minutes after the last player leaves).'
                : Net.explainError(r);
            render();
        });
    }

    function newRoom() {
        stopSession();
        S.error = null;
        S.stale = false;
        S.code = null;
        render();
        Net.createRoom(BASE).then(function (r) {
            if (!r.code || (r.status !== 200 && r.status !== 201)) {
                S.error = Net.explainError(r);
                render();
                return;
            }
            S.code = r.code;
            rewriteUrl(r.code);
            identity().then(connect);
        });
    }

    /* evicted by another tab with the same identity (no Web Locks): come
     * back as a new player rather than fight over it */
    function rejoin() {
        try { sessionStorage.removeItem('katamCoopIdentity'); } catch (e) { /* */ }
        S.error = null;
        identity().then(connect);
    }

    function visibility() {
        var hidden = document.visibilityState === 'hidden';
        if (S.coop) S.coop.setPaused(hidden);
        if (S.net) S.net.setPaused(hidden);
        render();
    }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', function () { if (S.net) S.net.reconnectNow(); });

    /* every presented frame */
    var present = M.portPresent;
    M.portPresent = function (ptr, w, h) {
        if (present) present(ptr, w, h);
        if (S.coop) {
            try { S.coop.tick(); } catch (e) { log('[coop] tick: ' + (e && e.stack || e)); }
        }
    };
    setInterval(function () { if (S.net) render(); }, 1000);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();

    /* Wait for the ROM without holding the game: nothing is chained into
     * portRomReady, so the engine boots exactly as it would without ?coop. */
    M.portRomReady.then(function () {
        if (S.error) return;
        if (creating) newRoom();
        else join();
    });
}());

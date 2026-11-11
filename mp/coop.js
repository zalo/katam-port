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
     * apart. */
    var SIM = 'coop/2';
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
        var remotes = {};                 /* mid -> {mid, name, seat, jb, slot} */
        var slots = [null, null, null, null];   /* slot -> mid */
        var puppetOn = [false, false, false, false];
        var enabled = false, wasReady = false, paused = false;
        var tx = { pending: [], lastAt: -Infinity, last: null, unchanged: 0, key: true, pausedSent: false };
        var stats = { sent: 0, sentPoses: 0, recv: 0, sizeMismatch: 0, mismatchFrom: null, frames: 0 };
        var applied = [null, null, null, null];  /* the bytes last given to SetPose, per slot */
        var hiddenOthers = 0;
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
            if (!r) r = remotes[mid] = { mid: mid, name: 'Player', seat: -1, jb: new JitterBuffer(), slot: 0, out: null };
            return r;
        }

        function others() {
            var ms = (net.roster && net.roster.members) || [];
            return ms.filter(function (m) { return m.mid !== net.mid && m.connected && m.role !== 'pending'; });
        }

        function freeSlot(slot) {
            var mid = slots[slot];
            slots[slot] = null;
            applied[slot] = null;
            if (remotes[mid]) remotes[mid].slot = 0;
            if (puppetOn[slot] && !missing.length) M._PortCoopSetPuppet(slot, 0);
            puppetOn[slot] = false;
        }

        /* Sticky: a player keeps their slot while connected; free slots go
         * to the rest in seat order (then join order). */
        function assign() {
            var os = others();
            var here = {};
            os.forEach(function (m) {
                here[m.mid] = true;
                var r = remote(m.mid);
                r.name = m.name; r.seat = m.seat;
            });
            for (var s = 1; s <= SLOTS; s++) if (slots[s] !== null && !here[slots[s]]) freeSlot(s);
            for (var mid in remotes) if (!here[mid]) delete remotes[mid];
            for (var fm in world.fullTo) if (!here[fm]) delete world.fullTo[fm];
            os.sort(function (a, b) { return ((a.seat < 0 ? 1e9 : a.seat) - (b.seat < 0 ? 1e9 : b.seat)) || a.mid - b.mid; });
            var shown = 0;
            os.forEach(function (m) {
                var r = remotes[m.mid];
                if (!r.slot) {
                    for (var s = 1; s <= SLOTS; s++) if (slots[s] === null) { slots[s] = m.mid; r.slot = s; break; }
                }
                if (r.slot) shown++;
            });
            hiddenOthers = os.length - shown;
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

        net.on('roster', assign);
        net.on('welcome', function () {
            /* (re)connected: start every stream over */
            for (var mid in remotes) remotes[mid].jb.reset();
            tx.key = true;
            world.fullTo = {};      /* deltas sent while we were away were lost */
        });
        net.on('signal', function (m) {
            var d = m && m.data;
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
            var pend = tx.pending;
            if (pend.length && pend[pend.length - 1].seq === seq) pend[pend.length - 1].bytes = b;
            else pend.push({ seq: seq, bytes: b });
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
            tx.unchanged = same(b, tx.last) ? tx.unchanged + 1 : 0;
            tx.last = b;
            var since = t - tx.lastAt;
            var idle = tx.unchanged >= IDLE_AFTER;
            var due = tx.key || (idle ? since >= IDLE_MS
                                      : (pend.length >= 2 && since >= SEND_MIN_MS) || since >= SEND_MAX_MS);
            if (!due) return;
            var poses = idle ? [pend[pend.length - 1]] : pend;
            if (net.sendPose(encodePoseUp(tx.key ? F_KEY : 0, poses))) {
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
                var r = remotes[mid];
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
                send(t);
                apply(t);
                enemyTick(t);
                worldTick();
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
                }
            },
            stop: function () {
                if (missing.length) return;
                for (var s = 1; s <= SLOTS; s++) if (slots[s] !== null) freeSlot(s);
                if (enabled) M._PortCoopEnable(0);
                if (worldOk && world.shareSet) M._PortCoopWorldShare(0);
                if (enemyOk && enemy.shareSet) M._PortCoopEnemyShare(0);
                enemy.shareSet = null;
                if (typeof M._PortCoopSetLocalColor === 'function') M._PortCoopSetLocalColor(-1);
                myColor = null;
                world.shareSet = null;
                enabled = false;
            },
            slotOf: function (mid) { return remotes[mid] ? remotes[mid].slot : 0; },
            applied: function (slot) { return applied[slot]; },
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
        WORLD: WORLD, NEWS: NEWS, ENEMY: ENEMY, EnemyBuffer: EnemyBuffer, describeNews: describeNews, b64: b64, unb64: unb64,
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
    });
    body.addEventListener('change', function (e) {
        var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (a === 'share') {
            try { localStorage.katamCoopShare = e.target.checked ? '1' : '0'; } catch (err) { /* private mode */ }
            if (S.coop) S.coop.setShare(e.target.checked);
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
    function mount() {
        var st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);
        document.body.appendChild(chip);
        document.body.appendChild(notes);
        render();
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
            h += '<ul><li>You' + (st.paused ? ' <span class="cc-dim">(away)</span>' : '') + '</li>';
            st.players.forEach(function (p) {
                h += '<li>' + esc(p.name === 'Player' && p.seat >= 0 ? 'Player ' + (p.seat + 1) : p.name) +
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
                esc(storedName()) + '"></div>';
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

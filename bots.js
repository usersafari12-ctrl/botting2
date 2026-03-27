'use strict';

const { WebSocket } = require('ws');

const MODES = {
    lag: {
        label:      'BSG CTG LAG',
        handshake:  Buffer.from([0x03, 0x87, 0x05, 0x02, 0x06]),
        heartbeatMs: 2500,
        tickMs:      50,
        jumpEvery:   20,
        slot:        1,
    },
    pillar: {
        label:      'PILLAR BOT',
        handshake:  Buffer.from([0x03, 0x87, 0x03, 0x02, 0x05]),
        heartbeatMs: 50,
        tickMs:      50,
        jumpEvery:   60,
        placeAfter:  8,
        slot:        3,
    },
    roam: {
        label:      'ROAM BOT',
        handshake:  Buffer.from([0x03, 0x87, 0x05, 0x02, 0x06]),
        heartbeatMs: 2500,
        tickMs:      50,
        slot:        2,
    }
};

// Parse voxiom.io URL/code into wss:// URL
// Accepts: https://voxiom.io/#RW0bY  or  RW0bY  or  wss://game-server-RW0bY.voxiom.io:443
function parseServerUrl(input) {
    input = input.trim();

    // Already a wss:// URL
    if (input.startsWith('wss://')) return input;

    // Full voxiom URL https://voxiom.io/#CODE
    const hashMatch = input.match(/#([A-Za-z0-9]+)$/);
    if (hashMatch) return `wss://game-server-${hashMatch[1]}.voxiom.io:443`;

    // Raw code e.g. RW0bY
    if (/^[A-Za-z0-9]+$/.test(input)) return `wss://game-server-${input}.voxiom.io:443`;

    return null;
}

function buildPacket(bot, opts) {
    opts = opts || {};
    const isSlot = (opts.slot !== undefined);
    const buf = Buffer.alloc(isSlot ? 22 : 21, 0);

    const seq = bot.seq;
    buf[0] = (seq / 0x100000000) >>> 0 & 0xFF;
    buf[1] = (seq >>> 24) & 0xFF;
    buf[2] = (seq >>> 16) & 0xFF;
    buf[3] = (seq >>>  8) & 0xFF;
    buf[4] = (seq >>>  0) & 0xFF;
    bot.seq++;

    if (bot.mode === 'pillar') {
        buf[9] = 0xbf; buf[10] = 0xc9; buf[11] = 0x0f; buf[12] = 0xdb;
    } else {
        buf.writeFloatBE(bot.pitch, 9);
    }
    buf.writeFloatBE(bot.yaw, 13);

    buf[17] = opts.b17 !== undefined ? opts.b17 : 0x7f;
    buf[18] = opts.b18 !== undefined ? opts.b18 : 0x7f;

    if (isSlot) {
        buf[19] = 0x01; buf[20] = 0x00; buf[21] = opts.slot & 0xFF;
    } else if (opts.jump)  { buf[19] = 0x00; buf[20] = 0x03; }
    else if (opts.place)   { buf[19] = 0x00; buf[20] = 0x00; }
    else if (opts.click)   { buf[19] = 0x00; buf[20] = 0x01; }
    else                   { buf[19] = 0x00; buf[20] = 0x00; }

    return buf;
}

const ROAM_DIRS = [
    [0x7f, 0xfe], [0x7f, 0x00], [0xfe, 0x7f], [0x00, 0x7f],
    [0xfe, 0xfe], [0x00, 0xfe], [0xfe, 0x00], [0x00, 0x00],
];

function createBot(id, url, mode) {
    const cfg = MODES[mode];
    const bot = {
        id, url, mode, seq: 0, alive: false,
        yaw:   Math.random() * Math.PI * 2,
        pitch: (Math.random() - 0.5) * 1.0,
        ht: null, tt: null, ws: null,
        tickCycle: 0,
        roamDirChange: 0, roamB17: 0x7f, roamB18: 0xfe, roamTick: 0,
        timerStarted: false,
    };

    function tickLag() {
        if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return;
        bot.yaw   += (Math.random() - 0.5) * 0.15;
        bot.pitch += (Math.random() - 0.5) * 0.1;
        bot.pitch  = Math.max(-1.5, Math.min(1.5, bot.pitch));
        bot.tickCycle++;
        if (bot.tickCycle % cfg.jumpEvery === 1)
            bot.ws.send(buildPacket(bot, { jump: true }));
        else
            bot.ws.send(buildPacket(bot, { click: true }));
    }

    function tickPillar() {
        if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return;
        bot.yaw += 0.008;
        if (bot.yaw > Math.PI * 2) bot.yaw -= Math.PI * 2;
        bot.tickCycle++;
        const phase = bot.tickCycle % cfg.jumpEvery;
        if (phase === 1)                 bot.ws.send(buildPacket(bot, { jump: true }));
        else if (phase === cfg.placeAfter) bot.ws.send(buildPacket(bot, { place: true }));
        else                             bot.ws.send(buildPacket(bot, {}));
    }

    function tickRoam() {
        if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return;
        bot.yaw   += (Math.random() - 0.5) * 0.55;
        bot.pitch += (Math.random() - 0.5) * 0.35;
        bot.pitch  = Math.max(-1.5, Math.min(1.5, bot.pitch));
        bot.roamDirChange--;
        if (bot.roamDirChange <= 0) {
            bot.roamDirChange = 15 + Math.floor(Math.random() * 35);
            const pick = ROAM_DIRS[Math.floor(Math.random() * ROAM_DIRS.length)];
            bot.roamB17 = pick[0]; bot.roamB18 = pick[1];
        }
        bot.roamTick++;
        const isJump = bot.roamTick % 18 === 0;
        bot.ws.send(buildPacket(bot, {
            b17: bot.roamB17, b18: bot.roamB18,
            ...(isJump ? { jump: true } : { click: true })
        }));
    }

    const tick = mode === 'pillar' ? tickPillar : mode === 'roam' ? tickRoam : tickLag;

    bot.ws = new WebSocket(url);
    bot.ws.binaryType = 'arraybuffer';

    bot.ws.on('open', () => {
        bot.alive = true;
        bot.ws.send(cfg.handshake);
        bot.ht = setInterval(() => {
            if (bot.ws && bot.ws.readyState === WebSocket.OPEN)
                bot.ws.send(Buffer.from([0x06]));
        }, cfg.heartbeatMs);
        setTimeout(() => { bot.tt = setInterval(tick, cfg.tickMs); }, 600);
    });

    bot.ws.on('message', () => {
        if (bot.timerStarted) return;
        bot.timerStarted = true;
        bot.ws.send(buildPacket(bot, { slot: cfg.slot }));
    });

    bot.ws.on('error', () => { bot.alive = false; });
    bot.ws.on('close', () => {
        bot.alive = false;
        clearInterval(bot.ht);
        clearInterval(bot.tt);
    });

    bot.kill = () => {
        clearInterval(bot.ht);
        clearInterval(bot.tt);
        try { if (bot.ws) bot.ws.close(); } catch {}
        bot.alive = false;
    };

    return bot;
}

// ── Session: 20 bots, 10 minutes ─────────────────────────────────
// Returns a promise that resolves when all bots are killed
function runSession(serverInput, mode, onProgress) {
    return new Promise((resolve, reject) => {
        const url = parseServerUrl(serverInput);
        if (!url) return reject(new Error('Invalid server URL or code'));

        const cfg = MODES[mode];
        if (!cfg) return reject(new Error('Invalid mode'));

        const BOT_COUNT  = 20;
        const DURATION_MS = 10 * 60 * 1000; // 10 minutes
        const bots = [];
        let killed = false;

        function killAll() {
            if (killed) return;
            killed = true;
            bots.forEach(b => { try { b.kill(); } catch {} });
            resolve({ url, mode, botCount: BOT_COUNT });
        }

        // Stagger bot deployment 250ms apart
        for (let i = 0; i < BOT_COUNT; i++) {
            setTimeout(() => {
                if (killed) return;
                try {
                    const b = createBot(i + 1, url, mode);
                    bots.push(b);
                    if (onProgress) onProgress(bots.filter(x => x.alive).length, BOT_COUNT);
                } catch (e) { /* individual bot failure is ok */ }
            }, i * 250);
        }

        // Auto-kill after 10 minutes
        setTimeout(killAll, DURATION_MS);

        // Expose manual kill
        resolve._kill = killAll;
    });
}

module.exports = { runSession, parseServerUrl, MODES };

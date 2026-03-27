'use strict';

const express = require('express');
const http    = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Mode definitions ─────────────────────────────────────────────
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

// ── Bot state ─────────────────────────────────────────────────────
const bots    = {};
let botIdCounter = 0;
let totalDeployed = 0;

// ── Broadcast to all panel clients ───────────────────────────────
const panelClients = new Set();

function broadcast(msg) {
    const str = JSON.stringify(msg);
    panelClients.forEach(c => { if (c.readyState === 1) c.send(str); });
}

function botStats() {
    const arr = Object.values(bots);
    return {
        active: arr.filter(b => b.alive).length,
        total:  totalDeployed,
        dead:   arr.filter(b => !b.alive).length,
        bots:   arr.map(b => ({
            id:    b.id,
            mode:  b.mode,
            alive: b.alive,
            secsLeft: b.secsLeft
        }))
    };
}

// ── Build a 21-byte tick packet ───────────────────────────────────
function buildPacket(bot, opts) {
    opts = opts || {};
    const cfg = MODES[bot.mode];
    const isSlot = (opts.slot !== undefined);
    const buf = Buffer.alloc(isSlot ? 22 : 21, 0);

    // seq (5 bytes big-endian)
    const seq = bot.seq;
    buf[0] = (seq / 0x100000000) >>> 0 & 0xFF;
    buf[1] = (seq >>> 24) & 0xFF;
    buf[2] = (seq >>> 16) & 0xFF;
    buf[3] = (seq >>>  8) & 0xFF;
    buf[4] = (seq >>>  0) & 0xFF;
    bot.seq++;

    // bytes 5-8 = 0 (reserved)

    // pitch (float32 BE at 9-12)
    if (bot.mode === 'pillar') {
        buf[9]  = 0xbf; buf[10] = 0xc9; buf[11] = 0x0f; buf[12] = 0xdb;
    } else {
        buf.writeFloatBE(bot.pitch, 9);
    }

    // yaw (float32 BE at 13-16)
    buf.writeFloatBE(bot.yaw, 13);

    // LR/FB axes
    buf[17] = opts.b17 !== undefined ? opts.b17 : 0x7f;
    buf[18] = opts.b18 !== undefined ? opts.b18 : 0x7f;

    if (isSlot) {
        buf[19] = 0x01;
        buf[20] = 0x00;
        buf[21] = opts.slot & 0xFF;
    } else if (opts.jump) {
        buf[19] = 0x00; buf[20] = 0x03;
    } else if (opts.place) {
        buf[19] = 0x00; buf[20] = 0x00;
    } else if (opts.click) {
        buf[19] = 0x00; buf[20] = 0x01;
    } else {
        buf[19] = 0x00; buf[20] = 0x00;
    }

    return buf;
}

// ── Create a single bot ───────────────────────────────────────────
function createBot(id, url, mode, lifeSeconds) {
    const cfg = MODES[mode];
    const bot = {
        id, url, mode, alive: false, seq: 0,
        yaw:   Math.random() * Math.PI * 2,
        pitch: (Math.random() - 0.5) * 1.0,
        secsLeft: lifeSeconds,
        ht: null, tt: null, killTimer: null, timerStarted: false,
        ws: null,
        tickCycle: 0,
        // roam state
        roamDirChange: 0, roamB17: 0x7f, roamB18: 0xfe, roamTick: 0,
    };

    function logBot(msg, type) {
        broadcast({ type: 'log', msg: `Bot #${String(id).padStart(2,'0')} ${msg}`, level: type || 'info' });
    }

    // ── Tick functions ────────────────────────────────────────────
    function tickLag() {
        if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return;
        bot.yaw   += (Math.random() - 0.5) * 0.15;
        bot.pitch += (Math.random() - 0.5) * 0.1;
        bot.pitch  = Math.max(-1.5, Math.min(1.5, bot.pitch));
        bot.tickCycle++;
        if (bot.tickCycle % cfg.jumpEvery === 1) {
            bot.ws.send(buildPacket(bot, { jump: true }));
        } else {
            bot.ws.send(buildPacket(bot, { click: true }));
        }
    }

    function tickPillar() {
        if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return;
        bot.yaw += 0.008;
        if (bot.yaw > Math.PI * 2) bot.yaw -= Math.PI * 2;
        bot.tickCycle++;
        const phase = bot.tickCycle % cfg.jumpEvery;
        if (phase === 1) {
            bot.ws.send(buildPacket(bot, { jump: true }));
        } else if (phase === cfg.placeAfter) {
            bot.ws.send(buildPacket(bot, { place: true }));
        } else {
            bot.ws.send(buildPacket(bot, {}));
        }
    }

    const ROAM_DIRS = [
        [0x7f, 0xfe], [0x7f, 0x00], [0xfe, 0x7f], [0x00, 0x7f],
        [0xfe, 0xfe], [0x00, 0xfe], [0xfe, 0x00], [0x00, 0x00],
    ];

    function tickRoam() {
        if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN) return;
        bot.yaw   += (Math.random() - 0.5) * 0.55;
        bot.pitch += (Math.random() - 0.5) * 0.35;
        bot.pitch  = Math.max(-1.5, Math.min(1.5, bot.pitch));
        bot.roamDirChange--;
        if (bot.roamDirChange <= 0) {
            bot.roamDirChange = 15 + Math.floor(Math.random() * 35);
            const pick = ROAM_DIRS[Math.floor(Math.random() * ROAM_DIRS.length)];
            bot.roamB17 = pick[0];
            bot.roamB18 = pick[1];
        }
        bot.roamTick++;
        const isJump = bot.roamTick % 18 === 0;
        bot.ws.send(buildPacket(bot, {
            b17: bot.roamB17, b18: bot.roamB18,
            ...(isJump ? { jump: true } : { click: true })
        }));
    }

    const tick = mode === 'pillar' ? tickPillar : mode === 'roam' ? tickRoam : tickLag;

    // ── Connect ───────────────────────────────────────────────────
    try {
        bot.ws = new WebSocket(url);
        bot.ws.binaryType = 'arraybuffer';
    } catch(e) {
        logBot('WS create error: ' + e.message, 'error');
        broadcast({ type: 'botUpdate', ...botStats() });
        return bot;
    }

    bot.ws.on('open', () => {
        bot.alive = true;
        bot.seq   = 0;
        bot.ws.send(cfg.handshake);
        logBot(`connected [${cfg.label}]`, 'success');

        bot.ht = setInterval(() => {
            if (bot.ws && bot.ws.readyState === WebSocket.OPEN)
                bot.ws.send(Buffer.from([0x06]));
        }, cfg.heartbeatMs);

        setTimeout(() => { bot.tt = setInterval(tick, cfg.tickMs); }, 600);
        broadcast({ type: 'botUpdate', ...botStats() });
    });

    bot.ws.on('message', (data) => {
        if (bot.timerStarted) return;
        bot.timerStarted = true;
        bot.ws.send(buildPacket(bot, { slot: cfg.slot }));
        logBot(`joined — ${lifeSeconds}s timer`, 'success');

        bot.killTimer = setInterval(() => {
            bot.secsLeft--;
            broadcast({ type: 'botUpdate', ...botStats() });
            if (bot.secsLeft <= 0) {
                clearInterval(bot.killTimer);
                killBot(id);
            }
        }, 1000);
    });

    bot.ws.on('error', (e) => {
        logBot('socket error: ' + e.message, 'error');
    });

    bot.ws.on('close', (code) => {
        bot.alive = false;
        clearInterval(bot.ht);
        clearInterval(bot.tt);
        logBot(`closed (${code})`, 'warn');
        broadcast({ type: 'botUpdate', ...botStats() });
    });

    bot.kill = () => {
        clearInterval(bot.ht);
        clearInterval(bot.tt);
        clearInterval(bot.killTimer);
        if (bot.ws) bot.ws.close();
        bot.alive = false;
    };

    return bot;
}

function deployBot(url, mode, lifeSeconds) {
    const id = ++botIdCounter;
    totalDeployed++;
    bots[id] = createBot(id, url, mode, lifeSeconds);
    broadcast({ type: 'botUpdate', ...botStats() });
    return id;
}

function killBot(id) {
    if (!bots[id]) return;
    bots[id].kill();
    broadcast({ type: 'log', msg: `Bot #${String(id).padStart(2,'0')} killed`, level: 'warn' });
    delete bots[id];
    broadcast({ type: 'botUpdate', ...botStats() });
}

// ── REST API ──────────────────────────────────────────────────────
app.post('/api/deploy', (req, res) => {
    const { url, mode, count, lifeSeconds } = req.body;
    if (!url || !url.startsWith('wss://')) return res.status(400).json({ error: 'Invalid URL' });
    if (!MODES[mode]) return res.status(400).json({ error: 'Invalid mode' });
    const n   = Math.max(1, Math.min(50, parseInt(count)   || 1));
    const ls  = Math.max(1, Math.min(600, parseInt(lifeSeconds) || 35));
    broadcast({ type: 'log', msg: `Deploying ${n} bot(s) in ${MODES[mode].label} mode`, level: 'info' });
    const ids = [];
    for (let i = 0; i < n; i++) {
        setTimeout(() => {
            ids.push(deployBot(url, mode, ls));
        }, i * 250);
    }
    res.json({ ok: true, count: n });
});

app.post('/api/kill', (req, res) => {
    const { id } = req.body;
    if (id === 'all') {
        const ids = Object.keys(bots);
        ids.forEach(i => killBot(Number(i)));
        broadcast({ type: 'log', msg: `Killed all ${ids.length} bot(s)`, level: 'error' });
    } else {
        killBot(Number(id));
    }
    res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
    res.json(botStats());
});

// ── Panel WebSocket ───────────────────────────────────────────────
wss.on('connection', (ws) => {
    panelClients.add(ws);
    ws.send(JSON.stringify({ type: 'init', ...botStats() }));
    ws.on('close', () => panelClients.delete(ws));
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Voxiom Bot Server running on http://localhost:${PORT}`);
});

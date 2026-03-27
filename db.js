'use strict';

const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db.json');

function load() {
    if (!fs.existsSync(DB_FILE)) return { users: {} };
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch { return { users: {} }; }
}

function save(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── Token operations ───────────────────────────────────────────────
function getTokens(userId) {
    const db = load();
    return db.users[userId]?.tokens ?? 0;
}

function addTokens(userId, amount) {
    const db = load();
    if (!db.users[userId]) db.users[userId] = { tokens: 0, history: [] };
    db.users[userId].tokens += amount;
    save(db);
    return db.users[userId].tokens;
}

function deductTokens(userId, amount) {
    const db = load();
    if (!db.users[userId] || db.users[userId].tokens < amount) return false;
    db.users[userId].tokens -= amount;
    save(db);
    return true;
}

function logUse(userId, serverId, mode) {
    const db = load();
    if (!db.users[userId]) db.users[userId] = { tokens: 0, history: [] };
    if (!db.users[userId].history) db.users[userId].history = [];
    db.users[userId].history.unshift({
        serverId, mode,
        time: new Date().toISOString()
    });
    // keep last 20
    db.users[userId].history = db.users[userId].history.slice(0, 20);
    save(db);
}

function getAllUsers() {
    const db = load();
    return db.users;
}

module.exports = { getTokens, addTokens, deductTokens, logUse, getAllUsers };

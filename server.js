'use strict';

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db   = require('./db');
const bots = require('./bots');

// ── Config (set via env vars) ─────────────────────────────────────
const TOKEN      = process.env.DISCORD_TOKEN;
const CLIENT_ID  = process.env.DISCORD_CLIENT_ID;
const ADMIN_IDS  = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// Cost per /bot session
const TOKEN_COST = 1;

if (!TOKEN || !CLIENT_ID) {
    console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
    process.exit(1);
}

// ── Slash command definitions ─────────────────────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName('bot')
        .setDescription('Deploy 20 bots to a Voxiom private server for 10 minutes (costs 1 token)')
        .addStringOption(o => o
            .setName('server')
            .setDescription('Server URL or code (e.g. https://voxiom.io/#RW0bY or RW0bY)')
            .setRequired(true))
        .addStringOption(o => o
            .setName('mode')
            .setDescription('Bot behaviour mode')
            .setRequired(true)
            .addChoices(
                { name: '🔴 Roam (random walk + shoot)', value: 'roam' },
                { name: '🟣 Pillar (jump + place blocks)', value: 'pillar' },
                { name: '🔵 Stand Still / Lag (BSG CTG)', value: 'lag' },
            )),

    new SlashCommandBuilder()
        .setName('tokens')
        .setDescription('Check your token balance'),

    new SlashCommandBuilder()
        .setName('addtokens')
        .setDescription('[Admin] Add tokens to a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Tokens to add').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
        .setName('removetokens')
        .setDescription('[Admin] Remove tokens from a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Tokens to remove').setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
        .setName('balances')
        .setDescription('[Admin] View all user token balances'),

    new SlashCommandBuilder()
        .setName('history')
        .setDescription('View your recent bot sessions'),
];

// ── Register commands ─────────────────────────────────────────────
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
        console.log('Slash commands registered.');
    } catch (e) {
        console.error('Failed to register commands:', e);
    }
}

// ── Helpers ───────────────────────────────────────────────────────
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

function modeEmoji(mode) {
    return mode === 'roam' ? '🔴' : mode === 'pillar' ? '🟣' : '🔵';
}

function modeLabel(mode) {
    return bots.MODES[mode]?.label || mode;
}

// Track active sessions per user so they can't stack
const activeSessions = new Map(); // userId -> { kill, serverUrl, mode, startedAt }

// ── Client ────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('Voxiom | /bot', { type: 1 });
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, user } = interaction;

    // ── /tokens ──────────────────────────────────────────────────
    if (commandName === 'tokens') {
        const bal = db.getTokens(user.id);
        const embed = new EmbedBuilder()
            .setColor(0x00c8f0)
            .setTitle('💎 Token Balance')
            .setDescription(`**${user.username}**, you have **${bal} token${bal !== 1 ? 's' : ''}**.`)
            .setFooter({ text: `1 token = 20 bots for 10 minutes` });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /history ─────────────────────────────────────────────────
    if (commandName === 'history') {
        const all  = db.getAllUsers();
        const hist = all[user.id]?.history || [];
        if (!hist.length) {
            return interaction.reply({ content: 'You have no session history yet.', ephemeral: true });
        }
        const lines = hist.map((h, i) => {
            const d = new Date(h.time);
            const ts = `<t:${Math.floor(d.getTime()/1000)}:R>`;
            return `\`${i+1}.\` ${modeEmoji(h.mode)} **${modeLabel(h.mode)}** → \`${h.serverId}\` ${ts}`;
        }).join('\n');
        const embed = new EmbedBuilder()
            .setColor(0x00c8f0)
            .setTitle('📋 Recent Sessions')
            .setDescription(lines);
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /addtokens (admin) ────────────────────────────────────────
    if (commandName === 'addtokens') {
        if (!isAdmin(user.id)) {
            return interaction.reply({ content: '❌ You are not an admin.', ephemeral: true });
        }
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const newBal = db.addTokens(target.id, amount);
        const embed  = new EmbedBuilder()
            .setColor(0x00e87a)
            .setTitle('✅ Tokens Added')
            .setDescription(`Added **${amount}** token${amount !== 1 ? 's' : ''} to **${target.username}**.\nNew balance: **${newBal}**`);
        return interaction.reply({ embeds: [embed] });
    }

    // ── /removetokens (admin) ─────────────────────────────────────
    if (commandName === 'removetokens') {
        if (!isAdmin(user.id)) {
            return interaction.reply({ content: '❌ You are not an admin.', ephemeral: true });
        }
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const cur    = db.getTokens(target.id);
        const actual = Math.min(amount, cur);
        db.addTokens(target.id, -actual);
        const embed  = new EmbedBuilder()
            .setColor(0xff3355)
            .setTitle('🗑️ Tokens Removed')
            .setDescription(`Removed **${actual}** token${actual !== 1 ? 's' : ''} from **${target.username}**.\nNew balance: **${cur - actual}**`);
        return interaction.reply({ embeds: [embed] });
    }

    // ── /balances (admin) ─────────────────────────────────────────
    if (commandName === 'balances') {
        if (!isAdmin(user.id)) {
            return interaction.reply({ content: '❌ You are not an admin.', ephemeral: true });
        }
        const all = db.getAllUsers();
        const entries = Object.entries(all);
        if (!entries.length) {
            return interaction.reply({ content: 'No users in database yet.', ephemeral: true });
        }
        const lines = entries
            .sort(([,a],[,b]) => (b.tokens||0) - (a.tokens||0))
            .map(([uid, data]) => `<@${uid}>: **${data.tokens || 0}** token${data.tokens !== 1 ? 's' : ''}`)
            .join('\n');
        const embed = new EmbedBuilder()
            .setColor(0xffaa00)
            .setTitle('💰 All Balances')
            .setDescription(lines);
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /bot ──────────────────────────────────────────────────────
    if (commandName === 'bot') {
        const serverInput = interaction.options.getString('server');
        const mode        = interaction.options.getString('mode');

        // Parse URL early for validation
        const url = bots.parseServerUrl(serverInput);
        if (!url) {
            return interaction.reply({
                content: '❌ Invalid server URL or code. Use `https://voxiom.io/#RW0bY` or just `RW0bY`.',
                ephemeral: true
            });
        }

        // Check for already active session
        if (activeSessions.has(user.id)) {
            const s = activeSessions.get(user.id);
            const elapsed = Math.floor((Date.now() - s.startedAt) / 1000);
            const rem = Math.max(0, 600 - elapsed);
            return interaction.reply({
                content: `⚠️ You already have an active session running (${rem}s remaining). Wait for it to finish.`,
                ephemeral: true
            });
        }

        // Check tokens
        const bal = db.getTokens(user.id);
        if (bal < TOKEN_COST) {
            return interaction.reply({
                content: `❌ You don't have enough tokens. You need **${TOKEN_COST}**, you have **${bal}**.`,
                ephemeral: true
            });
        }

        // Deduct token
        const ok = db.deductTokens(user.id, TOKEN_COST);
        if (!ok) {
            return interaction.reply({ content: '❌ Failed to deduct token. Try again.', ephemeral: true });
        }

        // Log the session
        db.logUse(user.id, serverInput, mode);

        // Defer reply (bots take a moment to connect)
        await interaction.deferReply();

        const startedAt = Date.now();
        const newBal    = db.getTokens(user.id);

        // Build start embed
        const startEmbed = new EmbedBuilder()
            .setColor(mode === 'roam' ? 0xff3355 : mode === 'pillar' ? 0xa020f0 : 0x00c8f0)
            .setTitle(`${modeEmoji(mode)} Session Started`)
            .addFields(
                { name: 'Server',    value: `\`${serverInput}\``,    inline: true },
                { name: 'Mode',      value: modeLabel(mode),          inline: true },
                { name: 'Bots',      value: '20',                     inline: true },
                { name: 'Duration',  value: '10 minutes',             inline: true },
                { name: 'Tokens Left', value: `${newBal}`,           inline: true },
            )
            .setFooter({ text: 'Bots are connecting — takes ~5s to fully deploy' })
            .setTimestamp();

        await interaction.editReply({ embeds: [startEmbed] });

        // Run session — 20 bots, 10 minutes, server-side
        const sessionPromise = new Promise((resolve) => {
            let killFn;
            const p = bots.runSession(url, mode, null);

            // Store session with a kill handle
            activeSessions.set(user.id, {
                kill: () => { if (killFn) killFn(); },
                serverUrl: url,
                mode,
                startedAt,
            });

            // runSession returns a promise; get the kill fn from it
            p._kill && (killFn = p._kill);

            p.then(result => {
                activeSessions.delete(user.id);

                // Send a follow-up when done
                const doneEmbed = new EmbedBuilder()
                    .setColor(0x00e87a)
                    .setTitle('✅ Session Complete')
                    .setDescription(`**${user.username}**'s 10-minute session on \`${serverInput}\` has ended.`)
                    .addFields(
                        { name: 'Mode', value: modeLabel(mode), inline: true },
                        { name: 'Bots', value: '20', inline: true },
                    )
                    .setTimestamp();

                interaction.followUp({ embeds: [doneEmbed] }).catch(() => {});
                resolve();
            }).catch(() => {
                activeSessions.delete(user.id);
                resolve();
            });
        });

        return;
    }
});

// ── Boot ──────────────────────────────────────────────────────────
registerCommands().then(() => {
    client.login(TOKEN);
});

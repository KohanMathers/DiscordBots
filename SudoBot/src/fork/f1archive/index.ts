import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { respond } from '../../discord/replies.ts';
import type { CommandSpec, Module } from '../../modules/types.ts';

const F1ARCHIVE_URL: string | null = process.env.F1ARCHIVE_URL?.trim().replace(/\/+$/, '') || null;
const F1ARCHIVE_TOKEN: string | null = process.env.F1ARCHIVE_NOTIF_TOKEN?.trim() || null;
const F1ARCHIVE_ROLE_IDS: string[] = (process.env.F1ARCHIVE_NOTIF_ROLE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const MAX_MESSAGE_LENGTH = 1000;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

async function authorize(i: ChatInputCommandInteraction): Promise<boolean> {
    if (!F1ARCHIVE_URL || !F1ARCHIVE_TOKEN) {
        await respond(i, { content: `F1Archive notices are not configured.` }, { ephemeral: true });
        return false;
    }
    const member = await i.guild!.members.fetch(i.user.id);
    if (!F1ARCHIVE_ROLE_IDS.some((id) => member.roles.cache.has(id))) {
        await respond(i, { content: `You don't have permission to manage F1Archive notices.` }, { ephemeral: true });
        return false;
    }
    return true;
}

async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${F1ARCHIVE_URL}${path}`, {
        method: 'POST',
        headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            Authorization: `Bearer ${F1ARCHIVE_TOKEN}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

const archivenotif: CommandSpec = {
    replyMode: 'ephemeral',
    cooldownS: 3,
    data: new SlashCommandBuilder()
        .setName('archivenotif')
        .setDescription('Set the F1Archive site notice (replaces any existing one)')
        .addStringOption((o) =>
            o
                .setName('message')
                .setDescription('The notice text')
                .setMaxLength(MAX_MESSAGE_LENGTH)
                .setRequired(true)
        )
        .addStringOption((o) =>
            o
                .setName('expiry')
                .setDescription('When the notice expires, ISO 8601 with time zone, e.g. 2026-11-13T18:00:00Z')
                .setRequired(true)
        )
        .toJSON(),
    async execute(i, _ctx) {
        if (!i.isChatInputCommand()) return;
        if (!(await authorize(i))) return;

        const message = i.options.getString('message', true).trim();
        const expiryRaw = i.options.getString('expiry', true).trim();
        if (!message) {
            await respond(i, { content: `The message can't be empty.` }, { ephemeral: true });
            return;
        }
        const expiry = new Date(expiryRaw);
        if (!ISO_WITH_ZONE.test(expiryRaw) || Number.isNaN(expiry.getTime())) {
            await respond(
                i,
                { content: `Expiry must be an ISO 8601 timestamp with a time zone, e.g. \`2026-11-13T18:00:00Z\`.` },
                { ephemeral: true }
            );
            return;
        }
        if (expiry.getTime() <= Date.now()) {
            await respond(i, { content: `Expiry can't be in the past.` }, { ephemeral: true });
            return;
        }

        const res = await post('/api/admin/notice', { message, expiry: expiryRaw });
        if (!res.ok) {
            await respond(i, { content: `F1Archive returned ${res.status} while setting the notice.` }, { ephemeral: true });
            return;
        }
        await respond(i, { content: `Notice set, expires <t:${Math.floor(expiry.getTime() / 1000)}:f>.` }, { ephemeral: true });
    },
};

const archivenoticeclear: CommandSpec = {
    replyMode: 'ephemeral',
    cooldownS: 3,
    data: new SlashCommandBuilder()
        .setName('archivenotifclear')
        .setDescription('Clear the F1Archive site notice')
        .toJSON(),
    async execute(i, _ctx) {
        if (!i.isChatInputCommand()) return;
        if (!(await authorize(i))) return;

        const res = await post('/api/admin/notice/clear');
        if (!res.ok) {
            await respond(i, { content: `F1Archive returned ${res.status} while clearing the notice.` }, { ephemeral: true });
            return;
        }
        await respond(i, { content: `Notice cleared.` }, { ephemeral: true });
    },
};

export const f1ArchiveModule: Module = {
    id: 'f1archive',
    name: 'F1Archive',
    description: 'F1Archive site notices.',
    commands: [archivenotif, archivenoticeclear],
};
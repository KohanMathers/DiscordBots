import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { UserError } from '../../core/errors.ts';
import { respond } from '../../discord/replies.ts';
import type { CommandSpec, Module } from '../../modules/types.ts';
import { variant } from '../../variant.ts';

interface RoleMapFile {
    kind: string;
    map: Record<string, string>;
}

function loadRoleMap(): Map<string, string> {
    const url = new URL(`../../../${variant.contentDir}/fun/role-map.yaml`, import.meta.url);
    const doc = parse(readFileSync(url, 'utf8')) as RoleMapFile;
    if (doc?.kind !== 'roles' || !doc.map) throw new Error('role-map.yaml: missing or malformed "map"');
    return new Map(Object.entries(doc.map));
}

const ROLE_MAP = loadRoleMap();
const ALL_ROLE_IDS = [...ROLE_MAP.keys()];

const nameToRoleId = (name: string): string | undefined => [...ROLE_MAP.entries()].find(([, n]) => n === name)?.[0];

const colour: CommandSpec = {
    replyMode: 'ephemeral',
    cooldownS: 3,
    botPermissions: [PermissionFlagsBits.ManageRoles],
    data: new SlashCommandBuilder()
        .setName('colour')
        .setDescription('Pick your name colour')
        .addStringOption((o) =>
            o
                .setName('colour')
                .setDescription('Which colour')
                .setRequired(true)
                .addChoices(...[...ROLE_MAP.values()].map((name) => ({ name, value: name }))),
        )
        .toJSON(),
    async execute(i, _ctx) {
        if (!i.isChatInputCommand()) return;
        const chosenName = i.options.getString('colour', true);
        const roleId = nameToRoleId(chosenName);
        if (!roleId || !i.guild!.roles.cache.has(roleId)) {
            throw new UserError(`The "${chosenName}" role doesn't exist on this server anymore`);
        }

        const member = await i.guild!.members.fetch(i.user.id);
        const toRemove = ALL_ROLE_IDS.filter((id) => id !== roleId && member.roles.cache.has(id));
        if (toRemove.length) await member.roles.remove(toRemove);
        await member.roles.add(roleId);

        await respond(i, { content: `✅ You're now **${chosenName}**.` }, { ephemeral: true });
    },
};

export const colourModule: Module = {
    id: 'colour',
    name: 'Colour',
    description: 'Self-assignable colour roles via /colour',
    commands: [colour],
};
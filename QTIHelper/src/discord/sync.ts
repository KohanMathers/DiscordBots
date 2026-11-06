import { createHash } from 'node:crypto';
import type { Client, RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '../storage/schema.ts';

export async function syncCommands(client: Client<true>, body: RESTPostAPIApplicationCommandsJSONBody[], db: Kysely<Database>, devGuildIds: string[], log: Logger) {
  for (const guildId of devGuildIds.length ? devGuildIds : [undefined]) {
    const scope = guildId ? `guild:${guildId}` : 'global';
    const hash = createHash('sha256').update(client.application.id).update(scope).update(JSON.stringify(body)).digest('hex');
    const key = `commands_hash:${scope}`;
    const stored = await db.selectFrom('meta').select('value').where('key', '=', key).executeTakeFirst();
    if (stored?.value === hash) continue;
    if (guildId) await client.application.commands.set(body, guildId);
    else await client.application.commands.set(body);
    await db.insertInto('meta').values({ key, value: hash }).onConflict((oc) => oc.column('key').doUpdateSet({ value: hash })).execute();
    log.info({ scope, count: body.length }, 'commands synced');
  }
}

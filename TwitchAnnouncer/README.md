# TwitchAnnouncer v3

A Discord bot that posts an announcement when a Twitch creator goes live or a YouTube channel publishes a video. One process serves every server it's in.

This is a clean-room rewrite built only from the v3 spec (Nov 5, 2026). None of the v2.0 source was used.

## Running it

Needs Node 24 or newer (it runs the TypeScript directly, with no build step) and pnpm.

```sh
pnpm install
cp .env.example .env     # then fill in DISCORD_TOKEN and the Twitch/YouTube keys
pnpm start
```

| Script                               | What it does                                   |
| ------------------------------------ | ---------------------------------------------- |
| `pnpm start`                         | Run the bot                                    |
| `pnpm dev`                           | Run with restart on file change                |
| `pnpm test`                          | Unit, contract and scenario tests (no network) |
| `pnpm typecheck`                     | `tsc` with no emit                             |
| `pnpm import-v2 <v2.db> [--dry-run]` | One-shot import of a v2.0 database             |

**Invite link:** use the scopes `bot` and `applications.commands`, with the permissions View Channel, Send Messages, Send Messages in Threads and Embed Links. Add Mention Everyone only if you ping roles that aren't mentionable. No privileged intents are needed.

A platform with no credentials is disabled. Its commands then reply that it isn't enabled, instead of failing.

## Commands

Every admin command needs **Manage Server** by default. Server admins can change that under Server Settings -> Integrations. Every reply is ephemeral except `/help`, `/info` and `/ping`.

| Command                                             | Purpose                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/twitch add creator [channel] [ping]`              | Announce a Twitch creator (login or URL)                                                               |
| `/youtube add channel_ref [channel] [ping] [types]` | Announce a YouTube channel (@handle, URL or `UC…` ID). `types` defaults to everything, Shorts included |
| `/twitch remove`, `/youtube remove`                 | Stop announcing a creator (autocompletes)                                                              |
| `/twitch list`, `/youtube list`                     | Creators announced in this server                                                                      |
| `/announcer default-channel platform channel`       | The fallback channel for a platform                                                                    |
| `/announcer log-channel [channel]`                  | Where problems are reported (default: the system channel)                                              |
| `/announcer crosspost enabled`                      | Publish posts made in announcement channels (default on)                                               |
| `/announcer test subscription`                      | Send a sample post. Also resumes a paused subscription                                                 |
| `/announcer settings`                               | Overview, including any paused subscriptions                                                           |
| `/help`, `/info`, `/ping`                           | Everyone                                                                                               |
| `/status`                                           | Bot owners only: uptime, polls, outbox, rate limit and quota                                           |

## How it works

```
 providers (poll)  ->  detector  ->  outbox (delivery rows)  ->  dispatcher  ->  Discord
   twitch: Helix /streams, 100 IDs per call, every 60 s
   youtube: Atom feed per channel every 5 min (0 units) + videos.list for new items only
```

- **Sources and subscriptions.** A creator is fetched once per cycle, however many servers follow it, then fanned out to each server's subscription.
- **Stable IDs.** Twitch user IDs and YouTube channel IDs are resolved when a creator is added. Names and avatars are cached display data, refreshed daily and whenever a rename is seen.
- **Exactly-once delivery.** The detector writes `seen_item` rows and `delivery` rows in one transaction, protected by unique constraints. A delivery is marked sent only after Discord confirms it. Transient failures retry 3 times over about 5 minutes. A 403 or a deleted channel pauses the subscription and posts one notice.
- **First sync.** A new YouTube subscription never announces the back catalogue. A new Twitch subscription announces at once if the creator is already live.
- **Catch-up after downtime.** Streams still live are announced. Videos are announced only if they're newer than `CATCHUP_MAX_AGE` (24 h).
- **Retention.** De-dup and delivery records are pruned after 30 days. A server's data is deleted 30 days after the bot leaves, unless it rejoins.

### Layout

| Path                     | Contents                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `src/core`               | Domain types, the `Provider` interface, detection rules, detector, dispatcher, metrics. No Discord or HTTP code |
| `src/providers`          | `twitch/` and `youtube/` API clients, parsing, embeds. `registry.ts` lists the providers                        |
| `src/discord`            | Client setup, commands, embed rendering, the Discord `Sender`                                                   |
| `src/storage`            | Kysely schema, numbered migrations, the `Store` repository                                                      |
| `src/app`                | Config (zod), logging (pino), scheduler, `/healthz` and `/metrics` server                                       |
| `src/tools/import-v2.ts` | v2.0 importer                                                                                                   |

### Adding a platform

1. Implement `Provider` (`src/core/types.ts`) in `src/providers/<name>/`.
2. Add one entry to `factories` in `src/providers/registry.ts`, with its display name, colour, option name and filter choices.

That's all. `/<name> add|remove|list`, polling, delivery and `/status` come from the registry.
# StrikeSystem v2

A Discord moderation bot built around strikes. Every action becomes a numbered case with a log entry. Strikes escalate automatically (ban at max by default). The bot also keeps a live strike tracker, a watchlist for users who aren't in the server yet, and modmail.

This is a clean-room rewrite built only from the v2 spec (2026-11-06). None of the v1 source was used.

## Running it

Needs Node 24 or newer and pnpm. There's no build step: Node runs the TypeScript directly.

```sh
pnpm install
cp .env.example .env     # then set DISCORD_TOKEN
pnpm start
```

| Script                                                                                         | What it does                            |
| ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pnpm start`                                                                                   | Run the bot                             |
| `pnpm dev`                                                                                     | Run with restart on file change         |
| `pnpm test`                                                                                    | Unit and integration tests (no network) |
| `pnpm typecheck`                                                                               | `tsc` with no emit                      |
| `pnpm import-legacy --sqlite moderation.db [--dry-run] [--convert-boj] [--delete-old-tracker]` | One-shot import of the v1 database      |

On Pterodactyl, use the shared egg at the repo root with App Directory `StrikeSystem`.

**Developer Portal:** turn on the **Server Members** privileged intent. It's needed for join events, the watchlist and member lookups. Message Content is **not** needed.

**Invite permissions:** Ban Members, Kick Members, Moderate Members, View Audit Log, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Create Public Threads and Manage Threads. Add Manage Roles only if you use a mute role (`mute.mode role`). Scopes: `bot applications.commands`.

**First steps in a server:** run `/setup` to pick a log channel, a tracker channel, mod roles, max strikes and the escalation preset. Fine-tune with `/config`.

## Commands

| Who                   | Commands                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everyone              | `/help`, `/mystrikes`, `/myhistory`                                                                                                                                                                                                           |
| Moderators            | `/strike`, `/unstrike`, `/warn`, `/timeout`, `/untimeout`, `/kick`, `/ban`, `/unban`, `/note`, `/history`, `/case view\|reason\|revoke`, `/watchlist add\|remove\|list`, `/tracker`, `/reply`, `/areply`, `/close`, `/modmail block\|unblock` |
| Right-click a user    | Strike, Warn, Timeout, View history                                                                                                                                                                                                           |
| Right-click a message | Strike for this message (attaches a link, a text snapshot and the message's files as evidence)                                                                                                                                                |
| Admins                | `/setup`, `/config view\|set\|reset`, `/modules list\|enable\|disable`, `/export cases`, `/purge-user-data`                                                                                                                                   |
| Bot owners            | `/botadmin status\|maintenance`                                                                                                                                                                                                               |

**Who counts as an admin or moderator**:
- **Admin:** the server owner, anyone with Administrator, and anyone with a role in `perms.admin_roles`.
- **Moderator:** anyone with a role in `perms.mod_roles`. If no mod roles are set, it's anyone with `perms.fallback_permission` (default: Timeout Members).

Discord also hides commands using default permissions: Timeout Members for mod commands and Manage Server for admin ones. If your mod role lacks those permissions, allow the commands for that role under Server Settings -> Integrations.

Mod replies are ephemeral by default (`notify.public_confirmations` changes that). `/ban` asks for a confirmation button unless you pass `confirm:true`. Moderator names are **hidden** from punished members by default (`notify.show_moderator`).

## How it works

- **Cases.** Every action is one row with a per-server number: strike, warning, timeout, kick, ban, unban, note, watchlist change or settings change. The log entry is rendered from the case and **edited in place** when the reason changes or the case is revoked or expires.
- **Transactional outbox.** A case and its follow-up jobs (DM, log post, tracker refresh, escalation) are written in one SQLite transaction. A worker delivers them in order per server, with retries and backoff. If the bot crashes, unfinished jobs are re-queued at startup, and log posts are idempotent through the stored message ID.
- **Escalation.** A strike counts the active strikes inside its own transaction, so two moderators striking at once can't double-ban. When a strike crosses a step on the ladder, that step fires once: the most severe applicable step runs, and every step at or below the count is marked as fired.
  - Revoking a strike and adding it again doesn't fire the step a second time.
  - The markers are cleared only when strikes expire below the step, or when the escalation's own case is revoked (for example, the auto-ban is lifted).
  - If an escalation step fails (missing permissions, or the member left), the bot posts an alert with a **Retry** button. Bans go through by ID even if the member already left.
- **DMs.** DMs go out after the action succeeds. Bans and kicks are the exception: the DM is sent just before, because it can't be delivered afterwards, and a retraction follows if the action then fails.
- **Durable scheduler.** The same `jobs` table runs temp-ban unbans, mute-role removal and data purges. A one-minute sweep expires strikes and finished timeouts. Overdue jobs run at startup.
- **Mirroring.** Bans, unbans, kicks and timeouts done by hand in Discord are recorded as cases from the audit log.
- **Tracker.** The tracker lives in `log.tracker_channel` (default: the log channel). Edits are debounced to one per server every 5 seconds. It spreads across up to 5 messages within every embed limit, recreates itself if deleted, and is rebuilt at startup. Members who left or are banned are hidden unless `tracker.include_departed` is on.
- **Watchlist.** It replaces ban-on-join: ban, alert or time out a user when they join. Every 6 hours, and at startup, the bot sweeps current members, so joins that happened while it was offline are caught. Plain `/ban` already works on users who aren't in the server.
- **Modmail.** A member DMs the bot. If they share several modmail servers with it, they pick one first, and nothing is forwarded until they do. Each conversation gets its own thread, a forum post or a thread in a text channel. Staff answer with `/reply` or `/areply` (anonymous). `/close` sends a transcript. Files are downloaded before relaying. Each user is rate-limited to 5 messages per 10 seconds, and staff can block users.
- **Privacy.**
  - `/export cases` gives you a CSV or JSON file.
  - `/purge-user-data` deletes a user's cases, watchlist entry and modmail, and anonymises cases they handled as a moderator.
  - Leaving a server schedules deletion of its data after `GUILD_DATA_GRACE` (30 days). Rejoining cancels it.
  - Closed modmail is kept for `modmail.retention_days` (90).
- **Ops.**
  - `/healthz` reports the process is up.
  - `/readyz` checks the gateway and the database.
  - `/metrics` serves Prometheus metrics.
  - Online SQLite backups run every `BACKUP_INTERVAL`, keeping the newest `BACKUP_KEEP` in `DATA_DIR/backups`.

### Layout and modules

| Path            | Contents                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core`      | Pure logic with no Discord: case types, durations, timestamps, permissions and the target guard, the escalation planner, the settings registry, tracker layout |
| `src/services`  | Cases (with the outbox), job queue and worker, settings cache                                                                                                  |
| `src/storage`   | Kysely schema, core migration, database opener                                                                                                                 |
| `src/discord`   | Router (tier, module and maintenance checks), rendering, evidence download, delivery, confirmations, command sync                                              |
| `src/modules/*` | Feature modules: `admin` (core), `moderation`, `tracker`, `watchlist`, `modmail`                                                                               |
| `src/app`       | Config, logging, wiring, scheduler, HTTP, backups, entry point                                                                                                 |
| `src/tools`     | Legacy importer                                                                                                                                                |

A **module** (`src/modules/types.ts`) can declare:
- commands and context menus
- button, select and modal handlers
- settings keys (with parsers, defaults and validation, which `/config` picks up automatically)
- case types (title, colour, icon, whether they count as strikes)
- migrations
- job handlers
- case hooks (jobs written in the same transaction as a case)
- gateway events and periodic tasks
- data purge hooks

To add a feature, write a module and list it in `src/modules/index.ts`. Admins can turn optional modules off per server with `/modules`.
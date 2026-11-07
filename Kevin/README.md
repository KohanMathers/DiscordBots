# Kevin v1

> Fork of the MemberMessenger base. How it differs: see [FORK.md](FORK.md). Everything below describes the shared base.

A community Discord bot covering:
- member and server info
- channel locks that restore exactly
- message purges
- saved auto-responses
- scheduled messages, one-off or recurring
- generated Top Gear-style intros for fun

It's also the **base** for the bots that fork from it (see [FORK.md](FORK.md)).

This is a clean-room rewrite built only from the v3 spec (Nov 6, 2026) and the content lists the owner supplied. None of the v2.0 source was used.

## Running it

Needs Node 24 or newer and pnpm. There's no build step: Node runs the TypeScript directly.

```sh
pnpm install
cp .env.example .env     # then set DISCORD_TOKEN
pnpm start
```

`pnpm test` runs the tests (no network) and `pnpm typecheck` checks types. On Pterodactyl, use the shared egg at the repo root with App Directory `MemberMessenger`.

**Developer Portal:** turn on the **Server Members** intent. Join positions and member counts need it. Message Content stays off unless you set `ENABLE_MESSAGE_CONTENT=true`, which enables passive auto-responses and `/purge contains:`.

**Invite permissions:** View Channels, Send Messages, Send Messages in Threads, Embed Links, Read Message History, Manage Messages (purge) and Manage Roles (lock, which edits channel permissions). Scopes: `bot applications.commands`.

## Commands

| Command                                                                                  | Who             | What                                                                                                               |
| ---------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/bot ping\|info\|hello`                                                                 | everyone        | Latency; version, uptime and links; a greeting                                                                     |
| `/help [command]`                                                                        | everyone        | Commands *you* can use, built from the registry                                                                    |
| `/member info [user]`, right-click -> **Member info**                                    | everyone        | Name, time in the server, join position (bots excluded), roles, server size                                        |
| `/server info`                                                                           | everyone        | Owner, age, people/bot split, channels, roles, boosts, verification                                                |
| `/lock [channel] [duration] [reason]`, `/unlock [channel]`                               | Manage Messages | Exact snapshot and restore of overrides, optional auto-unlock. In a thread, acts on the parent channel             |
| `/purge amount [user] [contains] [bots_only] [include_pinned]`                           | Manage Messages | 1–1000 messages, batched; messages older than 14 days are deleted one by one; progress updates and a Cancel button |
| `/autoresponse add\|edit\|remove\|list`, right-click a message -> **Send auto-response** | Manage Messages | Saved replies with case-insensitive keywords, an optional embed, and optional passive matching                     |
| `/schedule create\|list\|edit\|cancel\|preview`                                          | Manage Messages | One-off or daily/weekly/monthly posts; time zone aware; the text is written in a form                              |
| `/fun intro [member]`, `/fun tonight`                                                    | everyone        | Top Gear-style intros from the content packs                                                                       |
| `/config panel\|view\|set\|unset\|export\|reset-data`                                    | Manage Server   | Settings, module switches, JSON export, delete everything                                                          |

Moderation and settings replies are ephemeral; info and fun replies are public. Permissions are checked in the channel the command acts on. The bot names any permission it's missing.

**Template variables** for auto-responses and scheduled messages: `{member}`, `{member.mention}`, `{member.id}`, `{server}`, `{membercount}`, `{channel}`. Unknown ones are left as typed.

**Mass pings:** saved content may only contain `@everyone`, `@here` or role pings if its author has **Mention Everyone** *and* the server allows it (`/config panel`). Every bot message sets allowed mentions explicitly.

## How it works

- **Locks.** Locking denies Send Messages and Send Messages in Threads for `@everyone`, for every non-staff role override below the bot, and for member overrides that allow sending.
  - Staff roles (Manage Messages, Manage Channels or Administrator) and roles at or above the bot are never touched.
  - The bot gives itself an allow so it can still post.
  - The previous allow, deny or inherit state of every override is saved *before* anything changes. `/unlock` restores it exactly, even after a restart, and removes overrides the lock created.
  - If Discord refuses partway through a lock, everything already changed is rolled back.
- **Scheduler.**
  - **Storage:** each message is a row with its status (`pending`, `sent`, `failed` or `cancelled`). It stores its local wall-clock time plus the IANA time zone, so daylight-saving changes never shift it.
  - **Timing:** the dispatcher sleeps until the next due time rather than polling every minute, and claims work with a lease, so two instances never double-send.
  - **Retries:** sends retry with backoff up to 5 attempts. A deleted channel or lost access fails it at once, and the bot DMs the creator and posts to the log channel.
  - **Downtime:** after a restart, overdue messages within the grace window (24 h by default) are sent. Older ones are marked `missed` and the creator is told.
  - **Time input:** `when` accepts `DD/MM/YYYY HH:MM`, `YYYY-MM-DD HH:MM`, `HH:MM`, `tomorrow HH:MM` or `in 2h`. Past times are rejected. Abbreviations like `EST` are rejected with a suggestion (`America/New_York`).
- **Join position.** A join-order index is kept up to date from member join and leave events, and rebuilt from a full member fetch at most daily. A lookup is one indexed count (tested at 10,000 members), with bots excluded.
- **Audit log.** Locks, unlocks, purges, auto-response changes, schedule changes and settings changes each write an `audit_log` row. A job posts an embed to `log.channel`; the row and the job are written in the same transaction.
- **Data lifecycle.** Leaving a server sets `left_at`. A daily job deletes everything for servers gone longer than `GUILD_DATA_GRACE_DAYS` (30). Rejoining cancels it. `/config export` and `/config reset-data` cover data requests.
- **Ops.**
  - `/healthz` returns 200 only when the gateway is connected and the database answers.
  - `/metrics` reports commands by name and outcome, scheduler lag, pending scheduled messages and gateway ping.
  - Every command logs one structured line with `guild_id`, `command`, `actor_id`, `latency_ms`, `outcome` and `correlation_id`. Errors show users the correlation ID.

### Layout

| Path                 | Contents                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/variant.ts`     | **The fork file:** branding, the module list, string overrides                                                                             |
| `src/messages.ts`    | The message catalogue (every user-facing string, by key)                                                                                   |
| `src/core`           | Pure logic: time zones, DST and recurrence, lock planning, purge planning, templates and mentions, content packs, settings registry, ports |
| `src/services`       | Locks, purge, scheduler, auto-responses, audit, join index, settings, guild lifecycle, job queue and worker                                |
| `src/discord`        | Router (the middleware chain), adapters implementing the ports, replies, forms, command sync                                               |
| `src/modules/*`      | `info`, `moderation`, `autoresponse`, `scheduler`, `fun`, `config`                                                                         |
| `src/fork/`          | Fork-only modules (empty in the base)                                                                                                      |
| `content/fun/*.yaml` | Fun packs: 155 facts, three intro slots (55/49/55), sentence templates                                                                     |

A **module** (`src/modules/types.ts`) can declare:
- commands with their invoker and bot permissions, target channel, reply mode, auto-defer and cooldown
- component handlers
- settings (which `/config` picks up automatically, plus a per-server on/off switch)
- migrations, jobs, event handlers and periodic tasks

Modules can be switched per process (`MODULES=`) and per server (`/config panel`).
# QTIHelper

QTIHelper is a fork of the MemberMessenger base. This file records how it differs, so fixes to the base can be re-applied here mechanically.

## Making a fork

1. Copy the whole `MemberMessenger/` folder to the new bot's folder (skip `node_modules/`, `data/`, `.env`).
2. Edit `package.json`: `name`, `description`, `version`.
3. Edit `src/variant.ts`: name, description, colours, presence, links, which built-in `modules` ship,
   and any `messages` overrides.
4. Swap or edit the packs in `content/fun/` (or remove `fun` from `variant.modules`).
5. Fork-only features: add `src/fork/<feature>/index.ts` exporting a `Module`, list it in
   `src/fork/index.ts`. Give its migrations names starting `9xxx_` so they never clash with base ones.
6. `pnpm install && pnpm test`, then fill in the sections below.

## Base version this fork tracks

- MemberMessenger base: 3.0.4 (base changes: BASE-CHANGELOG.md)

## Changes from the base

| Area              | Change                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| package.json      | name `qti-helper`, version 1.0.0, description                                                                                                                                                                               |
| variant.ts        | `name: 'QTIHelper'`, `description: 'The official bot of QTI!'`, presence Playing "Bearly Magical"                                                                                                                           |
| content/          | — (same packs as the base)                                                                                                                                                                                                  |
| src/fork/qti/     | `/clonecat` (copy a category, its channels and overrides, with prefix renaming) and `/motd` (POST to the MOTD API). Access: `qti.roles` setting, Administrators, or `QTI_ADMIN_IDS`. Fork env in `config.ts`                |
| src/fork/tickets/ | Ticket system: `/tickets setup\|panel\|list`, `/ticket add\|remove\|rename\|claim\|close\|reopen\|transcript`, panel + in-ticket buttons. Tables `ticket`, `ticket_member` (migration `9001_tickets`). Settings `tickets.*` |
| src/fork/index.ts | lists `qtiModule`, `ticketsModule`                                                                                                                                                                                          |
| .env.example      | QTI section (`QTI_ADMIN_IDS`, `QTI_MOTD_URL`, `QTI_MOTD_TOKEN`)                                                                                                                                                             |
| test/fork.test.ts | rename rule, ticket names/transcripts/store, MOTD contract, QTI access                                                                                                                                                      |
| README.md         | title, intro, QTIHelper section                                                                                                                                                                                             |
| other files       | —                                                                                                                                                                                                                           |

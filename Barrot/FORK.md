# Barrot

Barrot is a fork of the MemberMessenger base. This file records how it differs, so fixes to the base can be re-applied here mechanically.

## Making a fork

1. Copy the whole `MemberMessenger/` folder to the new bot's folder (skip `node_modules/`, `data/`, `.env`).
2. Edit `package.json`: `name`, `description`, `version`.
3. Edit `src/variant.ts`: name, description, colours, presence, links, which built-in `modules` ship, and any `messages` overrides.
4. Swap or edit the packs in `content/fun/` (or remove `fun` from `variant.modules`).
5. Fork-only features: add `src/fork/<feature>/index.ts` exporting a `Module`, list it in `src/fork/index.ts`. Give its migrations names starting `9xxx_` so they never clash with base ones.
6. `pnpm install && pnpm test`, then fill in the sections below.

## Base version this fork tracks

- MemberMessenger base: 3.0.4

## Changes from the base

| Area         | Change                                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| package.json | name `barrot`, version 1.0.0, description                                                                                                                                                                                          |
| variant.ts   | `name: 'Barrot'`, `description: 'Poat 🔛🔝'`, presence Watching "Top Gear"                                                                                                                                                           |
| content/     | — (same packs as the base)                                                                                                                                                                                                         |
| src/fork/    | `jag/`: replies "Because he drives a" + https://klipy.com/gifs/jaaaag when a message contains "but it's okay" (any case, apostrophe optional). Sets `needsMessageContent`. 5 s per-channel cooldown. Listed in `src/fork/index.ts` |
| test/        | `fork.test.ts`: trigger phrase tests                                                                                                                                                                                               |
| README.md    | title and intro                                                                                                                                                                                                                    |
| other files  | —                                                                                                                                                                                                                                  |

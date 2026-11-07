# Fork record

This file records how this bot differs from the MemberMessenger base, so fixes to the base can be re-applied here mechanically.

## Making a fork

1. Copy the whole `MemberMessenger/` folder to the new bot's folder (skip `node_modules/`, `data/`, `.env`).
2. Edit `package.json`: `name`, `description`, `version`.
3. Edit `src/variant.ts`: name, description, colours, presence, links, which built-in `modules` ship, and any `messages` overrides.
4. Swap or edit the packs in `content/fun/` (or remove `fun` from `variant.modules`).
5. Fork-only features: add `src/fork/<feature>/index.ts` exporting a `Module`, list it in `src/fork/index.ts`. Give its migrations names starting `9xxx_` so they never clash with base ones.
6. `pnpm install && pnpm test`, then fill in the sections below.

## Base version this fork tracks

- MemberMessenger base: 3.0.3 (see CHANGELOG.md)

## Changes from the base

| Area        | Change                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| variant.ts  | —                                                                                       |
| content/    | —                                                                                       |
| src/fork/   | `colour` module — `/colour` self-assigns a colour role from `content/fun/role-map.yaml` |
| other files | —                                                                                       |

# SudoBot

SudoBot is a fork of the MemberMessenger base: support for Kohan's plugins and the Quill language.
This file records how it differs, so fixes to the base can be re-applied here mechanically.

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

| Area                       | Change                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| package.json               | name `sudobot`, version 1.0.0, description; dependency `node-html-parser` (for /quilldocs)                                                                                                                   |
| variant.ts                 | `name: 'SudoBot'`                                                                                                                                                                                            |
| content/sudobot/links.yaml | the /links list                                                                                                                                                                                              |
| src/fork/support/          | `/links`, `/ver`, `/prndebug`, `/pluginconfig`, message menu **Send support instructions**; setting `support.paste_channel`                                                                                  |
| src/fork/quill/            | Quill simulator (lexer, parser, runtime, built-ins, worker-thread sandbox), `/quill`, message menu **Run Quill**, `/quillhelp`, `/quilldocs`. Ported from the old SudoBot source with the owner's permission |
| src/fork/detect/           | passive `/ver`-output and ```yaml detection (`needsMessageContent`)                                                                                                                                          |
| src/fork/index.ts          | lists `supportModule`, `quillModule`, `detectModule`                                                                                                                                                         |
| test/fork.test.ts          | Quill language/simulation/sandbox/embeds/docs, version detection, YAML overview, support texts                                                                                                               |
| README.md                  | title, intro, SudoBot section                                                                                                                                                                                |
| other files                | —                                                                                                                                                                                                            |

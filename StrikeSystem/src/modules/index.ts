import { coreModule } from './admin/index.ts';
import { moderationModule } from './moderation/index.ts';
import { modmailModule } from './modmail/index.ts';
import { trackerModule } from './tracker/index.ts';
import type { Module } from './types.ts';
import { watchlistModule } from './watchlist/index.ts';

export const MODULES: Module[] = [coreModule, moderationModule, trackerModule, watchlistModule, modmailModule];

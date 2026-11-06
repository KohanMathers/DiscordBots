import type { Module } from '../modules/types.ts';
import { qtiModule } from './qti/index.ts';
import { ticketsModule } from './tickets/index.ts';

export const forkModules: Module[] = [qtiModule, ticketsModule];

import type { Module } from '../modules/types.ts';
import { colourModule } from './colour/index.ts';
import { jagModule } from './jag/index.js';

export const forkModules: Module[] = [colourModule, jagModule];
import type { Module } from '../modules/types.ts';
import { colourModule } from './colour/index.ts';

export const forkModules: Module[] = [colourModule];
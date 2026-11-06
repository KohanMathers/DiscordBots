import type { Module } from '../modules/types.ts';
import { jagModule } from './jag/index.ts';

export const forkModules: Module[] = [jagModule];

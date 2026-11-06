import type { Module } from '../modules/types.ts';
import { detectModule } from './detect/index.ts';
import { quillModule } from './quill/index.ts';
import { supportModule } from './support/index.ts';

export const forkModules: Module[] = [supportModule, quillModule, detectModule];

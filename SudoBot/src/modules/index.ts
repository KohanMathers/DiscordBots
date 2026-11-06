import { autoresponseModule } from './autoresponse/index.ts';
import { configModule } from './config/index.ts';
import { funModule } from './fun/index.ts';
import { infoModule } from './info/index.ts';
import { moderationModule } from './moderation/index.ts';
import { schedulerModule } from './scheduler/index.ts';
import type { Module } from './types.ts';

export const BUILT_IN_MODULES: Record<string, Module> = {
  info: infoModule,
  moderation: moderationModule,
  autoresponse: autoresponseModule,
  scheduler: schedulerModule,
  fun: funModule,
  config: configModule,
};

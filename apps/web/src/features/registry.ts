import type { FeatureModule } from '@/platform/features/feature-module';

import { assetsFeature } from './assets/module';
import { charactersFeature } from './characters/module';
import { chatsFeature } from './chats/module';
import { extensionsFeature } from './extensions/module';
import { personasFeature } from './personas/module';
import { presetsFeature } from './presets/module';
import { promptPipelineFeature } from './prompt-pipeline/module';
import { settingsFeature } from './settings/module';
import { worldBooksFeature } from './world-books/module';

export const featureModules: readonly FeatureModule[] = [
  settingsFeature,
  assetsFeature,
  personasFeature,
  charactersFeature,
  chatsFeature,
  worldBooksFeature,
  presetsFeature,
  extensionsFeature,
  promptPipelineFeature,
];

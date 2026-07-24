import type { FeatureModule } from '@/platform/features/feature-module';

import { assetsFeature } from './assets/module';
import { charactersFeature } from './characters/module';
import { chatsFeature } from './chats/module';
import { presetsFeature } from './presets/module';
import { settingsFeature } from './settings/module';
import { worldBooksFeature } from './world-books/module';

export const featureModules: readonly FeatureModule[] = [
  settingsFeature,
  assetsFeature,
  charactersFeature,
  chatsFeature,
  worldBooksFeature,
  presetsFeature,
];

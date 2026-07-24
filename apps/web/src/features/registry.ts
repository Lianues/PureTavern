import type { FeatureModule } from '@/platform/features/feature-module';

import { charactersFeature } from './characters/module';
import { settingsFeature } from './settings/module';

export const featureModules: readonly FeatureModule[] = [settingsFeature, charactersFeature];

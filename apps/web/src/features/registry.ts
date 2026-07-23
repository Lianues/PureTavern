import type { FeatureModule } from '@/platform/features/feature-module';

import { settingsFeature } from './settings/module';

export const featureModules: readonly FeatureModule[] = [settingsFeature];

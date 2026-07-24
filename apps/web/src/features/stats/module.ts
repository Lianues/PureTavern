import type { FeatureModule } from '@/platform/features/feature-module';
import { registerArchiveModule } from '@/platform/features/register-archive-module';
import {
  chatStatsSourceCapability,
  type ChatStatsSourceCapability,
} from '@/platform/features/standard-capabilities';

import { StatsService } from './application/stats-service';
import { IndexedDbStatsRepository } from './infrastructure/indexeddb-stats-repository';
import { ResilientStatsRepository } from './infrastructure/resilient-stats-repository';
import { registerStatsLegacyRoutes } from './legacy/register-routes';

const emptyChatSource: ChatStatsSourceCapability = {
  async listChatsForStats() {
    return [];
  },
};

export const statsFeature: FeatureModule = {
  id: 'stats',
  install(context) {
    const { router, records, capabilities } = context;
    registerArchiveModule(context, { moduleId: 'stats', displayName: 'Usage Stats' });
    const repository = new ResilientStatsRepository(new IndexedDbStatsRepository(records));
    const chatSource = capabilities.get(chatStatsSourceCapability);
    const service = new StatsService(repository, chatSource ?? emptyChatSource);

    registerStatsLegacyRoutes(router, service);

    return {
      diagnostics: {
        storage: repository.diagnostics,
        chatSource: {
          status: chatSource ? 'ready' : 'unavailable',
          capability: chatStatsSourceCapability.id,
        },
        consistency: {
          writePath: 'legacy-fire-and-forget',
          repairPath: 'chat-derived-recreate',
          blocksChatWrites: false,
        },
      },
    };
  },
};

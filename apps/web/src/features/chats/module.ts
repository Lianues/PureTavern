import type { FeatureModule } from '@/platform/features/feature-module';
import { registerArchiveModule } from '@/platform/features/register-archive-module';
import {
  characterIdentityCapability,
  chatOwnerLifecycleCapability,
  chatStatsSourceCapability,
} from '@/platform/features/standard-capabilities';

import { ChatService } from './application/chat-service';
import { OwnerIdentityResolver } from './application/owner-identity-resolver';
import { BrowserChatImportExportAdapter } from './infrastructure/chat-import-export-adapter';
import { IndexedDbChatRepository } from './infrastructure/indexeddb-chat-repository';
import { IndexedDbMessageRepository } from './infrastructure/indexeddb-message-repository';
import { IndexedDbOwnerAliasRepository } from './infrastructure/indexeddb-owner-alias-repository';
import {
  ResilientChatRepository,
  ResilientMessageRepository,
  ResilientOwnerAliasRepository,
} from './infrastructure/resilient-repositories';
import { registerChatsLegacyRoutes } from './legacy/register-routes';

export const chatsFeature: FeatureModule = {
  id: 'chats',
  install(context) {
    const { router, records, capabilities } = context;
    const sessions = new ResilientChatRepository(new IndexedDbChatRepository(records));
    const messages = new ResilientMessageRepository(new IndexedDbMessageRepository(records));
    const aliases = new ResilientOwnerAliasRepository(new IndexedDbOwnerAliasRepository(records));
    registerArchiveModule(context, {
      moduleId: 'chats',
      displayName: 'Chats & Messages',
      assertExportable() {
        if (
          sessions.hasPendingWrites() ||
          messages.hasPendingWrites() ||
          aliases.hasPendingWrites()
        ) {
          throw new Error(
            'Chat changes are only held in this page because storage could not save them. Export individual chats before closing the page; a complete archive cannot be created yet.',
          );
        }
      },
    });
    const owners = new OwnerIdentityResolver(
      aliases,
      capabilities.get(characterIdentityCapability),
    );
    const service = new ChatService(
      sessions,
      messages,
      owners,
      new BrowserChatImportExportAdapter(),
    );

    capabilities.register(chatOwnerLifecycleCapability, {
      deleteChatsForOwner: (ownerId) => service.deleteChatsForOwner(ownerId),
    });
    capabilities.register(chatStatsSourceCapability, {
      async listChatsForStats() {
        const storedSessions = await sessions.list();
        return Promise.all(
          storedSessions.map(async (session) => ({
            id: session.id,
            ownerId: session.ownerId,
            avatarUrl: await owners.getCurrentAvatar(session.ownerId, session.ownerAlias),
            byteSize: session.byteSize,
            updatedAt: session.updatedAt,
            messages: await messages.get(session.id),
          })),
        );
      },
    });
    registerChatsLegacyRoutes(router, service);

    return {
      diagnostics: {
        storage: sessions.diagnostics,
        messages: messages.diagnostics,
        aliases: aliases.diagnostics,
      },
    };
  },
};

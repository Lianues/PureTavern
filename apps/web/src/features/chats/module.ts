import type { FeatureModule } from '@/platform/features/feature-module';
import {
  characterIdentityCapability,
  chatOwnerLifecycleCapability,
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
  install({ router, records, capabilities }) {
    const sessions = new ResilientChatRepository(new IndexedDbChatRepository(records));
    const messages = new ResilientMessageRepository(new IndexedDbMessageRepository(records));
    const aliases = new ResilientOwnerAliasRepository(new IndexedDbOwnerAliasRepository(records));
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

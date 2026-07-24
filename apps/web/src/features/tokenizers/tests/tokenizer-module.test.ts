import { afterEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '@/platform/features/capability-registry';
import { tokenizerCapability } from '@/platform/features/standard-capabilities';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';

import { tokenizersFeature } from '../module';

const databases: AppDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('M15 capability integration', () => {
  it('registers the unified approximate tokenizer independently of prompt ownership', async () => {
    const database = new AppDatabase(`pure-tavern-tokenizer-module-${crypto.randomUUID()}`);
    databases.push(database);
    const storage = new AppStorage(database);
    const capabilities = new CapabilityRegistry();
    const result = tokenizersFeature.install({
      router: new CompatibilityRouter(),
      nativeFetch: fetch,
      records: storage.records.forModule('tokenizers'),
      blobs: storage.blobs.forModule('tokenizers'),
      capabilities,
    });

    const tokenizer = capabilities.get(tokenizerCapability);
    expect(tokenizer).not.toBeNull();
    await expect(tokenizer!.countText('One tokenizer for every model.')).resolves.toBeGreaterThan(
      0,
    );
    expect(result.diagnostics).toMatchObject({
      semantics: 'unified-approximate-tokenx',
      modelSpecific: false,
      pseudoTokenIds: true,
    });
  });
});

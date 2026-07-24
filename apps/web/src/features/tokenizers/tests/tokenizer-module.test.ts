import { afterEach, describe, expect, it } from 'vitest';

import { promptPipelineRuntimeCapability } from '@/features/prompt-pipeline/module';
import { promptPipelineFeature } from '@/features/prompt-pipeline/module';
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
  it('installs before M10 and supplies its approximate message estimator', async () => {
    const database = new AppDatabase(`pure-tavern-tokenizer-module-${crypto.randomUUID()}`);
    databases.push(database);
    const storage = new AppStorage(database);
    const capabilities = new CapabilityRegistry();
    const router = new CompatibilityRouter();
    const tokenizerResult = tokenizersFeature.install({
      router,
      nativeFetch: fetch,
      records: storage.records.forModule('tokenizers'),
      blobs: storage.blobs.forModule('tokenizers'),
      capabilities,
    });
    const promptResult = promptPipelineFeature.install({
      router,
      nativeFetch: fetch,
      records: storage.records.forModule('prompt-pipeline'),
      blobs: storage.blobs.forModule('prompt-pipeline'),
      capabilities,
    });

    const tokenizer = capabilities.get(tokenizerCapability);
    const promptPipeline = capabilities.get(promptPipelineRuntimeCapability);
    expect(tokenizer).not.toBeNull();
    expect(promptPipeline).not.toBeNull();
    await expect(tokenizer!.countText('One tokenizer for every model.')).resolves.toBeGreaterThan(
      0,
    );
    expect(tokenizerResult.diagnostics).toMatchObject({
      semantics: 'unified-approximate-tokenx',
      modelSpecific: false,
    });
    expect(promptResult.diagnostics).toMatchObject({
      tokenizerPrecision: 'approximate',
      estimator: 'tokenx-unified-approximate',
      replacementEnabled: false,
    });
  });
});

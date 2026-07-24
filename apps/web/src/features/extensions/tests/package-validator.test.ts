import { describe, expect, it } from 'vitest';

import {
  ExtensionPackageValidationError,
  validateLocalExtensionPackage,
} from '../application/package-validator';
import { makeWorkerPackage } from './test-helpers';

describe('local extension package validation', () => {
  it('accepts a hashed worker package and returns deterministic metadata', async () => {
    const files = await makeWorkerPackage('org.example.valid', {
      capabilities: ['storage:plugin'],
    });

    const validated = await validateLocalExtensionPackage(files);

    expect(validated).toMatchObject({
      manifest: {
        id: 'org.example.valid',
        entrypoint: { type: 'worker', path: 'worker.js' },
        requestedCapabilities: ['storage:plugin'],
      },
      fileCount: 2,
    });
    expect(validated.packageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['../worker.js', '/worker.js', 'folder\\worker.js', '%2e%2e/worker.js', 'C:/worker.js'])(
    'rejects unsafe or traversing path %s',
    async (path) => {
      const files = await makeWorkerPackage('org.example.path');
      files[1] = { ...files[1]!, path };

      await expect(validateLocalExtensionPackage(files)).rejects.toMatchObject({
        name: 'ExtensionPackageValidationError',
      });
    },
  );

  it('rejects hash mismatch', async () => {
    const files = await makeWorkerPackage('org.example.hash', {
      hashOverride: '0'.repeat(64),
    });

    await expect(validateLocalExtensionPackage(files)).rejects.toMatchObject({
      code: 'hash-mismatch',
    });
  });

  it('rejects package size and file-count limits before persistence', async () => {
    const files = await makeWorkerPackage('org.example.limits');

    await expect(
      validateLocalExtensionPackage(files, {
        maxFiles: 1,
        maxTotalBytes: 1_000_000,
        maxManifestBytes: 1_000_000,
        maxPathLength: 240,
      }),
    ).rejects.toMatchObject({ code: 'file-count' });

    await expect(
      validateLocalExtensionPackage(files, {
        maxFiles: 10,
        maxTotalBytes: 1,
        maxManifestBytes: 1_000_000,
        maxPathLength: 240,
      }),
    ).rejects.toMatchObject({ code: 'package-size' });
  });

  it('rejects case/Unicode duplicate conflicts', async () => {
    const files = await makeWorkerPackage('org.example.duplicate', {
      extraFiles: [{ path: 'Worker.js', data: new Blob(['duplicate']) }],
    });

    await expect(validateLocalExtensionPackage(files)).rejects.toMatchObject({
      code: 'duplicate-path',
    });
  });

  it('reserves same-context entrypoints for trusted built-ins', async () => {
    const files = await makeWorkerPackage('org.example.same-context', {
      entryType: 'same-context',
    });

    await expect(validateLocalExtensionPackage(files)).rejects.toEqual(
      expect.objectContaining<Partial<ExtensionPackageValidationError>>({ code: 'entry-type' }),
    );
  });
});

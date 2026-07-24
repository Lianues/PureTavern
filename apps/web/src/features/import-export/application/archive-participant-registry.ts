import type {
  ArchiveConflictStrategy,
  ArchiveModuleImportResult,
  ArchiveModulePreview,
  PureTavernArchiveFile,
  PureTavernArchiveModule,
} from '@pure-tavern/contracts';

import type {
  ArchiveModuleRegistration,
  ArchiveParticipantRegistryCapability,
} from '@/platform/features/standard-capabilities';

import { ArchiveValidationError } from '../domain/archive';

const textEncoder = new TextEncoder();

export interface PortableArchiveEntry {
  descriptor: PureTavernArchiveFile;
  data: Uint8Array;
}

export class ArchiveParticipantRegistry implements ArchiveParticipantRegistryCapability {
  readonly #participants = new Map<string, ScopedArchiveParticipant>();

  registerModule(registration: ArchiveModuleRegistration): void {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(registration.moduleId)) {
      throw new TypeError(`Invalid archive module id: ${registration.moduleId}`);
    }
    if (!Number.isSafeInteger(registration.dataVersion) || registration.dataVersion < 1) {
      throw new TypeError(
        `Archive dataVersion must be a positive integer: ${registration.moduleId}`,
      );
    }
    if (this.#participants.has(registration.moduleId)) {
      throw new Error(`Archive participant is registered more than once: ${registration.moduleId}`);
    }
    this.#participants.set(registration.moduleId, new ScopedArchiveParticipant(registration));
  }

  hasModule(moduleId: string): boolean {
    return this.#participants.has(moduleId);
  }

  list(): ScopedArchiveParticipant[] {
    return [...this.#participants.values()].sort((left, right) =>
      left.moduleId.localeCompare(right.moduleId, 'en'),
    );
  }

  get(moduleId: string): ScopedArchiveParticipant | null {
    return this.#participants.get(moduleId) ?? null;
  }
}

export class ScopedArchiveParticipant {
  readonly moduleId: string;
  readonly displayName: string;
  readonly dataVersion: number;
  readonly sensitive: boolean;
  readonly defaultSelected: boolean;
  readonly #registration: ArchiveModuleRegistration;

  constructor(registration: ArchiveModuleRegistration) {
    this.#registration = registration;
    this.moduleId = registration.moduleId;
    this.displayName = registration.displayName;
    this.dataVersion = registration.dataVersion;
    this.sensitive = registration.sensitive;
    this.defaultSelected = registration.defaultSelected;
  }

  async inspect(): Promise<PureTavernArchiveModule> {
    const [records, blobs] = await Promise.all([
      this.#registration.records.listAll(),
      this.#registration.blobs.listAll(),
    ]);
    const recordBytes = records.reduce(
      (total, record) => total + textEncoder.encode(JSON.stringify(record.value)).byteLength,
      0,
    );
    const blobBytes = blobs.reduce((total, blob) => total + blob.data.size, 0);
    return {
      moduleId: this.moduleId,
      displayName: this.displayName,
      dataVersion: this.dataVersion,
      sensitive: this.sensitive,
      recordCount: records.length,
      blobCount: blobs.length,
      totalBytes: recordBytes + blobBytes,
    };
  }

  async exportEntries(): Promise<PortableArchiveEntry[]> {
    const [records, blobs] = await Promise.all([
      this.#registration.records.listAll(),
      this.#registration.blobs.listAll(),
    ]);
    const entries: PortableArchiveEntry[] = [];
    for (const record of records) {
      const data = textEncoder.encode(JSON.stringify(record.value));
      entries.push({
        descriptor: {
          path: archivePath(this.moduleId, 'record', record.collection, record.id, 'json'),
          moduleId: this.moduleId,
          kind: 'record',
          collection: record.collection,
          id: record.id,
          size: data.byteLength,
          sha256: '',
          updatedAt: record.updatedAt,
          contentType: 'application/json',
        },
        data,
      });
    }
    for (const blob of blobs) {
      const bytes = new Uint8Array(await blob.data.arrayBuffer());
      entries.push({
        descriptor: {
          path: archivePath(this.moduleId, 'blob', blob.collection, blob.id, 'bin'),
          moduleId: this.moduleId,
          kind: 'blob',
          collection: blob.collection,
          id: blob.id,
          size: bytes.byteLength,
          sha256: '',
          updatedAt: blob.updatedAt,
          contentType: blob.data.type || 'application/octet-stream',
          metadata: blob.metadata,
        },
        data: bytes,
      });
    }
    return entries.sort((left, right) =>
      left.descriptor.path.localeCompare(right.descriptor.path, 'en'),
    );
  }

  async preview(
    entries: readonly PortableArchiveEntry[],
    selected: boolean,
  ): Promise<ArchiveModulePreview> {
    let conflicts = 0;
    for (const entry of entries) {
      const existing =
        entry.descriptor.kind === 'record'
          ? await this.#registration.records.get(entry.descriptor.collection, entry.descriptor.id)
          : await this.#registration.blobs.get(entry.descriptor.collection, entry.descriptor.id);
      if (existing) conflicts += 1;
    }
    return {
      moduleId: this.moduleId,
      displayName: this.displayName,
      dataVersion: this.dataVersion,
      available: true,
      selected,
      sensitive: this.sensitive,
      incomingRecords: entries.filter((entry) => entry.descriptor.kind === 'record').length,
      incomingBlobs: entries.filter((entry) => entry.descriptor.kind === 'blob').length,
      conflicts,
      newItems: entries.length - conflicts,
      warnings: [],
    };
  }

  async importEntries(
    entries: readonly PortableArchiveEntry[],
    strategy: ArchiveConflictStrategy,
  ): Promise<ArchiveModuleImportResult> {
    if (strategy === 'replace-module' || strategy === 'replace-all') {
      await Promise.all([
        this.#registration.records.clearAll(),
        this.#registration.blobs.clearAll(),
      ]);
    }

    const result: ArchiveModuleImportResult = {
      moduleId: this.moduleId,
      imported: 0,
      overwritten: 0,
      skipped: 0,
      errors: [],
    };
    for (const entry of entries) {
      try {
        const existing =
          entry.descriptor.kind === 'record'
            ? await this.#registration.records.get(entry.descriptor.collection, entry.descriptor.id)
            : await this.#registration.blobs.get(entry.descriptor.collection, entry.descriptor.id);
        if (existing && strategy === 'skip') {
          result.skipped += 1;
          continue;
        }
        if (entry.descriptor.kind === 'record') {
          const text = new TextDecoder().decode(entry.data);
          const value = JSON.parse(text) as unknown;
          await this.#registration.records.put(
            entry.descriptor.collection,
            entry.descriptor.id,
            value,
          );
        } else {
          const copy = entry.data.slice();
          await this.#registration.blobs.put(
            entry.descriptor.collection,
            entry.descriptor.id,
            new Blob([copy.buffer], {
              type: entry.descriptor.contentType ?? 'application/octet-stream',
            }),
            entry.descriptor.metadata ?? {},
          );
        }
        if (existing) result.overwritten += 1;
        else result.imported += 1;
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }
}

function archivePath(
  moduleId: string,
  kind: 'record' | 'blob',
  collection: string,
  id: string,
  extension: string,
): string {
  try {
    return `modules/${encodeURIComponent(moduleId)}/${kind}s/${encodeURIComponent(collection)}/${encodeURIComponent(id)}.${extension}`;
  } catch (error) {
    throw new ArchiveValidationError(
      'unsafe-identifier',
      `Module data contains an identifier that cannot be archived: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

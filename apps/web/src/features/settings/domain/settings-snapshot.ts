import { cloneSettingsDocument, type SettingsDocument } from './settings-document';

export interface SettingsSnapshot {
  name: string;
  document: SettingsDocument;
  createdAt: number;
  size: number;
}

export interface SettingsSnapshotSummary {
  name: string;
  date: number;
  size: number;
}

export function serializeSettingsSnapshot(document: SettingsDocument): string {
  return JSON.stringify(cloneSettingsDocument(document), null, 4);
}

export function getSettingsSnapshotSize(document: SettingsDocument): number {
  return new TextEncoder().encode(serializeSettingsSnapshot(document)).byteLength;
}

export function cloneSettingsSnapshot(snapshot: SettingsSnapshot): SettingsSnapshot {
  return {
    ...snapshot,
    document: cloneSettingsDocument(snapshot.document),
  };
}

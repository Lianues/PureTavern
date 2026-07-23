export type SettingsDocument = Record<string, unknown>;

export function cloneSettingsDocument(value: unknown): SettingsDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Settings payload must be a JSON object.');
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError('Settings payload must be JSON-serializable.', { cause: error });
  }

  if (serialized === undefined) {
    throw new TypeError('Settings payload must be JSON-serializable.');
  }

  const clone: unknown = JSON.parse(serialized);
  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    throw new TypeError('Settings payload must be a JSON object.');
  }

  return clone as SettingsDocument;
}

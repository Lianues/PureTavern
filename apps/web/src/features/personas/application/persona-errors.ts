export class PersonaValidationError extends Error {
  override readonly name = 'PersonaValidationError';
}

export class PersonaNotFoundError extends Error {
  override readonly name = 'PersonaNotFoundError';
}

export class PersonaConflictError extends Error {
  override readonly name = 'PersonaConflictError';
}

export class PersonaAssetUnavailableError extends Error {
  override readonly name = 'PersonaAssetUnavailableError';
}

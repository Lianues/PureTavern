export class AssetError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 500, code = 'ASSET_ERROR') {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}

export class AssetValidationError extends AssetError {
  constructor(message: string) {
    super(message, 400, 'ASSET_VALIDATION_ERROR');
  }
}

export class AssetNotFoundError extends AssetError {
  constructor(message: string) {
    super(message, 404, 'ASSET_NOT_FOUND');
  }
}

export class AssetConflictError extends AssetError {
  constructor(message: string) {
    super(message, 409, 'ASSET_CONFLICT');
  }
}

export class AssetFetchError extends AssetError {
  constructor(message: string) {
    super(message, 502, 'ASSET_FETCH_FAILED');
  }
}

export class ImageProcessingUnsupportedError extends AssetError {
  constructor(message: string) {
    super(message, 501, 'IMAGE_PROCESSING_UNSUPPORTED');
  }
}

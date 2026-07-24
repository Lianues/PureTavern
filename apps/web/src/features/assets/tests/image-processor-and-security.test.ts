import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssetValidationError, ImageProcessingUnsupportedError } from '../application/asset-errors';
import { BrowserImageProcessor } from '../infrastructure/browser-image-processor';
import {
  blobFromBytes,
  bytesFromBase64,
  createMemoryHarness,
  ONE_BY_ONE_PNG_BASE64,
  pngBlob,
  pngDataUrl,
} from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BrowserImageProcessor', () => {
  it('decodes base64/Data URLs and rejects malformed input', () => {
    const processor = new BrowserImageProcessor();
    const decoded = processor.decodeBase64(pngDataUrl());
    expect(decoded.declaredMimeType).toBe('image/png');
    expect(decoded.blob).toMatchObject({ type: 'image/png' });
    expect(() => processor.decodeBase64('%%%invalid%%%')).toThrow(AssetValidationError);
    expect(() => processor.decodeBase64('data:image/png,not-base64')).toThrow(
      'Only base64 Data URLs are supported',
    );
  });

  it('reads PNG/JPEG/GIF/WebP dimensions and animation markers', async () => {
    const processor = new BrowserImageProcessor();
    await expect(processor.inspect(pngBlob())).resolves.toMatchObject({
      format: 'png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      isAnimated: false,
    });

    const apng = new Uint8Array([...bytesFromBase64(ONE_BY_ONE_PNG_BASE64), ...ascii('acTL')]);
    await expect(processor.inspect(blobFromBytes(apng, 'image/png'))).resolves.toMatchObject({
      format: 'png',
      isAnimated: true,
    });

    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ]);
    await expect(processor.inspect(blobFromBytes(jpeg, 'image/jpeg'))).resolves.toMatchObject({
      format: 'jpeg',
      width: 3,
      height: 2,
    });

    const gif = Uint8Array.from([
      ...ascii('GIF89a'),
      0x02,
      0x00,
      0x03,
      0x00,
      0x00,
      0x2c,
      0x00,
      0x2c,
    ]);
    await expect(processor.inspect(blobFromBytes(gif, 'image/gif'))).resolves.toMatchObject({
      format: 'gif',
      width: 2,
      height: 3,
      isAnimated: true,
    });

    const webp = new Uint8Array(30);
    webp.set(ascii('RIFF'), 0);
    webp.set(ascii('WEBP'), 8);
    webp.set(ascii('VP8X'), 12);
    webp[20] = 0x02;
    webp[24] = 1;
    webp[27] = 2;
    await expect(processor.inspect(blobFromBytes(webp, 'image/webp'))).resolves.toMatchObject({
      format: 'webp',
      width: 2,
      height: 3,
      isAnimated: true,
    });
  });

  it('diagnoses unavailable browser crop APIs without claiming success', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const processor = new BrowserImageProcessor();
    await expect(
      processor.processAvatar(pngBlob(), { x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toBeInstanceOf(ImageProcessingUnsupportedError);
    expect(processor.diagnostics).toMatchObject({
      status: 'degraded',
      message: expect.stringContaining('createImageBitmap is unavailable'),
    });
  });
});

describe('asset input safety', () => {
  it('rejects traversal, unsafe extensions and MIME/signature mismatches', async () => {
    const { service } = createMemoryHarness();

    await expect(service.uploadFile('../note.txt', btoa('x'))).rejects.toThrow(
      AssetValidationError,
    );
    await expect(service.uploadFile('payload.html', btoa('<script>'))).rejects.toThrow(
      'file extension is not allowed',
    );
    await expect(service.uploadFile('fake.jpg', ONE_BY_ONE_PNG_BASE64)).rejects.toThrow(
      'does not match detected image type',
    );
    await expect(
      service.uploadFile('image.png', `data:text/plain;base64,${ONE_BY_ONE_PNG_BASE64}`),
    ).rejects.toThrow('Declared MIME type text/plain');
  });

  it('accepts signature-checked video user media and filters list request types', async () => {
    const { service } = createMemoryHarness();
    const mp4 = new Uint8Array(16);
    mp4.set(ascii('ftyp'), 4);
    const mp4Base64 = btoa(String.fromCharCode(...mp4));

    await expect(
      service.uploadUserImage({
        image: `data:video/mp4;base64,${mp4Base64}`,
        format: 'mp4',
        filename: 'clip',
        ch_name: 'Alice',
      }),
    ).resolves.toBe('/user/images/Alice/clip.mp4');
    await expect(service.listUserImages({ folder: 'Alice', type: 1 })).resolves.toEqual([]);
    await expect(service.listUserImages({ folder: 'Alice', type: 2 })).resolves.toEqual([
      'clip.mp4',
    ]);
  });
});

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

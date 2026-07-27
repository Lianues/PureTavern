import { describe, expect, it } from 'vitest';

import { parseAvatarCrop } from './parse-avatar-crop';

describe('parseAvatarCrop', () => {
  it('returns complete upstream crop data', () => {
    expect(parseAvatarCrop('{"x":1,"y":2,"width":300,"height":450,"want_resize":true}')).toEqual({
      x: 1,
      y: 2,
      width: 300,
      height: 450,
      want_resize: true,
    });
  });

  it('mirrors upstream tryParse fallback for malformed or incomplete values', () => {
    expect(parseAvatarCrop('not-json')).toBeUndefined();
    expect(parseAvatarCrop('{"x":1}')).toBeUndefined();
    expect(parseAvatarCrop(null)).toBeUndefined();
  });
});

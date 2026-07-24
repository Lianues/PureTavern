import { describe, expect, it } from 'vitest';

import { formatCharacterData } from '../domain/character-card';
import { CharacterCardCodec } from '../application/character-card-codec';

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function bytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function latin1(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

describe('CharacterCardCodec', () => {
  it('round-trips PNG Character Card metadata and prefers ccv3 over chara', () => {
    const codec = new CharacterCardCodec();
    const card = formatCharacterData({ ch_name: 'Codec Alice', first_mes: 'Hello' }, 1);
    const png = codec.writePngCard(bytesFromBase64(ONE_BY_ONE_PNG_BASE64), card);

    const encoded = latin1(png);
    expect(encoded).toContain('chara\0');
    expect(encoded).toContain('ccv3\0');

    const parsed = codec.readPngCard(png);
    expect(parsed.name).toBe('Codec Alice');
    expect(parsed.spec).toBe('chara_card_v3');
    expect(parsed.spec_version).toBe('3.0');
  });

  it('rejects malformed Base64 metadata instead of accepting corrupt cards', () => {
    const codec = new CharacterCardCodec();
    const card = formatCharacterData({ ch_name: 'Broken' }, 1);
    const png = codec.writePngCard(bytesFromBase64(ONE_BY_ONE_PNG_BASE64), card);
    const marker = Uint8Array.from('ccv3\0', (char) => char.charCodeAt(0));
    const start = findSubarray(png, marker);
    expect(start).toBeGreaterThan(-1);
    png[start + marker.length] = '!'.charCodeAt(0);

    expect(() => codec.readPngCard(png)).toThrow(/Base64|invalid/i);
  });

  it('normalizes legacy JSON fields into Character Card V2 shape', () => {
    const codec = new CharacterCardCodec();
    const parsed = codec.parseJsonString(
      JSON.stringify({
        name: 'Legacy Alice',
        description: 'desc',
        first_mes: 'hi',
        tags: 'one,two',
      }),
    );

    expect(parsed.spec).toBe('chara_card_v2');
    expect(parsed.data.name).toBe('Legacy Alice');
    expect(parsed.data.tags).toEqual(['one', 'two']);
  });

  it('rejects invalid JSON card input', () => {
    const codec = new CharacterCardCodec();
    expect(() => codec.parseJsonString('{not json')).toThrow(/invalid/i);
  });
});

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

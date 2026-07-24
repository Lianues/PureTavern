import {
  cloneJson,
  normalizeCharacterCard,
  type CharacterCard,
  type JsonObject,
} from '../domain/character-card';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

interface PngChunk {
  type: string;
  data: Uint8Array;
}

export class CharacterCardCodecError extends Error {}

export class CharacterCardCodec {
  parseJsonBytes(bytes: Uint8Array): CharacterCard {
    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(bytes));
    } catch (error) {
      throw new CharacterCardCodecError(
        `Character JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return normalizeImportedCard(parsed);
  }

  parseJsonString(json: string): CharacterCard {
    return this.parseJsonBytes(textEncoder.encode(json));
  }

  readPngCard(bytes: Uint8Array): CharacterCard {
    const chunks = parsePngChunks(bytes);
    const textChunks = chunks
      .filter((chunk) => chunk.type === 'tEXt')
      .map((chunk) => decodeTextChunk(chunk.data));

    if (textChunks.length === 0) throw new CharacterCardCodecError('PNG metadata is missing.');

    const ccv3 = textChunks.find((chunk) => chunk.keyword.toLowerCase() === 'ccv3');
    const chara = textChunks.find((chunk) => chunk.keyword.toLowerCase() === 'chara');
    const selected = ccv3 ?? chara;
    if (!selected)
      throw new CharacterCardCodecError('PNG metadata does not contain character data.');

    let json: string;
    try {
      json = utf8BytesToString(base64ToBytes(selected.text));
    } catch (error) {
      throw new CharacterCardCodecError(
        `PNG character metadata is not valid Base64: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.parseJsonString(json);
  }

  writePngCard(imageBytes: Uint8Array, card: CharacterCard): Uint8Array {
    const chunks = parsePngChunks(imageBytes);
    const filtered = chunks.filter((chunk) => {
      if (chunk.type !== 'tEXt') return true;
      const keyword = safeDecodeTextKeyword(chunk.data).toLowerCase();
      return keyword !== 'chara' && keyword !== 'ccv3';
    });

    const iendIndex = filtered.findIndex((chunk) => chunk.type === 'IEND');
    if (iendIndex < 0) throw new CharacterCardCodecError('PNG is missing IEND chunk.');

    const v2Card = cloneJson(card);
    if (v2Card.spec === 'chara_card_v3') {
      v2Card.spec = 'chara_card_v2';
      v2Card.spec_version = '2.0';
    }
    const v2Json = JSON.stringify(v2Card);
    const v3Card = cloneJson(v2Card as JsonObject);
    v3Card.spec = 'chara_card_v3';
    v3Card.spec_version = '3.0';
    const v3Json = JSON.stringify(v3Card);

    filtered.splice(
      iendIndex,
      0,
      encodeTextChunk('chara', stringToBase64(v2Json)),
      encodeTextChunk('ccv3', stringToBase64(v3Json)),
    );

    return encodePngChunks(filtered);
  }

  exportJson(card: CharacterCard, pretty = true): string {
    return JSON.stringify(card, null, pretty ? 4 : 0);
  }
}

function normalizeImportedCard(value: unknown): CharacterCard {
  const card = normalizeCharacterCard(value, { hoistDate: true });
  if (card.data?.name) card.name = card.data.name;
  return card;
}

function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  if (bytes.length < PNG_SIGNATURE.length + 12) {
    throw new CharacterCardCodecError('PNG is too small.');
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index])
      throw new CharacterCardCodecError('File is not a PNG image.');
  }

  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length)
      throw new CharacterCardCodecError('PNG chunk header is truncated.');
    const length = readUint32(bytes, offset);
    const type = asciiBytesToString(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (length < 0 || crcEnd > bytes.length)
      throw new CharacterCardCodecError('PNG chunk exceeds file bounds.');
    chunks.push({ type, data: bytes.slice(dataStart, dataEnd) });
    offset = crcEnd;
    if (type === 'IEND') break;
  }

  if (!chunks.some((chunk) => chunk.type === 'IEND'))
    throw new CharacterCardCodecError('PNG is missing IEND chunk.');
  return chunks;
}

function encodePngChunks(chunks: PngChunk[]): Uint8Array {
  const size =
    PNG_SIGNATURE.length + chunks.reduce((total, chunk) => total + 12 + chunk.data.length, 0);
  const output = new Uint8Array(size);
  output.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  for (const chunk of chunks) {
    writeUint32(output, offset, chunk.data.length);
    const typeBytes = asciiStringToBytes(chunk.type);
    output.set(typeBytes, offset + 4);
    output.set(chunk.data, offset + 8);
    const crcInput = new Uint8Array(typeBytes.length + chunk.data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(chunk.data, typeBytes.length);
    writeUint32(output, offset + 8 + chunk.data.length, crc32(crcInput));
    offset += 12 + chunk.data.length;
  }
  return output;
}

function decodeTextChunk(data: Uint8Array): { keyword: string; text: string } {
  const separator = data.indexOf(0);
  if (separator <= 0) throw new CharacterCardCodecError('PNG text chunk is malformed.');
  return {
    keyword: latin1BytesToString(data.subarray(0, separator)),
    text: latin1BytesToString(data.subarray(separator + 1)),
  };
}

function safeDecodeTextKeyword(data: Uint8Array): string {
  try {
    return decodeTextChunk(data).keyword;
  } catch {
    return '';
  }
}

function encodeTextChunk(keyword: string, text: string): PngChunk {
  const keywordBytes = latin1StringToBytes(keyword);
  const textBytes = latin1StringToBytes(text);
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  data.set(keywordBytes, 0);
  data[keywordBytes.length] = 0;
  data.set(textBytes, keywordBytes.length + 1);
  return { type: 'tEXt', data };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function asciiBytesToString(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function asciiStringToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1)
    bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

function latin1BytesToString(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

function latin1StringToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1)
    bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

function stringToBase64(value: string): string {
  const bytes = textEncoder.encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function utf8BytesToString(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

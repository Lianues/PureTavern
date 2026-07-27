import type { AvatarCropData } from '../features/standard-capabilities';

/** Mirrors upstream tryParse(): malformed or incomplete crop data is treated as no crop. */
export function parseAvatarCrop(value: string | null): AvatarCropData | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const crop = parsed as Record<string, unknown>;
  if (
    typeof crop.x !== 'number' ||
    typeof crop.y !== 'number' ||
    typeof crop.width !== 'number' ||
    typeof crop.height !== 'number'
  ) {
    return undefined;
  }
  return {
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
    ...(typeof crop.want_resize === 'boolean' ? { want_resize: crop.want_resize } : {}),
  };
}

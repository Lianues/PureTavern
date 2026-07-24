import type { TrustedLegacyBuiltInDefinition } from './domain/extension';

/** Audited from each manifest.json under the upstream public extensions directory. */
export const TRUSTED_LEGACY_BUILTINS = Object.freeze([
  builtIn('assets', 'Assets', '0.1.0', 'Keij#6799'),
  builtIn('attachments', 'Data Bank (Chat Attachments)', '1.0.0', 'Cohee1207'),
  builtIn('caption', 'Image Captioning', '1.0.0', 'Cohee#1207'),
  builtIn('connection-manager', 'Connection Profiles', '1.0.0', 'Cohee1207'),
  builtIn('expressions', 'Character Expressions', '1.0.0', 'Cohee#1207'),
  builtIn('gallery', 'Gallery', '1.5.0', 'City-Unit'),
  builtIn('memory', 'Summarize', '1.0.0', 'Cohee#1207'),
  builtIn('quick-reply', 'Quick Replies', '2.0.0', 'RossAscends#1779'),
  builtIn('regex', 'Regex', '1.0.0', 'kingbri'),
  builtIn('stable-diffusion', 'Image Generation', '1.0.0', 'Cohee#1207'),
  builtIn('token-counter', 'Token Counter', '1.0.0', 'Cohee#1207'),
  builtIn('translate', 'Chat Translation', '1.0.0', 'Cohee#1207'),
  builtIn('tts', 'TTS', '1.0.0', 'Ouoertheo#7264'),
  builtIn('vectors', 'Vector Storage', '1.0.0', 'Cohee#1207'),
] satisfies readonly TrustedLegacyBuiltInDefinition[]);

function builtIn(
  legacyName: string,
  displayName: string,
  version: string,
  author: string,
): TrustedLegacyBuiltInDefinition {
  return {
    extensionId: `legacy.builtin.${legacyName}`,
    legacyName,
    displayName,
    version,
    author,
    scriptPath: `/scripts/extensions/${legacyName}/index.js`,
  };
}

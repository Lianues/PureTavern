import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = mobileRoot.replace(/[\\/]apps[\\/]mobile$/u, '');
const requireFromWeb = createRequire(path.join(projectRoot, 'apps/web/package.json'));
const mimeTypes = requireFromWeb('mime').types;
const outputPath = path.join(mobileRoot, 'ios/App/App/PureTavernExtensionMimeTypes.json');
const normalized = Object.fromEntries(
  Object.entries(mimeTypes).sort(([left], [right]) => left.localeCompare(right, 'en')),
);
const output = `${JSON.stringify(normalized, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8');
  if (existing !== output) {
    throw new Error('The iOS extension MIME map is stale. Run the generate:ios-mime script.');
  }
  console.log(
    `PureTavern iOS extension MIME map verified (${Object.keys(normalized).length} types).`,
  );
} else {
  await writeFile(outputPath, output, 'utf8');
  console.log(`Wrote ${Object.keys(normalized).length} iOS extension MIME mappings.`);
}

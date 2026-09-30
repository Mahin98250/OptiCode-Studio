import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const requiredFiles = [
  'index.html',
  'manifest.json',
  'manifest.webmanifest',
  'sw.js',
  'icon-192.svg',
  'icon-512.svg',
  'favicon.svg',
  'zxing_reader.wasm',
];

for (const file of requiredFiles) {
  if (!existsSync(join(dist, file))) {
    throw new Error(`Offline build check failed: dist/${file} is missing.`);
  }
}

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const entries = Object.values(manifest);

if (entries.length === 0) {
  throw new Error('Offline build check failed: Vite build manifest is empty.');
}

const emitted = new Set();

for (const entry of entries) {
  if (!entry || typeof entry !== 'object') continue;

  for (const field of ['file', 'css', 'assets']) {
    const values = Array.isArray(entry[field]) ? entry[field] : [entry[field]];

    for (const value of values) {
      if (typeof value === 'string' && value) emitted.add(value.replace(/^\//, ''));
    }
  }
}

if (emitted.size === 0) {
  throw new Error('Offline build check failed: no generated assets were listed.');
}

const missingAssets = [...emitted].filter((file) => !existsSync(join(dist, file)));
if (missingAssets.length > 0) {
  throw new Error(
    `Offline build check failed: ${missingAssets.length} generated assets are missing.\n` +
      missingAssets.slice(0, 20).map((file) => `- ${file}`).join('\n')
  );
}

console.log(
  `Offline build check passed: ${emitted.size} generated assets + app shell are present.`
);

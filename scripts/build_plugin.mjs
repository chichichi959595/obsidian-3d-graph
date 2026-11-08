// Builds the page, embeds it in the plugin bundle, and writes dist/plugin.
// Usage: node scripts/build_plugin.mjs [--install <path to vault>]
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { build as buildPage } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'dist/web');
const outDir = join(root, 'dist/plugin');
const pkg = JSON.parse(await readFile(join(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'));
const wasmBase = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${pkg.version}/wasm`;
const modelUrl = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

await buildPage({ root, logLevel: 'warn', publicDir: false, build: { outDir: webDir, emptyOutDir: true, assetsInlineLimit: 1_000_000, chunkSizeWarningLimit: 4000 } });

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

async function webAssets() {
  const assets = {};
  for (const file of await walk(webDir)) {
    const type = TYPES[extname(file)];
    if (!type) throw new Error(`No content type for ${file}`);
    assets[relative(webDir, file).split(sep).join('/')] = { type, data: (await readFile(file)).toString('base64') };
  }
  return assets;
}

async function handEntry(path, url, local) {
  const bytes = await readFile(local);
  return { path, url, size: (await stat(local)).size, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const handFiles = await Promise.all([
  ...['vision_wasm_internal.js', 'vision_wasm_internal.wasm'].map((name) =>
    handEntry(`mediapipe/wasm/${name}`, `${wasmBase}/${name}`, join(root, 'node_modules/@mediapipe/tasks-vision/wasm', name)),
  ),
  handEntry('models/hand_landmarker.task', modelUrl, join(root, 'public/models/hand_landmarker.task')),
]);
const modules = { 'virtual:web-assets': `export const WEB_ASSETS = ${JSON.stringify(await webAssets())};`, 'virtual:hand-manifest': `export const HAND_FILES = ${JSON.stringify(handFiles)};` };

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await bundle({
  entryPoints: [join(root, 'obsidian-plugin/src/main.ts')],
  outfile: join(outDir, 'main.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  external: ['obsidian', 'electron'],
  logLevel: 'warning',
  define: { 'import.meta.url': '__filename' },
  plugins: [{
    name: 'virtual',
    setup(b) {
      b.onResolve({ filter: /^virtual:/ }, (args) => ({ path: args.path, namespace: 'virtual' }));
      b.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => ({ contents: modules[args.path], loader: 'js' }));
    },
  }],
});
await copyFile(join(root, 'manifest.json'), join(outDir, 'manifest.json'));
const size = (await stat(join(outDir, 'main.js'))).size;
console.log(`dist/plugin/main.js ${(size / 1e6).toFixed(2)} MB`);

const installAt = process.argv.indexOf('--install');
if (installAt > 0) {
  const { id } = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const target = join(process.argv[installAt + 1], '.obsidian/plugins', id);
  await mkdir(target, { recursive: true });
  await copyFile(join(outDir, 'main.js'), join(target, 'main.js'));
  await copyFile(join(outDir, 'manifest.json'), join(target, 'manifest.json'));
  console.log(`installed to ${target}`);
}

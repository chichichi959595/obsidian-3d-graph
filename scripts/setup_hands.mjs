// Puts the hand-tracking runtime and model under public/ so tracking runs fully offline.
// Safe to run repeatedly; finished files are left alone.
import { cp, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSource = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmTarget = join(root, 'public/mediapipe/wasm');
const modelPath = join(root, 'public/models/hand_landmarker.task');
const modelUrl =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

await mkdir(wasmTarget, { recursive: true });
await cp(wasmSource, wasmTarget, { recursive: true });

const present = await stat(modelPath).then((s) => s.size > 1_000_000, () => false);
if (!present) {
  console.log('Downloading the hand model (about 8 MB)...');
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error(`Hand model download failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length < 1_000_000) throw new Error(`Hand model looks truncated: ${data.length} bytes`);
  await mkdir(dirname(modelPath), { recursive: true });
  await writeFile(`${modelPath}.part`, data);
  await rename(`${modelPath}.part`, modelPath);
}

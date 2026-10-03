// Downloads both runtimes + every pose model into ./vendor so the app can run
// with no network at all. After it finishes, set USE_VENDORED = true in
// js/config.js.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MP_VERSION = '1.0.1';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_HOST = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
const HAND_HOST = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker';
const ORT_VERSION = '1.20.1';
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist`;
const yoloHost = (size) => `https://huggingface.co/Xenova/yolov8${size}-pose/resolve/main/onnx`;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VENDOR = resolve(ROOT, 'vendor');

const FILES = [
  [`${CDN}/vision_bundle.mjs`, 'vision_bundle.mjs'],
  [`${CDN}/wasm/vision_wasm_internal.js`, 'wasm/vision_wasm_internal.js'],
  [`${CDN}/wasm/vision_wasm_internal.wasm`, 'wasm/vision_wasm_internal.wasm'],
  [`${CDN}/wasm/vision_wasm_nosimd_internal.js`, 'wasm/vision_wasm_nosimd_internal.js'],
  [`${CDN}/wasm/vision_wasm_nosimd_internal.wasm`, 'wasm/vision_wasm_nosimd_internal.wasm'],
  [`${MODEL_HOST}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`, 'pose_landmarker_lite.task'],
  [`${MODEL_HOST}/pose_landmarker_full/float16/1/pose_landmarker_full.task`, 'pose_landmarker_full.task'],
  [`${MODEL_HOST}/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`, 'pose_landmarker_heavy.task'],
  [`${HAND_HOST}/hand_landmarker/float16/1/hand_landmarker.task`, 'hand_landmarker.task'],
  // The YOLO backend: ONNX Runtime Web, and the weights. `ORT_WASM_DIR` points
  // at vendor/ort/, which is where the runtime looks for its own .wasm.
  [`${ORT_CDN}/ort.webgpu.bundle.min.mjs`, 'ort.webgpu.bundle.min.mjs'],
  [`${ORT_CDN}/ort-wasm-simd-threaded.jsep.wasm`, 'ort/ort-wasm-simd-threaded.jsep.wasm'],
  [`${yoloHost('s')}/model.onnx`, 'yolov8s-pose.onnx'],
  [`${yoloHost('m')}/model.onnx`, 'yolov8m-pose.onnx'],
];

for (const [url, target] of FILES) {
  const dest = resolve(VENDOR, target);
  await mkdir(resolve(dest, '..'), { recursive: true });
  process.stdout.write(`  ${target} … `);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`FAILED (${res.status})`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
}

console.log('\nDone. Now set USE_VENDORED = true in js/config.js.');

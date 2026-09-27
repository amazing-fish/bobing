// 把运行时依赖从 node_modules 复制到 vendor/，让 GitHub Pages 无需构建、也不依赖外部 CDN
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'vendor');

const files = [
  ['three/build/three.module.js', 'three/three.module.js'],
  ['three/build/three.core.js', 'three/three.core.js'],
  ['three/examples/jsm/geometries/RoundedBoxGeometry.js', 'three/addons/geometries/RoundedBoxGeometry.js'],
  ['three/examples/jsm/controls/OrbitControls.js', 'three/addons/controls/OrbitControls.js'],
  ['three/examples/jsm/environments/RoomEnvironment.js', 'three/addons/environments/RoomEnvironment.js'],
  ['three/LICENSE', 'three/LICENSE'],
  ['@dimforge/rapier3d-compat/dist/rapier.mjs', 'rapier/rapier.mjs'],
  ['@dimforge/rapier3d-compat/LICENSE', 'rapier/LICENSE'],
];

for (const [from, to] of files) {
  const src = join(nm, from);
  const dst = join(out, to);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  console.log('vendor:', to);
}

#!/usr/bin/env bash
# Rebuilds games/shared/vendor/three-addons.min.js: the Three.js add-ons
# (GLTFLoader, SkeletonUtils) as a plain script that uses the global THREE from
# three.min.js. Only needed when upgrading Three.js or adding another add-on.
# Usage (from the games folder): bash tools/build-three-addons.sh
set -euo pipefail
WORK="$(mktemp -d)"
cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund three@0.160.0 esbuild@0.24.0 >/dev/null
mkdir addons
echo 'module.exports = window.THREE;' > addons/three-global.cjs
cat > addons/entry.js <<'JS'
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from '../node_modules/three/examples/jsm/utils/SkeletonUtils.js';
window.THREE.GLTFLoader = GLTFLoader;
window.THREE.SkeletonUtils = SkeletonUtils;
JS
npx esbuild addons/entry.js --bundle --format=iife --minify --alias:three=./addons/three-global.cjs --outfile=out.js
cd - >/dev/null
{ printf '/* Three.js r160 add-ons (GLTFLoader, SkeletonUtils), MIT licence, https://threejs.org\n   Bundled into a plain script by tools/build-three-addons.sh so they work with three.min.js.\n   Adds THREE.GLTFLoader and THREE.SkeletonUtils. Load AFTER three.min.js. */\n'; cat "$WORK/out.js"; } > shared/vendor/three-addons.min.js
echo "Wrote shared/vendor/three-addons.min.js"

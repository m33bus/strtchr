import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/loaders/GLTFLoader.js';

const CONFIG = {
  fov: 30,
  near: 0.01,
  far: 100,
  baseExposure: 1.04,

  floatAmp: 0.018,
  floatSpeed: 0.72,
  tiltXAmp: 0.026,
  tiltXSpeed: 0.58,
  tiltYAmp: 0.014,
  tiltYSpeed: 0.44,

  influenceRadius: 0.09,
  pullScale: 0.15,
  normalBias: 0.38,
  spring: 38.0,
  damping: 9.8,
  forceGain: 13.0,
  maxOffset: 0.11,

  bodyYawMax: 0.055,
  bodyPitchMax: 0.048,
  bodyReturn: 5.3,

  audioRateMin: 0.84,
  audioRateMax: 1.16,
  audioGainMin: 0.14,
  audioGainMax: 0.42,
  audioAttackMin: 0.003,
  audioAttackMax: 0.016,
  audioReleaseMin: 0.04,
  audioReleaseMax: 0.11,
  audioTrimMin: 0.05,
  audioTrimMax: 0.16,
  audioStartRatioMax: 0.72,
  minAudioIntervalMs: 46,
};

const sceneWrap = document.getElementById('scene-wrap');
const loadingEl = document.getElementById('loading');

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  CONFIG.fov,
  window.innerWidth / window.innerHeight,
  CONFIG.near,
  CONFIG.far
);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CONFIG.baseExposure;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
sceneWrap.appendChild(renderer.domElement);

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const root = new THREE.Group();
scene.add(root);

let headGroup = null;
let headMesh = null;
let geometry = null;
let positionAttr = null;
let vertexCount = 0;

let restPositions = null;
let workingPositions = null;
let offsets = null;
let velocities = null;
let spatialIndex = null;
let boundsCenter = new THREE.Vector3();
let boundingSize = new THREE.Vector3();

let loaded = false;
const activePointers = new Map();
const targetBody = new THREE.Vector2(0, 0);
const currentBody = new THREE.Vector2(0, 0);

let audioContext = null;
let decodedBuffers = [];
let audioTriedLoading = false;
let lastAudioTime = 0;

const audioFiles = [
  './assets/audio/sound1.wav',
  './assets/audio/sound2.wav',
  './assets/audio/sound3.wav',
  './assets/audio/sound4.wav'
];

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function setLoading(text) {
  loadingEl.textContent = text;
}

function hideLoading() {
  loadingEl.classList.add('hidden');
  setTimeout(() => {
    if (loadingEl.parentNode) loadingEl.remove();
  }, 250);
}

function unlockAudio() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioContext = new Ctx();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }

  if (!audioTriedLoading) {
    audioTriedLoading = true;
    loadAudioSoft();
  }
}

async function loadAudioSoft() {
  if (!audioContext) return;
  const loadedBuffers = [];

  for (const url of audioFiles) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const arr = await res.arrayBuffer();
      const buffer = await audioContext.decodeAudioData(arr.slice(0));
      loadedBuffers.push(buffer);
    } catch (_) {}
  }

  decodedBuffers = loadedBuffers;
}

function playScrubSound(energy = 0.5) {
  const now = performance.now();
  if (now - lastAudioTime < CONFIG.minAudioIntervalMs) return;
  lastAudioTime = now;

  if (!audioContext || !decodedBuffers.length) return;

  const buffer = decodedBuffers[(Math.random() * decodedBuffers.length) | 0];
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rand(CONFIG.audioRateMin, CONFIG.audioRateMax) * (0.95 + energy * 0.2);

  const gainNode = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = rand(1800, 4200);

  const attack = rand(CONFIG.audioAttackMin, CONFIG.audioAttackMax);
  const release = rand(CONFIG.audioReleaseMin, CONFIG.audioReleaseMax);
  const duration = rand(CONFIG.audioTrimMin, CONFIG.audioTrimMax) * (0.9 + energy * 0.35);
  const maxStart = Math.max(0.001, buffer.duration * CONFIG.audioStartRatioMax - duration);
  const startAt = rand(0, maxStart);
  const g = clamp(rand(CONFIG.audioGainMin, CONFIG.audioGainMax) * (0.8 + energy * 0.6), 0.04, 0.8);

  const t0 = audioContext.currentTime + 0.001;
  const t1 = t0 + attack;
  const t2 = t0 + duration;
  const t3 = t2 + release;

  gainNode.gain.setValueAtTime(0.0001, t0);
  gainNode.gain.linearRampToValueAtTime(g, t1);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t3);

  source.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(audioContext.destination);

  source.start(t0, startAt, duration + release);
  source.stop(t3 + 0.01);
}

function setupLights() {
  scene.add(new THREE.HemisphereLight(0xeef4ff, 0x1c2440, 1.18));

  const key = new THREE.DirectionalLight(0xffffff, 1.55);
  key.position.set(1.4, 2.1, 3.2);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xcdddff, 0.62);
  fill.position.set(-2.6, 0.55, 1.5);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xe2ebff, 0.72);
  rim.position.set(0.45, 1.4, -3.4);
  scene.add(rim);

  const front = new THREE.PointLight(0xffffff, 0.56, 10, 1.8);
  front.position.set(0, 0.15, 2.3);
  scene.add(front);
}

async function loadModel() {
  const loader = new GLTFLoader();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Model load timed out.')), 20000);

    loader.load(
      './assets/head.glb',
      (gltf) => {
        clearTimeout(timeout);
        resolve(gltf);
      },
      undefined,
      (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    );
  });
}

function getPrimaryMesh(sceneRoot) {
  const meshes = [];
  sceneRoot.traverse((obj) => {
    if (obj.isMesh && obj.geometry?.attributes?.position) meshes.push(obj);
  });

  if (!meshes.length) {
    throw new Error('No mesh found in head.glb');
  }

  meshes.sort((a, b) => {
    const ac = a.geometry.attributes.position.count || 0;
    const bc = b.geometry.attributes.position.count || 0;
    return bc - ac;
  });

  return meshes[0];
}

function buildMaterialFromMesh(mesh) {
  const geo = mesh.geometry;
  const hasVertexColor = !!geo.getAttribute('color');
  const source = mesh.material;

  const material = new THREE.MeshPhysicalMaterial({
    color: source?.color ? source.color.clone() : new THREE.Color(0xf1e7de),
    map: source?.map || null,
    vertexColors: hasVertexColor,
    roughness: source?.roughness ?? 0.7,
    metalness: 0.0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.58,
    sheen: 0.12,
    sheenRoughness: 0.92,
    envMapIntensity: 0.55,
    transparent: source?.transparent || false,
    opacity: source?.opacity ?? 1
  });

  if (source?.normalMap) material.normalMap = source.normalMap;
  if (source?.roughnessMap) material.roughnessMap = source.roughnessMap;
  if (source?.aoMap) material.aoMap = source.aoMap;

  return material;
}

function buildSpatialIndex(positionArray, cellSize) {
  const cells = new Map();

  for (let i = 0; i < positionArray.length; i += 3) {
    const x = Math.floor(positionArray[i] / cellSize);
    const y = Math.floor(positionArray[i + 1] / cellSize);
    const z = Math.floor(positionArray[i + 2] / cellSize);
    const key = `${x}|${y}|${z}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i / 3);
  }

  return { cells, cellSize };
}

function nearbyIndices(localPoint, radius) {
  if (!spatialIndex) return [];

  const { cells, cellSize } = spatialIndex;
  const cx = Math.floor(localPoint.x / cellSize);
  const cy = Math.floor(localPoint.y / cellSize);
  const cz = Math.floor(localPoint.z / cellSize);
  const results = [];
  const r2 = radius * radius;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = cells.get(`${cx + dx}|${cy + dy}|${cz + dz}`);
        if (!list) continue;

        for (const idx of list) {
          const i3 = idx * 3;
          const px = restPositions[i3];
          const py = restPositions[i3 + 1];
          const pz = restPositions[i3 + 2];
          const ddx = px - localPoint.x;
          const ddy = py - localPoint.y;
          const ddz = pz - localPoint.z;
          if ((ddx * ddx + ddy * ddy + ddz * ddz) <= r2) {
            results.push(idx);
          }
        }
      }
    }
  }

  return results;
}

function prepareHead(gltf) {
  const mesh = getPrimaryMesh(gltf.scene);

  geometry = mesh.geometry.clone();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const box = geometry.boundingBox.clone();
  box.getCenter(boundsCenter);
  box.getSize(boundingSize);

  geometry.translate(-boundsCenter.x, -boundsCenter.y, -boundsCenter.z);

  positionAttr = geometry.getAttribute('position');
  vertexCount = positionAttr.count;

  restPositions = new Float32Array(positionAttr.array);
  workingPositions = new Float32Array(positionAttr.array);
  offsets = new Float32Array(vertexCount * 3);
  velocities = new Float32Array(vertexCount * 3);

  spatialIndex = buildSpatialIndex(restPositions, CONFIG.influenceRadius * 1.6);

  const material = buildMaterialFromMesh(mesh);

  headMesh = new THREE.Mesh(geometry, material);
  headMesh.frustumCulled = false;

  headGroup = new THREE.Group();
  headGroup.add(headMesh);
  root.add(headGroup);

  frameCameraToHead();
}

function frameCameraToHead() {
  const maxDim = Math.max(boundingSize.x, boundingSize.y, boundingSize.z);
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const fitDist = (maxDim * 0.78) / Math.tan(fovRad * 0.5);

  camera.position.set(0, 0.02, Math.max(2.4, fitDist + 1.15));
  camera.lookAt(0, 0.02, 0);

  const mobile = window.innerWidth < 820;
  const scale = mobile ? 1.0 : 1.08;
  headGroup.scale.setScalar(scale);
  headGroup.position.set(0, -boundingSize.y * 0.04, 0);
}

function ndcFromClient(x, y) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((x - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((y - rect.top) / rect.height) * 2 + 1;
  return pointerNDC;
}

function hitHead(clientX, clientY) {
  if (!headMesh) return null;
  raycaster.setFromCamera(ndcFromClient(clientX, clientY), camera);
  const hits = raycaster.intersectObject(headMesh, false);
  return hits[0] || null;
}

function onPointerDown(e) {
  unlockAudio();

  if (!loaded || !headMesh) return;

  if (renderer.domElement.setPointerCapture) {
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
  }

  const hit = hitHead(e.clientX, e.clientY);
  if (!hit) return;

  const localPoint = headMesh.worldToLocal(hit.point.clone());
  const worldNormal = hit.face?.normal
    ? hit.face.normal.clone().transformDirection(headMesh.matrixWorld).normalize()
    : new THREE.Vector3(0, 0, 1);

  const n2 = hit.point.clone().add(worldNormal);
  const n2Local = headMesh.worldToLocal(n2);
  const localNormal = n2Local.sub(localPoint).normalize();

  activePointers.set(e.pointerId, {
    startX: e.clientX,
    startY: e.clientY,
    x: e.clientX,
    y: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    moveEnergy: 0,
    localGrab: localPoint.clone(),
    localNormal: localNormal.clone(),
    affected: nearbyIndices(localPoint, CONFIG.influenceRadius)
  });
}

function onPointerMove(e) {
  const p = activePointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;

  const dx = p.x - p.lastX;
  const dy = p.y - p.lastY;
  p.moveEnergy = Math.min(1, Math.hypot(dx, dy) / 18);

  p.lastX = p.x;
  p.lastY = p.y;
}

function onPointerUp(e) {
  activePointers.delete(e.pointerId);
}

function applyPointerForces(dt) {
  if (!activePointers.size) {
    targetBody.set(0, 0);
    return;
  }

  let avgX = 0;
  let avgY = 0;
  let count = 0;

  for (const p of activePointers.values()) {
    const dxScreen = p.x - p.startX;
    const dyScreen = p.y - p.startY;
    avgX += dxScreen;
    avgY += dyScreen;
    count++;

    const dragScale = 1 / Math.min(window.innerWidth, window.innerHeight);
    const screenDist = Math.hypot(dxScreen, dyScreen);
    const pullAmount = clamp(screenDist * dragScale * CONFIG.pullScale * 2.6, 0, CONFIG.maxOffset);

    const direction = new THREE.Vector3(dxScreen * 0.00185, -dyScreen * 0.00185, 0);
    direction.addScaledVector(p.localNormal, pullAmount * CONFIG.normalBias * 6.2);
    if (direction.lengthSq() < 1e-7) direction.copy(p.localNormal);
    direction.normalize().multiplyScalar(pullAmount);

    for (const idx of p.affected) {
      const i3 = idx * 3;
      const px = restPositions[i3];
      const py = restPositions[i3 + 1];
      const pz = restPositions[i3 + 2];

      const ddx = px - p.localGrab.x;
      const ddy = py - p.localGrab.y;
      const ddz = pz - p.localGrab.z;
      const d = Math.hypot(ddx, ddy, ddz);

      const w = 1.0 - smoothstep(0, CONFIG.influenceRadius, d);
      const softness = w * w * (3 - 2 * w);

      velocities[i3] += direction.x * softness * CONFIG.forceGain * dt;
      velocities[i3 + 1] += direction.y * softness * CONFIG.forceGain * dt;
      velocities[i3 + 2] += direction.z * softness * CONFIG.forceGain * dt;
    }

    if (p.moveEnergy > 0.07) {
      playScrubSound(p.moveEnergy);
    }
  }

  targetBody.x = clamp((avgY / count) / window.innerHeight, -1, 1) * CONFIG.bodyPitchMax;
  targetBody.y = clamp((avgX / count) / window.innerWidth, -1, 1) * CONFIG.bodyYawMax;
}

function simulate(dt) {
  if (!positionAttr) return;

  const spring = CONFIG.spring;
  const damping = CONFIG.damping;
  const maxOffset = CONFIG.maxOffset * 1.06;

  for (let i = 0; i < vertexCount; i++) {
    const i3 = i * 3;

    const ox = offsets[i3];
    const oy = offsets[i3 + 1];
    const oz = offsets[i3 + 2];

    const vx = velocities[i3];
    const vy = velocities[i3 + 1];
    const vz = velocities[i3 + 2];

    const ax = (-spring * ox) - (damping * vx);
    const ay = (-spring * oy) - (damping * vy);
    const az = (-spring * oz) - (damping * vz);

    velocities[i3] = vx + ax * dt;
    velocities[i3 + 1] = vy + ay * dt;
    velocities[i3 + 2] = vz + az * dt;

    offsets[i3] += velocities[i3] * dt;
    offsets[i3 + 1] += velocities[i3 + 1] * dt;
    offsets[i3 + 2] += velocities[i3 + 2] * dt;

    const mag = Math.hypot(offsets[i3], offsets[i3 + 1], offsets[i3 + 2]);
    if (mag > maxOffset) {
      const s = maxOffset / mag;
      offsets[i3] *= s;
      offsets[i3 + 1] *= s;
      offsets[i3 + 2] *= s;
    }

    workingPositions[i3] = restPositions[i3] + offsets[i3];
    workingPositions[i3 + 1] = restPositions[i3 + 1] + offsets[i3 + 1];
    workingPositions[i3 + 2] = restPositions[i3 + 2] + offsets[i3 + 2];
  }

  positionAttr.array.set(workingPositions);
  positionAttr.needsUpdate = true;
  geometry.computeVertexNormals();
}

function updateIdle(t, dt) {
  if (!headGroup) return;

  currentBody.x += (targetBody.x - currentBody.x) * Math.min(1, CONFIG.bodyReturn * dt);
  currentBody.y += (targetBody.y - currentBody.y) * Math.min(1, CONFIG.bodyReturn * dt);

  const floatY = Math.sin(t * CONFIG.floatSpeed) * CONFIG.floatAmp;
  const tiltX = Math.sin(t * CONFIG.tiltXSpeed + 1.2) * CONFIG.tiltXAmp;
  const tiltY = Math.cos(t * CONFIG.tiltYSpeed) * CONFIG.tiltYAmp;

  headGroup.position.y = -boundingSize.y * 0.04 + floatY;
  headGroup.rotation.x = tiltX + currentBody.x;
  headGroup.rotation.y = tiltY + currentBody.y;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.018, clock.getDelta() || 0.016);
  const t = performance.now() * 0.001;

  if (loaded) {
    applyPointerForces(dt);
    simulate(dt);
    updateIdle(t, dt);
  }

  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (loaded) frameCameraToHead();
}

async function bootstrap() {
  try {
    setupLights();
    setLoading('loading');
    const gltf = await loadModel();
    prepareHead(gltf);
    loaded = true;
    hideLoading();
  } catch (err) {
    console.error(err);
    setLoading('could not load head.glb');
  }
}

renderer.domElement.addEventListener('pointerdown', onPointerDown, { passive: true });
window.addEventListener('pointermove', onPointerMove, { passive: true });
window.addEventListener('pointerup', onPointerUp, { passive: true });
window.addEventListener('pointercancel', onPointerUp, { passive: true });
window.addEventListener('resize', onResize);

bootstrap();
animate();

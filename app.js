import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/loaders/GLTFLoader.js';

const CONFIG = {
  fov: 30,
  near: 0.01,
  far: 100,
  exposure: 1.04,

  idleFloatAmp: 0.018,
  idleFloatSpeed: 0.72,
  idleTiltXAmp: 0.026,
  idleTiltXSpeed: 0.58,
  idleTiltYAmp: 0.014,
  idleTiltYSpeed: 0.44,

  influenceRadiusFactor: 0.065,
  pullScale: 0.18,
  normalBias: 0.34,
  spring: 37.0,
  damping: 9.6,
  forceGain: 14.0,
  maxOffsetFactor: 0.08,

  bodyYawMax: 0.055,
  bodyPitchMax: 0.048,
  bodyReturn: 5.1,

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
renderer.toneMappingExposure = CONFIG.exposure;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
sceneWrap.appendChild(renderer.domElement);

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

const root = new THREE.Group();
scene.add(root);

let headGroup = new THREE.Group();
root.add(headGroup);

const deformStates = [];
const stateByMesh = new Map();
const activePointers = new Map();

let loaded = false;
let modelBounds = new THREE.Box3();
let modelSize = new THREE.Vector3();
let modelCenter = new THREE.Vector3();

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

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rand(min, max) { return min + Math.random() * (max - min); }
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
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

// ---------- audio ----------
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
  const out = [];
  for (const url of audioFiles) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const arr = await res.arrayBuffer();
      const buffer = await audioContext.decodeAudioData(arr.slice(0));
      out.push(buffer);
    } catch (_) {}
  }
  decodedBuffers = out;
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

// ---------- lights ----------
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

// ---------- model ----------
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
      (event) => {
        if (event.total) {
          const pct = Math.round((event.loaded / event.total) * 100);
          setLoading(`loading ${pct}%`);
        }
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    );
  });
}

function buildMaterial(source, geometry) {
  const hasVertexColor = !!geometry.getAttribute('color');
  const material = new THREE.MeshPhysicalMaterial({
    color: source?.color ? source.color.clone() : new THREE.Color(0xf1e7de),
    map: source?.map || null,
    vertexColors: hasVertexColor,
    roughness: source?.roughness ?? 0.72,
    metalness: 0.0,
    clearcoat: 0.1,
    clearcoatRoughness: 0.58,
    sheen: 0.1,
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

function nearbyIndices(state, localPoint, radius) {
  const { cells, cellSize } = state.spatialIndex;
  const cx = Math.floor(localPoint.x / cellSize);
  const cy = Math.floor(localPoint.y / cellSize);
  const cz = Math.floor(localPoint.z / cellSize);
  const results = [];
  const r2 = radius * radius;
  const rp = state.restPositions;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = cells.get(`${cx + dx}|${cy + dy}|${cz + dz}`);
        if (!list) continue;
        for (const idx of list) {
          const i3 = idx * 3;
          const ddx = rp[i3] - localPoint.x;
          const ddy = rp[i3 + 1] - localPoint.y;
          const ddz = rp[i3 + 2] - localPoint.z;
          if ((ddx * ddx + ddy * ddy + ddz * ddz) <= r2) results.push(idx);
        }
      }
    }
  }
  return results;
}

function addDeformMesh(sourceMesh) {
  let geo = sourceMesh.geometry.clone();
  if (geo.index) geo = geo.toNonIndexed();
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  geo.boundingBox.getCenter(center);
  geo.boundingBox.getSize(size);

  const positionAttr = geo.getAttribute('position');
  const count = positionAttr.count;
  const restPositions = new Float32Array(positionAttr.array);
  const workingPositions = new Float32Array(positionAttr.array);
  const offsets = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);

  const mesh = new THREE.Mesh(geo, buildMaterial(sourceMesh.material, geo));
  mesh.position.copy(sourceMesh.position);
  mesh.rotation.copy(sourceMesh.rotation);
  mesh.scale.copy(sourceMesh.scale);
  mesh.frustumCulled = false;

  const radius = Math.max(size.x, size.y, size.z) * CONFIG.influenceRadiusFactor;
  const maxOffset = Math.max(size.x, size.y, size.z) * CONFIG.maxOffsetFactor;

  const state = {
    mesh,
    geometry: geo,
    positionAttr,
    restPositions,
    workingPositions,
    offsets,
    velocities,
    vertexCount: count,
    localCenter: center,
    localSize: size,
    influenceRadius: radius,
    maxOffset,
    spatialIndex: buildSpatialIndex(restPositions, radius * 1.6)
  };

  stateByMesh.set(mesh, state);
  deformStates.push(state);
  headGroup.add(mesh);
}

function prepareHead(gltf) {
  while (headGroup.children.length) headGroup.remove(headGroup.children[0]);

  const sceneClone = gltf.scene.clone(true);
  const found = [];
  sceneClone.traverse((obj) => {
    if (obj.isMesh && obj.geometry?.attributes?.position) found.push(obj);
  });

  if (!found.length) {
    throw new Error('No mesh found in head.glb');
  }

  for (const mesh of found) addDeformMesh(mesh);

  modelBounds = new THREE.Box3().setFromObject(headGroup);
  modelBounds.getSize(modelSize);
  modelBounds.getCenter(modelCenter);

  headGroup.position.sub(modelCenter);
  frameCameraToHead();
}

function frameCameraToHead() {
  const maxDim = Math.max(modelSize.x, modelSize.y, modelSize.z);
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const fitDist = (maxDim * 0.78) / Math.tan(fovRad * 0.5);

  camera.position.set(0, 0.02, Math.max(2.4, fitDist + 1.1));
  camera.lookAt(0, 0.02, 0);

  const mobile = window.innerWidth < 820;
  const scale = mobile ? 1.0 : 1.08;
  headGroup.scale.setScalar(scale);
  headGroup.position.y -= modelSize.y * 0.04;
}

function ndcFromClient(x, y) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((x - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((y - rect.top) / rect.height) * 2 + 1;
  return pointerNDC;
}

function hitHead(x, y) {
  raycaster.setFromCamera(ndcFromClient(x, y), camera);
  const meshes = deformStates.map(s => s.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits[0] || null;
}

// ---------- interaction ----------
function onPointerDown(e) {
  unlockAudio();
  if (!loaded) return;

  const hit = hitHead(e.clientX, e.clientY);
  if (!hit) return;

  const state = stateByMesh.get(hit.object);
  if (!state) return;

  if (renderer.domElement.setPointerCapture) {
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
  }

  const localPoint = state.mesh.worldToLocal(hit.point.clone());
  const worldNormal = hit.face?.normal
    ? hit.face.normal.clone().transformDirection(state.mesh.matrixWorld).normalize()
    : new THREE.Vector3(0, 0, 1);

  const p2 = hit.point.clone().add(worldNormal);
  const p2Local = state.mesh.worldToLocal(p2);
  const localNormal = p2Local.sub(localPoint).normalize();

  activePointers.set(e.pointerId, {
    state,
    startX: e.clientX,
    startY: e.clientY,
    x: e.clientX,
    y: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    moveEnergy: 0,
    localGrab: localPoint,
    localNormal,
    affected: nearbyIndices(state, localPoint, state.influenceRadius)
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

    const screenScale = 1 / Math.min(window.innerWidth, window.innerHeight);
    const screenDist = Math.hypot(dxScreen, dyScreen);
    const pullAmount = clamp(screenDist * screenScale * p.state.maxOffset * CONFIG.pullScale * 10.0, 0, p.state.maxOffset);

    const direction = new THREE.Vector3(dxScreen * 0.00175, -dyScreen * 0.00175, 0);
    direction.addScaledVector(p.localNormal, pullAmount * CONFIG.normalBias * 7.0);
    if (direction.lengthSq() < 1e-7) direction.copy(p.localNormal);
    direction.normalize().multiplyScalar(pullAmount);

    const rp = p.state.restPositions;
    const vel = p.state.velocities;
    const radius = p.state.influenceRadius;

    for (const idx of p.affected) {
      const i3 = idx * 3;
      const ddx = rp[i3] - p.localGrab.x;
      const ddy = rp[i3 + 1] - p.localGrab.y;
      const ddz = rp[i3 + 2] - p.localGrab.z;
      const d = Math.hypot(ddx, ddy, ddz);
      const w = 1.0 - smoothstep(0, radius, d);
      const softness = w * w * (3 - 2 * w);

      vel[i3] += direction.x * softness * CONFIG.forceGain * dt;
      vel[i3 + 1] += direction.y * softness * CONFIG.forceGain * dt;
      vel[i3 + 2] += direction.z * softness * CONFIG.forceGain * dt;
    }

    if (p.moveEnergy > 0.07) playScrubSound(p.moveEnergy);
  }

  targetBody.x = clamp((avgY / count) / window.innerHeight, -1, 1) * CONFIG.bodyPitchMax;
  targetBody.y = clamp((avgX / count) / window.innerWidth, -1, 1) * CONFIG.bodyYawMax;
}

// ---------- simulation ----------
function simulate(dt) {
  for (const state of deformStates) {
    const spring = CONFIG.spring;
    const damping = CONFIG.damping;
    const { vertexCount, offsets, velocities, restPositions, workingPositions, positionAttr, geometry, maxOffset } = state;

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
}

function updateIdle(t, dt) {
  currentBody.x += (targetBody.x - currentBody.x) * Math.min(1, CONFIG.bodyReturn * dt);
  currentBody.y += (targetBody.y - currentBody.y) * Math.min(1, CONFIG.bodyReturn * dt);

  const floatY = Math.sin(t * CONFIG.idleFloatSpeed) * CONFIG.idleFloatAmp;
  const tiltX = Math.sin(t * CONFIG.idleTiltXSpeed + 1.2) * CONFIG.idleTiltXAmp;
  const tiltY = Math.cos(t * CONFIG.idleTiltYSpeed) * CONFIG.idleTiltYAmp;

  headGroup.position.y = -modelCenter.y - modelSize.y * 0.04 + floatY;
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
    setLoading(`could not load head.glb\n${err?.message || ''}`);
  }
}

renderer.domElement.addEventListener('pointerdown', onPointerDown, { passive: true });
window.addEventListener('pointermove', onPointerMove, { passive: true });
window.addEventListener('pointerup', onPointerUp, { passive: true });
window.addEventListener('pointercancel', onPointerUp, { passive: true });
window.addEventListener('resize', onResize);

bootstrap();
animate();

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const container = document.getElementById('app');
const loadingEl = document.getElementById('loading');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0, 0.08, 2.35);
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.rotateSpeed = 0.7;
controls.zoomSpeed = 0.9;
controls.minDistance = 1.0;
controls.maxDistance = 4.0;
controls.target.set(0, 0.05, 0);

const hemi = new THREE.HemisphereLight(0xffffff, 0x334466, 1.65);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(1.4, 1.7, 2.2);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xffffff, 0.75);
rimLight.position.set(-1.5, 0.5, -1.5);
scene.add(rimLight);

const fillLight = new THREE.PointLight(0xffffff, 0.55, 8);
fillLight.position.set(0, -0.25, 1.3);
scene.add(fillLight);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tempVec3 = new THREE.Vector3();
const tempVec3B = new THREE.Vector3();
const inverseMatrix = new THREE.Matrix4();

let modelRoot = null;
let sculptMesh = null;
let basePositions = null;
let restPositions = null;
let offsets = null;
let velocities = null;
let workingPositions = null;
let sculptRadius = 0.22;
let maxOffset = 0.14;
let spring = 34.0;
let damping = 8.5;

const activePointers = new Map();

const audioFiles = [
  './assets/audio/sound1.wav',
  './assets/audio/sound2.wav',
  './assets/audio/sound3.wav',
  './assets/audio/sound4.wav'
];
let audioContext = null;
let decodedBuffers = [];
let attemptedAudioLoad = false;
let lastAudioTime = 0;

function setLoading(text) {
  loadingEl.textContent = text;
}

function hideLoading() {
  loadingEl.classList.add('hidden');
  setTimeout(() => loadingEl.remove(), 220);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function ensureAudioContext() {
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

async function loadAudioSoft() {
  if (attemptedAudioLoad) return;
  attemptedAudioLoad = true;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const buffers = [];
  for (const url of audioFiles) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const arr = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr.slice(0));
      buffers.push(buf);
    } catch (_) {}
  }
  decodedBuffers = buffers;
}

function playRandomScrubSound(energy = 0.5) {
  const now = performance.now();
  if (now - lastAudioTime < 42) return;
  lastAudioTime = now;

  const ctx = ensureAudioContext();
  if (!ctx || !decodedBuffers.length) return;

  const buffer = decodedBuffers[(Math.random() * decodedBuffers.length) | 0];
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rand(0.84, 1.18) * (0.95 + energy * 0.22);

  const gainNode = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = rand(1700, 4200);

  const attack = rand(0.002, 0.015);
  const release = rand(0.04, 0.1);
  const duration = rand(0.05, 0.16) * (0.9 + energy * 0.4);
  const maxStart = Math.max(0.001, buffer.duration * 0.72 - duration);
  const startAt = rand(0, maxStart);
  const gain = clamp(rand(0.13, 0.42) * (0.8 + energy * 0.6), 0.04, 0.85);

  const t0 = ctx.currentTime + 0.001;
  const t1 = t0 + attack;
  const t2 = t0 + duration;
  const t3 = t2 + release;

  gainNode.gain.setValueAtTime(0.0001, t0);
  gainNode.gain.linearRampToValueAtTime(gain, t1);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t3);

  source.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(ctx.destination);

  source.start(t0, startAt, duration + release);
  source.stop(t3 + 0.01);
}

function updatePointerFromEvent(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function getMeshHit(event) {
  if (!sculptMesh) return null;
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(sculptMesh, false);
  return hits[0] || null;
}

const loader = new GLTFLoader();
loader.load(
  './assets/head.glb',
  (gltf) => {
    modelRoot = gltf.scene;
    scene.add(modelRoot);

    let largestMesh = null;
    let largestScore = -Infinity;

    modelRoot.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = false;
      child.receiveShadow = false;

      if (child.material) {
        child.material = child.material.clone();
        child.material.needsUpdate = true;
      }

      const geo = child.geometry;
      if (!geo?.attributes?.position) return;

      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const size = new THREE.Vector3();
      bb.getSize(size);
      const score = size.x * size.y * size.z;

      if (score > largestScore) {
        largestScore = score;
        largestMesh = child;
      }
    });

    if (!largestMesh) {
      setLoading('could not find editable mesh');
      return;
    }

    sculptMesh = largestMesh;

    if (sculptMesh.geometry.index) {
      sculptMesh.geometry = sculptMesh.geometry.toNonIndexed();
    } else {
      sculptMesh.geometry = sculptMesh.geometry.clone();
    }

    sculptMesh.geometry.computeVertexNormals();
    sculptMesh.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);

    basePositions = sculptMesh.geometry.attributes.position.array.slice();
    restPositions = sculptMesh.geometry.attributes.position.array.slice();
    workingPositions = sculptMesh.geometry.attributes.position.array.slice();
    offsets = new Float32Array(restPositions.length);
    velocities = new Float32Array(restPositions.length);

    frameModel();
    hideLoading();
  },
  (event) => {
    if (event.total) {
      const pct = Math.round((event.loaded / event.total) * 100);
      setLoading(`loading ${pct}%`);
    }
  },
  (err) => {
    console.error(err);
    setLoading('could not load head.glb');
  }
);

function frameModel() {
  if (!modelRoot) return;

  const box = new THREE.Box3().setFromObject(modelRoot);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  modelRoot.position.sub(center);
  modelRoot.position.y -= size.y * 0.02;

  const maxDim = Math.max(size.x, size.y, size.z);
  const fitScale = 1.6 / maxDim;
  modelRoot.scale.setScalar(fitScale);

  const box2 = new THREE.Box3().setFromObject(modelRoot);
  const size2 = new THREE.Vector3();
  const center2 = new THREE.Vector3();
  box2.getSize(size2);
  box2.getCenter(center2);

  controls.target.copy(center2);
  camera.position.set(center2.x, center2.y + size2.y * 0.03, center2.z + size2.z * 1.85);
  controls.minDistance = size2.z * 0.7;
  controls.maxDistance = size2.z * 3.5;
  sculptRadius = Math.max(size2.x, size2.y, size2.z) * 0.11;
  maxOffset = Math.max(size2.x, size2.y, size2.z) * 0.07;
  controls.update();
}

function beginSculptPointer(event, hit) {
  ensureAudioContext();
  loadAudioSoft();

  const worldNormal = hit.face.normal.clone().transformDirection(sculptMesh.matrixWorld).normalize();

  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal, hit.point.clone());
  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  const dragStartPoint = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, dragStartPoint);

  const localGrab = sculptMesh.worldToLocal(hit.point.clone());

  const p2 = hit.point.clone().add(worldNormal);
  const localNormal = sculptMesh.worldToLocal(p2).sub(localGrab).normalize();

  activePointers.set(event.pointerId, {
    pointerId: event.pointerId,
    plane,
    prevPlanePoint: dragStartPoint.clone(),
    localGrab,
    localNormal,
    x: event.clientX,
    y: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    moveEnergy: 0
  });

  controls.enabled = activePointers.size === 0;
}

function injectSculptVelocity(pointerState, deltaWorld) {
  if (!sculptMesh || !deltaWorld.lengthSq()) return;

  inverseMatrix.copy(sculptMesh.matrixWorld).invert();
  const deltaLocal = deltaWorld.clone().transformDirection(inverseMatrix);

  const geometry = sculptMesh.geometry;
  const positions = geometry.attributes.position.array;

  for (let i = 0; i < positions.length; i += 3) {
    tempVec3.set(restPositions[i], restPositions[i + 1], restPositions[i + 2]);
    const dist = tempVec3.distanceTo(pointerState.localGrab);
    if (dist > sculptRadius) continue;

    const falloff = 1 - smoothstep(0, sculptRadius, dist);
    const influence = falloff * falloff * (3 - 2 * falloff);

    velocities[i] += deltaLocal.x * influence * 13.5;
    velocities[i + 1] += deltaLocal.y * influence * 13.5;
    velocities[i + 2] += deltaLocal.z * influence * 13.5;
  }
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  const hit = getMeshHit(event);
  if (!hit) return;

  beginSculptPointer(event, hit);
  renderer.domElement.setPointerCapture?.(event.pointerId);
});

renderer.domElement.addEventListener('pointermove', (event) => {
  const state = activePointers.get(event.pointerId);
  if (!state) return;

  updatePointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);

  const planeHit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(state.plane, planeHit)) {
    const deltaWorld = planeHit.clone().sub(state.prevPlanePoint);
    injectSculptVelocity(state, deltaWorld);
    state.prevPlanePoint.copy(planeHit);
  }

  const dx = event.clientX - state.lastX;
  const dy = event.clientY - state.lastY;
  state.moveEnergy = Math.min(1, Math.hypot(dx, dy) / 18);
  state.lastX = event.clientX;
  state.lastY = event.clientY;

  if (state.moveEnergy > 0.07) {
    playRandomScrubSound(state.moveEnergy);
  }
});

function endPointer(event) {
  if (!activePointers.has(event.pointerId)) return;
  activePointers.delete(event.pointerId);
  controls.enabled = activePointers.size === 0;
}

renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);
renderer.domElement.addEventListener('lostpointercapture', () => {
  activePointers.clear();
  controls.enabled = true;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.018, clock.getDelta() || 0.016);
  const t = clock.getElapsedTime();

  if (modelRoot) {
    modelRoot.position.y += Math.sin(t * 1.3) * 0.0009;
  }

  if (sculptMesh && offsets && velocities) {
    const geometry = sculptMesh.geometry;
    const posAttr = geometry.attributes.position;
    const positions = posAttr.array;

    for (let i = 0; i < offsets.length; i += 3) {
      const ox = offsets[i];
      const oy = offsets[i + 1];
      const oz = offsets[i + 2];

      const vx = velocities[i];
      const vy = velocities[i + 1];
      const vz = velocities[i + 2];

      const ax = (-spring * ox) - (damping * vx);
      const ay = (-spring * oy) - (damping * vy);
      const az = (-spring * oz) - (damping * vz);

      velocities[i] = vx + ax * dt;
      velocities[i + 1] = vy + ay * dt;
      velocities[i + 2] = vz + az * dt;

      offsets[i] += velocities[i] * dt;
      offsets[i + 1] += velocities[i + 1] * dt;
      offsets[i + 2] += velocities[i + 2] * dt;

      const mag = Math.hypot(offsets[i], offsets[i + 1], offsets[i + 2]);
      if (mag > maxOffset) {
        const s = maxOffset / mag;
        offsets[i] *= s;
        offsets[i + 1] *= s;
        offsets[i + 2] *= s;
      }

      positions[i] = restPositions[i] + offsets[i];
      positions[i + 1] = restPositions[i + 1] + offsets[i + 1];
      positions[i + 2] = restPositions[i + 2] + offsets[i + 2];
    }

    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();

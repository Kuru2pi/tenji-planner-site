// 展示空間プランナー — shared, Blender-style layout editor.
// World units are metres in Blender axes (Z up). The UI shows millimetres.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const V3 = THREE.Vector3;
const $ = id => document.getElementById(id);
const DEG = Math.PI / 180;
const AXIS = { x: new V3(1, 0, 0), y: new V3(0, 1, 0), z: new V3(0, 0, 1) };
const AXIS_COLOR = { x: '#e5484d', y: '#46a758', z: '#3e7bfa' };
const SPAWN = new V3(7.885, -16.177, 0.05);                 // original visitor start (Blender axes)
const BUILDING = new THREE.Box3(new V3(-9, -73, 0), new V3(17, 46, 5));
const DEFAULT_DELETED = new Set(['whiteBox', 'partition', 'partitionFoot', 'oldFloor']);
const ROLE_LABEL = { whiteBox: '白いボックス', partition: '独立壁', partitionFoot: '独立壁の脚', oldFloor: '元の床', floor: '展示床' };
const PEER_COLORS = ['#ff8a3d', '#4fc3f7', '#9ccc65', '#f06292', '#ffd54f', '#ba68c8', '#4db6ac', '#e57373'];
const fmt = (m, d = 0) => (Math.round(m * 1000 * 10 ** d) / 10 ** d).toLocaleString('ja-JP', { maximumFractionDigits: d });
const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
const isTyping = e => e.target.closest?.('input, textarea, select, [contenteditable]');

// =====================================================================
// Preferences (per PC, not shared)
// =====================================================================
// Standalone mode (published page without the server): the layout lives in this browser only.
const LOCAL = !!window.PLANNER_LOCAL;
const readJSON = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; } };
const writeJSON = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); } catch {} };
const systemDark = () => { try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } };
const prefs = Object.assign({ snap: true, snapInc: 10, clip: true, clipH: 3000, labels: true, xray: false, rightPanel: true, leftPanel: true,
  theme: document.documentElement.dataset.theme || (systemDark() ? 'dark' : 'light'), edges: true, sky: true, grid: false,
  orient: 'global', boxW: 900, boxD: 450, boxH: 900, spaceSelectable: false, eye: 1600, name: '', color: '' },
  readJSON(localStorage, 'planner-prefs') || {});
const savePrefs = () => writeJSON(localStorage, 'planner-prefs', prefs);
if (LOCAL) document.body.classList.add('local');

// =====================================================================
// Shared document + sync (Server-Sent Events in, POST out)
// =====================================================================
const store = { objects: {}, space: {}, rulers: {}, scenes: {} };
const me = { id: readJSON(sessionStorage, 'planner-client') || rid() };
writeJSON(sessionStorage, 'planner-client', me.id);
let peers = [];
let outbox = [], liveBox = new Map(), sending = false, liveTimer = null;

const LOCAL_DOC = 'planner-local-doc';
let localSaveTimer = null;
function connectLocal() {
  const d = readJSON(localStorage, LOCAL_DOC) || {};
  for (const c of Object.keys(store)) store[c] = d[c] || {};
  peers = [{ id: me.id, name: prefs.name || 'あなた', color: prefs.color || '#5b5bd6', sel: [] }];
  const el = $('conn'); el.classList.add('on'); el.textContent = 'このブラウザに保存';
  syncAll();
}
function saveLocalDoc() { clearTimeout(localSaveTimer); localSaveTimer = setTimeout(() => writeJSON(localStorage, LOCAL_DOC, store), 300); }
function connect() {
  if (LOCAL) return connectLocal();
  const q = new URLSearchParams({ client: me.id, name: prefs.name || 'ゲスト', color: prefs.color || '#888' });
  const es = new EventSource('/api/events?' + q);
  es.addEventListener('init', e => {
    const d = JSON.parse(e.data);
    for (const c of Object.keys(store)) store[c] = d.state[c] || {};
    for (const o of outbox.flatMap(b => b.live || [b])) setLocal(o, false);                     // keep edits that are not on the server yet
    peers = d.peers; setConn(true);
    syncAll(); renderPeers(); sendPresence();
  });
  es.addEventListener('ops', e => {
    const d = JSON.parse(e.data);
    for (const o of d.ops) setLocal(o, editing?.keys.includes(o.c + ':' + o.id));
    refreshPanels();
  });
  es.addEventListener('peers', e => { peers = JSON.parse(e.data); renderPeers(); updateRemoteSelection(); });
  es.onerror = () => setConn(false);
}
function setConn(on) { const el = $('conn'); el.classList.toggle('on', on); el.title = el.textContent = on ? '共有中' : '再接続中…'; }

function send(ops, final = true) {
  if (LOCAL) { if (final) saveLocalDoc(); return; }
  if (!final) {                                                     // coalesce live updates (dragging)
    for (const o of ops) liveBox.set(o.c + ':' + o.id, o);
    if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; outbox.push({ live: [...liveBox.values()] }); liveBox.clear(); flush(); }, 70);
    return;
  }
  for (const o of ops) liveBox.delete(o.c + ':' + o.id);
  outbox.push(...ops.map(clone)); flush();
}
async function flush() {
  if (sending || !outbox.length) return;
  sending = true;
  const batch = outbox.splice(0, outbox.length);
  const ops = batch.flatMap(b => b.live || [b]);
  try {
    const r = await fetch('/api/ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: me.id, ops }) });
    if (!r.ok) throw new Error(r.status);
  } catch {
    outbox.unshift(...ops); setConn(false);
    await new Promise(r => setTimeout(r, 1500));
  }
  sending = false; if (outbox.length) flush();
}
let presenceTimer = null;
function sendPresence() {
  if (LOCAL) return;
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: me.id, sel: [...selected] }) }).catch(() => {}), 120);
}

// local state write + view update
function setLocal(o, skipView = false) {
  if (o.v == null) delete store[o.c][o.id]; else store[o.c][o.id] = clone(o.v);
  if (!skipView) syncEntity(o.c, o.id);
}

// ---------- undo ----------
const undoStack = [], redoStack = [];
function commit(ops, label) {
  const before = ops.map(o => ({ c: o.c, id: o.id, v: clone(store[o.c][o.id] ?? null) }));
  ops.forEach(o => setLocal(o));
  send(ops);
  pushUndo(label, before, ops);
}
function pushUndo(label, before, after) {
  undoStack.push({ label, before, after: after.map(clone) }); redoStack.length = 0;
  if (undoStack.length > 300) undoStack.shift();
  refreshPanels();
}
function undo() {
  const e = undoStack.pop(); if (!e) return toast('これ以上元に戻せません');
  e.before.forEach(o => setLocal(o)); send(e.before); redoStack.push(e); toast('元に戻す：' + e.label); refreshPanels();
}
function redo() {
  const e = redoStack.pop(); if (!e) return;
  e.after.forEach(o => setLocal(o)); send(e.after); undoStack.push(e); toast('やり直す：' + e.label); refreshPanels();
}

// ---------- continuous edits (drag, gizmo, modal, scrub fields) ----------
let editing = null;   // {keys, before}
function beginEdit(keys) {
  if (editing) return;
  editing = { keys: [...keys], before: keys.map(k => { const [c, id] = splitKey(k); return { c, id, v: clone(store[c][id] ?? null) }; }) };
}
function editOps() { return editing.keys.map(k => entityOpFromHolder(k)).filter(Boolean); }
function liveEdit() {
  if (!editing) return;
  const ops = editOps(); ops.forEach(o => setLocal(o, true)); send(ops, false); requestRender(); refreshPanels(true);
}
function endEdit(label, cancel = false) {
  if (!editing) return;
  const ed = editing; editing = null;
  if (cancel) { ed.before.forEach(o => setLocal(o)); send(ed.before); }
  else {
    ed.keys.forEach(k => { const o = entityOpFromHolder(k); if (o) { ed.after = ed.after || []; ed.after.push(o); setLocal(o, true); } });
    if (ed.after?.length) { send(ed.after); pushUndo(label, ed.before, ed.after); ed.after.forEach(o => syncEntity(o.c, o.id)); }
  }
  refreshPanels();
}
const splitKey = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };

// =====================================================================
// Three.js scene
// =====================================================================
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
renderer.domElement.className = 'gl';
viewport.prepend(renderer.domElement);
const labelRenderer = new CSS2DRenderer({ element: $('labels') });

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x777066, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(10, -20, 30); scene.add(sun);

const persp = new THREE.PerspectiveCamera(50, 1, 0.03, 6000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 9000);
let camera = persp;

const clipPlane = new THREE.Plane(new V3(0, 0, -1), 3);
const spaceRoot = new THREE.Group(); spaceRoot.name = 'space'; scene.add(spaceRoot);
const userRoot = new THREE.Group(); userRoot.name = 'user'; scene.add(userRoot);
const rulerRoot = new THREE.Group(); scene.add(rulerRoot);
const helperRoot = new THREE.Group(); scene.add(helperRoot);

// Blender-like floor grid + axis lines
{
  const grid = new THREE.GridHelper(400, 400, 0x41464d, 0x383c42); grid.rotation.x = Math.PI / 2; grid.name = 'grid';
  grid.material.transparent = true; grid.material.opacity = 0.6; grid.material.depthWrite = false; helperRoot.add(grid);
  for (const [a, col] of [['x', 0xe5484d], ['y', 0x46a758]]) {
    const p = AXIS[a].clone().multiplyScalar(200);
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p.clone().negate(), p]), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.7 }));
    helperRoot.add(l);
  }

}

// post-processing: selection outlines (selected = teal, active = light teal)
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera); composer.addPass(renderPass);
const outlineSel = new OutlinePass(new THREE.Vector2(1, 1), scene, camera);
const outlineAct = new OutlinePass(new THREE.Vector2(1, 1), scene, camera);
for (const [p, c] of [[outlineSel, 0x8e8ef5], [outlineAct, 0x3d3dd0]]) {
  p.visibleEdgeColor.set(c); p.hiddenEdgeColor.set(c).multiplyScalar(0.35); p.edgeStrength = 4; p.edgeThickness = 1; p.edgeGlow = 0; composer.addPass(p);
}
composer.addPass(new OutputPass());

const tc = new TransformControls(camera, renderer.domElement);
tc.setSize(0.9); scene.add(tc);

let needsRender = true;
const requestRender = () => { needsRender = true; };
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h); composer.setSize(w, h); labelRenderer.setSize(w, h);
  outlineSel.setSize(w, h); outlineAct.setSize(w, h);
  updateCamera();
}
new ResizeObserver(resize).observe(viewport);

// =====================================================================
// Navigation (Blender turntable)
// =====================================================================
const nav = { target: new V3(4, -12, 1), dist: 55, yaw: -125 * DEG, pitch: 38 * DEG, ortho: false, preset: null };
let activeScene = null;
function viewDir() { const cp = Math.cos(nav.pitch); return new V3(cp * Math.cos(nav.yaw), cp * Math.sin(nav.yaw), Math.sin(nav.pitch)); }
function updateCamera() {
  const w = viewport.clientWidth || 1, h = viewport.clientHeight || 1;
  const dir = viewDir(), right = new V3(-Math.sin(nav.yaw), Math.cos(nav.yaw), 0), up = dir.clone().cross(right);
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, dir));
  persp.aspect = w / h; persp.position.copy(nav.target).addScaledVector(dir, nav.dist); persp.quaternion.copy(q); persp.updateProjectionMatrix();
  const half = nav.dist * Math.tan(persp.fov * DEG / 2);
  Object.assign(ortho, { left: -half * w / h, right: half * w / h, top: half, bottom: -half });
  ortho.position.copy(nav.target).addScaledVector(dir, 2000); ortho.quaternion.copy(q); ortho.updateProjectionMatrix();
  const cam = nav.ortho ? ortho : persp;
  if (cam !== camera) { camera = cam; renderPass.camera = cam; outlineSel.renderCamera = cam; outlineAct.renderCamera = cam; tc.camera = cam; }
  camera.updateMatrixWorld();
  updateViewInfo(); requestRender();
}
const camRight = () => new V3().setFromMatrixColumn(camera.matrixWorld, 0);
const camUp = () => new V3().setFromMatrixColumn(camera.matrixWorld, 1);
function worldPerPixel(p) {
  const h = viewport.clientHeight || 1;
  if (nav.ortho) return (ortho.top - ortho.bottom) / h;
  const d = camera.position.distanceTo(p) * Math.max(0.1, Math.abs(new V3().subVectors(p, camera.position).normalize().dot(camera.getWorldDirection(new V3()))));
  return 2 * d * Math.tan(persp.fov * DEG / 2) / h;
}
function leaveScene() { if (activeScene) { activeScene = null; scheduleUI(); } }
function orbit(dx, dy) {
  if (sim.follow) { sim.lookYaw -= dx * 0.005; sim.lookPitch = THREE.MathUtils.clamp(sim.lookPitch - dy * 0.005, -1.2, 1.2); return; }   // look around while walking a route
  if (planMode) return pan(dx, dy);   // the plan stays flat: dragging slides it instead
  leaveScene();
  nav.yaw -= dx * 0.006; nav.pitch = THREE.MathUtils.clamp(nav.pitch + dy * 0.006, -Math.PI / 2, Math.PI / 2);
  if (nav.preset && nav.autoOrtho) nav.ortho = false;
  nav.preset = null; updateCamera();
}
function pan(dx, dy) {
  leaveScene();
  const wpp = (nav.ortho ? (ortho.top - ortho.bottom) : 2 * nav.dist * Math.tan(persp.fov * DEG / 2)) / viewport.clientHeight;
  nav.target.addScaledVector(camRight(), -dx * wpp).addScaledVector(camUp(), dy * wpp); updateCamera();
}
function zoom(f) { leaveScene(); nav.dist = THREE.MathUtils.clamp(nav.dist * f, 0.05, 1500); updateCamera(); }
const PRESETS = {
  front: { yaw: -90, pitch: 0, name: '前面' }, back: { yaw: 90, pitch: 0, name: '背面' }, right: { yaw: 0, pitch: 0, name: '右面' },
  left: { yaw: 180, pitch: 0, name: '左面' }, top: { yaw: -90, pitch: 90, name: '上面' }, bottom: { yaw: -90, pitch: -90, name: '下面' },
};
function setPreset(p) {
  if (planMode) setPlanMode(false);
  const v = PRESETS[p]; nav.yaw = v.yaw * DEG; nav.pitch = v.pitch * DEG;
  if (!nav.ortho) { nav.ortho = true; nav.autoOrtho = true; } nav.preset = p; updateCamera();
}
function toggleOrtho() { nav.ortho = !nav.ortho; nav.autoOrtho = false; updateCamera(); }
function frameBox(box) {
  if (box.isEmpty()) return;
  const s = box.getBoundingSphere(new THREE.Sphere());
  nav.target.copy(s.center); nav.dist = Math.max(0.5, s.radius / Math.sin(persp.fov * DEG / 2) * 1.05); updateCamera();
}
function frameAll() {
  const b = BUILDING.clone();
  for (const h of userRoot.children) if (h.visible) b.expandByObject(h);
  frameBox(b);
}
function frameSelected() {
  const b = new THREE.Box3(); for (const k of selected) { const h = holderOf(k); if (h) b.expandByObject(h); }
  if (b.isEmpty()) return frameAll(); frameBox(b);
}
function eyeView() {
  if (planMode) setPlanMode(false);
  nav.ortho = false; nav.preset = null; nav.pitch = 0; nav.yaw = 90 * DEG; nav.dist = 3;
  nav.target.set(SPAWN.x, SPAWN.y - 3, SPAWN.z + prefs.eye / 1000); updateCamera();
}
function updateViewInfo() {
  $('viewInfo').innerHTML = `<span class="v">${nav.preset ? PRESETS[nav.preset].name : '自由視点'}</span><span>${nav.ortho ? '平行投影' : '透視投影'}</span>`;
}

// =====================================================================
// Clipping / x-ray
// =====================================================================
const spaceMaterials = new Set();
function applyClip() { clipPlane.constant = planMode ? 1.5 : prefs.clip ? prefs.clipH / 1000 : 1e6; $('clipBtn').classList.toggle('on', prefs.clip); requestRender(); }
function applyXray() {
  for (const m of spaceMaterials) {
    m.transparent = prefs.xray || m.userData.origTransparent; m.opacity = prefs.xray ? 0.3 : m.userData.origOpacity;
    m.depthWrite = !prefs.xray; m.needsUpdate = true;
  }
  $('xrayBtn').classList.toggle('on', prefs.xray); requestRender();
}

// =====================================================================
// Existing space (loaded once, overrides come from the shared doc)
// =====================================================================
const spaceHolders = new Map();   // key -> holder
const spaceMeshes = [];
const A = new THREE.Matrix4().makeRotationX(Math.PI / 2), Ainv = A.clone().invert();
const draco = new DRACOLoader().setDecoderPath('draco/');   // bundled decoder (works offline and inside the published page)
const gltfLoader = new GLTFLoader().setDRACOLoader(draco);
// The published page ships the model base64-encoded as text (its host does not serve .glb files).
async function loadSpaceBuffer() {
  if (window.PLANNER_SPACE_B64) {
    const bin = atob((await (await fetch(window.PLANNER_SPACE_B64)).text()).trim());
    const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  const r = await fetch('space.glb'); if (!r.ok) throw new Error(r.status); return r.arrayBuffer();
}
loadSpaceBuffer().then(buf => gltfLoader.parseAsync(buf, '')).then(gltf => {
  const nodes = [...gltf.scene.children];
  for (const n of nodes) {
    n.updateMatrix();
    const holder = new THREE.Group(); holder.name = n.name;
    new THREE.Matrix4().multiplyMatrices(A, n.matrix).multiply(Ainv).decompose(holder.position, holder.quaternion, holder.scale);
    const inner = new THREE.Group(); inner.rotation.x = Math.PI / 2;
    n.position.set(0, 0, 0); n.quaternion.identity(); n.scale.set(1, 1, 1);
    inner.add(n); holder.add(inner);
    const role = n.userData.tenji_role || null;
    holder.userData = { c: 'space', id: n.name, role, base: { loc: holder.position.toArray(), rot: [holder.rotation.x, holder.rotation.y, holder.rotation.z], scale: holder.scale.toArray() } };
    n.traverse(o => {
      if (!o.isMesh) return;
      spaceMeshes.push(o);
      if (!o.geometry.boundsTree) o.geometry.computeBoundsTree();
      const tris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
      if (tris < 20000 && role !== 'floor') {   // black outlines on simple geometry (skip dense models like the ducts, and the floor)
        o.geometry.userData.edges ??= new THREE.EdgesGeometry(o.geometry, 25);
        const line = new THREE.LineSegments(o.geometry.userData.edges, spaceEdgeMat);
        line.raycast = () => {}; line.visible = prefs.edges; o.add(line); spaceEdges.push(line);
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (spaceMaterials.has(m)) continue;
        if (m.map) m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();   // keep floor tiles crisp at grazing angles
        m.clippingPlanes = [clipPlane]; m.side = THREE.DoubleSide; m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        m.userData.origTransparent = m.transparent; m.userData.origOpacity = m.opacity; spaceMaterials.add(m);
      }
    });
    holder.userData.baseBox = localBox(holder);
    spaceRoot.add(holder); spaceHolders.set(n.name, holder);
  }
  applyXray();
  for (const key of spaceHolders.keys()) syncSpace(key);
  $('loading').remove(); frameAll(); refreshPanels(); requestRender();
}).catch(err => { $('loading').textContent = '展示空間を読み込めませんでした：' + err.message; });

function localBox(holder) {
  const m = holder.matrix.clone(); holder.matrix.identity(); holder.matrixAutoUpdate = false; holder.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(holder, true);
  holder.matrixAutoUpdate = true; holder.matrix.copy(m); holder.updateMatrixWorld(true);
  return b;
}
const spaceOverride = key => store.space[key] || null;
function spaceDeleted(key) {
  const o = spaceOverride(key), h = spaceHolders.get(key);
  return o && 'deleted' in o ? !!o.deleted : DEFAULT_DELETED.has(h?.userData.role);
}
function syncSpace(key) {
  const h = spaceHolders.get(key); if (!h) return;
  const o = spaceOverride(key) || {}, b = h.userData.base;
  h.position.fromArray(o.loc || b.loc); h.rotation.set(...(o.rot || b.rot)); h.scale.fromArray(o.scale || b.scale);
  h.visible = !spaceDeleted(key) && !o.hidden;
  if (!h.visible) { selected.delete('space:' + key); if (activeKey === 'space:' + key) activeKey = null; }
}

// =====================================================================
// User objects (boxes / images / imported models)
// =====================================================================
const userHolders = new Map();
const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
const boxEdges = new THREE.EdgesGeometry(boxGeo);
const assetCache = new Map();     // asset id -> Promise<template Object3D | {texture,w,h}>

function syncEntity(c, id) {
  if (c === 'objects') syncObject(id);
  else if (c === 'space') syncSpace(id);
  else if (c === 'rulers') syncRuler(id);
  else if (c === 'scenes' && !store.scenes[id] && activeScene === id) activeScene = null;
  scheduleUI(); requestRender();
}
function syncAll() {
  for (const id of [...userHolders.keys()]) if (!store.objects[id]) syncObject(id);
  for (const id of Object.keys(store.objects)) syncObject(id);
  for (const key of spaceHolders.keys()) syncSpace(key);
  for (const id of [...rulerObjs.keys()]) if (!store.rulers[id]) syncRuler(id);
  for (const id of Object.keys(store.rulers)) syncRuler(id);
  scheduleUI(); requestRender();
}
const shapeKey = v => [v.type, v.asset?.id, v.unit, v.yup, v.type === 'line' || v.type === 'route' ? JSON.stringify([v.points, v.width]) : ''].join('|');
function disposeHolder(h) {
  h.traverse(o => { if (o.isCSS2DObject) o.element.remove(); if (o.isMesh && o.userData.own) { o.geometry.dispose?.(); } });
  h.removeFromParent();
}
function syncObject(id) {
  const v = store.objects[id]; let h = userHolders.get(id);
  if (!v) { if (h) { disposeHolder(h); userHolders.delete(id); selected.delete('objects:' + id); if (activeKey === 'objects:' + id) activeKey = null; } return; }
  if (!h || h.userData.shape !== shapeKey(v)) {
    if (h) disposeHolder(h);
    h = new THREE.Group(); h.userData = { c: 'objects', id, shape: shapeKey(v), baseBox: new THREE.Box3(new V3(-0.5, -0.5, 0), new V3(0.5, 0.5, 1)) };
    const el = document.createElement('div'); el.className = 'lbl3d';
    h.userData.label = new CSS2DObject(el); h.add(h.userData.label);
    buildShape(h, v); userRoot.add(h); userHolders.set(id, h);
  }
  if (!(editing && editing.keys.includes('objects:' + id))) {
    h.position.fromArray(v.loc); h.rotation.set(...v.rot); h.scale.fromArray(v.scale);
  }
  h.visible = !v.hidden;
  h.traverse(o => {
    if (o.userData.tintColorOnly) { o.material.color.set(v.color || '#ffffff'); return; }
    if (!o.isMesh || !o.userData.tint) return;
    o.material.color.set(v.color || '#ffffff');
    o.material.opacity = v.opacity ?? 1; o.material.transparent = (v.opacity ?? 1) < 1; o.material.depthWrite = (v.opacity ?? 1) >= 1;
  });
  updateLabel(h);
}
function buildShape(h, v) {
  if (v.type === 'box') {
    const mesh = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 })); mesh.userData.tint = true;
    const edges = new THREE.LineSegments(boxEdges, new THREE.LineBasicMaterial({ color: 0x1a1a1a })); edges.raycast = () => {};
    h.add(mesh, edges);
  } else if (v.type === 'image') {
    const aspect = (v.asset.h || 1) / (v.asset.w || 1);
    const geo = new THREE.PlaneGeometry(1, aspect).rotateX(Math.PI / 2).translate(0, 0, aspect / 2);
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, color: 0xffffff });
    const mesh = new THREE.Mesh(geo, mat); mesh.userData.own = true; mesh.userData.tint = true; h.add(mesh);
    h.userData.baseBox = new THREE.Box3(new V3(-0.5, 0, 0), new V3(0.5, 0, aspect));
    loadAsset(v.asset).then(t => { mat.map = t.texture; mat.needsUpdate = true; requestRender(); }).catch(() => { mat.color.set(0xff00ff); });
  } else if (v.type === 'line' || v.type === 'route') {
    buildPolyShape(h, v);
  } else if (v.type === 'model') {
    const ph = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: 0x888888, wireframe: true })); h.add(ph);
    loadAsset(v.asset).then(tpl => {
      if (userHolders.get(h.userData.id) !== h) return;
      ph.removeFromParent();
      const inner = new THREE.Group(); inner.add(tpl.clone(true));
      if (v.yup) inner.rotation.x = Math.PI / 2;
      inner.scale.setScalar(v.unit || 1);
      const tmp = new THREE.Group(); tmp.add(inner); tmp.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(tmp, true);
      const c = b.getCenter(new V3());
      inner.position.set(-c.x, -c.y, -b.min.z);
      h.add(inner);
      h.userData.baseBox = b.clone().translate(new V3(-c.x, -c.y, -b.min.z));
      inner.traverse(o => { if (o.isMesh && !o.geometry.boundsTree) o.geometry.computeBoundsTree(); });
      updateLabel(h); scheduleUI(); requestRender();
    }).catch(err => { ph.material.color.set(0xff3333); toast('3Dデータを読み込めませんでした：' + (v.asset?.name || '')); console.error(err); });
  }
}
function dims(h) { return h.userData.baseBox.getSize(new V3()).multiply(new V3(Math.abs(h.scale.x), Math.abs(h.scale.y), Math.abs(h.scale.z))); }
function updateLabel(h) {
  const lbl = h.userData.label; if (!lbl) return;
  const v = store.objects[h.userData.id]; if (!v) return;
  const d = dims(h);
  lbl.visible = prefs.labels && h.visible;
  lbl.position.set(0, 0, h.userData.baseBox.max.z);
  if (v.type === 'line') lbl.element.textContent = `${v.name}  ${fmt(polyLength(v.points))} mm`;
  else if (v.type === 'route') { const L = polyLength(v.points); lbl.element.textContent = `${v.name}  ${(L).toFixed(1)} m・約${Math.max(1, Math.round(L / (v.speed || 1)))}秒`; }
  else lbl.element.textContent = v.type === 'image' ? `${v.name}  ${fmt(d.x)}×${fmt(d.z)}` : `${v.name}  ${fmt(d.x)}×${fmt(d.y)}×${fmt(d.z)}`;
  lbl.element.classList.toggle('sel', selected.has('objects:' + h.userData.id));
}

// ---------- assets ----------
function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MODEL_EXT = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl']);
function loadAsset(asset, buffer) {
  if (assetCache.has(asset.id)) return assetCache.get(asset.id);
  const p = (async () => {
    const buf = buffer || (LOCAL ? await (await idbGet(asset.id)).arrayBuffer() : await (await fetch('/assets/' + asset.id)).arrayBuffer());
    return parseAsset(buf, asset.ext || extOf(asset.name));
  })();
  assetCache.set(asset.id, p);
  p.catch(() => assetCache.delete(asset.id));
  return p;
}
async function parseAsset(buf, ext) {
  if (IMAGE_EXT.has(ext)) {
    const bmp = await createImageBitmap(new Blob([buf]), { imageOrientation: 'flipY' });
    const texture = new THREE.Texture(bmp); texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = false; texture.needsUpdate = true;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return { texture, w: bmp.width, h: bmp.height };
  }
  if (ext === 'glb' || ext === 'gltf') return (await gltfLoader.parseAsync(buf, '')).scene;
  if (ext === 'obj') { const g = new OBJLoader().parse(new TextDecoder().decode(buf)); g.traverse(o => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6 }); }); return g; }
  if (ext === 'fbx') return new FBXLoader().parse(buf, '');
  if (ext === 'stl') { const geo = new STLLoader().parse(buf); geo.computeVertexNormals(); return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6 })); }
  throw new Error('未対応の形式: ' + ext);
}
// imported files in standalone mode are kept in this browser's IndexedDB (memory if that is blocked)
const memAssets = new Map();
function idbOpen() {
  return new Promise((res, rej) => { try { const r = indexedDB.open('planner-assets', 1); r.onupgradeneeded = () => r.result.createObjectStore('a'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } });
}
async function idbPut(id, blob) {
  memAssets.set(id, blob);
  try { const db = await idbOpen(); await new Promise((res, rej) => { const tx = db.transaction('a', 'readwrite'); tx.objectStore('a').put(blob, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch {}
}
async function idbGet(id) {
  if (memAssets.has(id)) return memAssets.get(id);
  const db = await idbOpen();
  const b = await new Promise((res, rej) => { const r = db.transaction('a').objectStore('a').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  if (!b) throw new Error('ファイルがこのブラウザに見つかりません'); return b;
}
async function uploadAsset(file) {
  if (LOCAL) { const id = rid(); await idbPut(id, file); return { id, name: file.name }; }
  const r = await fetch('/api/assets?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  if (!r.ok) throw new Error('アップロードに失敗しました（' + r.status + '）');
  return r.json();
}

// =====================================================================
// Rulers (measure tool) — shared
// =====================================================================
const rulerObjs = new Map();
const rulerMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
const rulerSelMat = new THREE.LineBasicMaterial({ color: 0x5fdccb, depthTest: false, transparent: true });
const dotGeo = new THREE.SphereGeometry(1, 10, 8);
const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
let selRuler = null;
function rulerText(a, b, detailed) {
  const d = new V3().subVectors(b, a);
  const main = `${fmt(d.length())} mm`;
  return detailed ? `${main}<small>水平 ${fmt(Math.hypot(d.x, d.y))}　ΔX ${fmt(Math.abs(d.x))}　ΔY ${fmt(Math.abs(d.y))}　ΔZ ${fmt(Math.abs(d.z))}</small>` : main;
}
function makeRulerObj() {
  const g = new THREE.Group();
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(), new V3()]), rulerMat); line.renderOrder = 20;
  const da = new THREE.Mesh(dotGeo, dotMat), db = new THREE.Mesh(dotGeo, dotMat); da.renderOrder = db.renderOrder = 20; da.userData.dot = db.userData.dot = true;
  const el = document.createElement('div'); el.className = 'rlbl';
  const lbl = new CSS2DObject(el);
  g.add(line, da, db, lbl); g.userData = { line, da, db, lbl };
  return g;
}
function placeRuler(g, a, b, sel) {
  const { line, da, db, lbl } = g.userData;
  line.geometry.setFromPoints([a, b]); line.material = sel ? rulerSelMat : rulerMat;
  da.position.copy(a); db.position.copy(b); lbl.position.copy(a).lerp(b, 0.5);
  lbl.element.innerHTML = rulerText(a, b, sel); lbl.element.classList.toggle('sel', sel);
}
function syncRuler(id) {
  const v = store.rulers[id]; let g = rulerObjs.get(id);
  if (!v) { if (g) { g.userData.lbl.element.remove(); g.userData.line.geometry.dispose(); g.removeFromParent(); rulerObjs.delete(id); } if (selRuler === id) selRuler = null; return; }
  if (!g) { g = makeRulerObj(); g.userData.id = id; rulerRoot.add(g); rulerObjs.set(id, g); }
  placeRuler(g, new V3(...v.a), new V3(...v.b), selRuler === id);
}
let tempRuler = null;
function showTempRuler(a, b) {
  if (!tempRuler) { tempRuler = makeRulerObj(); scene.add(tempRuler); }
  placeRuler(tempRuler, a, b, true); requestRender();
}
function hideTempRuler() { if (tempRuler) { tempRuler.userData.lbl.element.remove(); tempRuler.removeFromParent(); tempRuler = null; requestRender(); } }

// =====================================================================
// Selection
// =====================================================================
const selected = new Set(); let activeKey = null;
const holderOf = k => { const [c, id] = splitKey(k); return c === 'objects' ? userHolders.get(id) : c === 'space' ? spaceHolders.get(id) : null; };
function displayName(k) {
  const [c, id] = splitKey(k);
  if (c === 'objects') return store.objects[id]?.name || '';
  const h = spaceHolders.get(id); return id + (h?.userData.role ? `（${ROLE_LABEL[h.userData.role]}）` : '');
}
function setSelection(keys, active, mode = 'set') {
  if (mode === 'set') selected.clear();
  for (const k of keys) { if (mode === 'remove') selected.delete(k); else selected.add(k); }
  if (mode === 'toggle') { for (const k of keys) { if (selected.has(k) && activeKey === k) selected.delete(k); else selected.add(k); } }
  activeKey = active !== undefined ? active : (selected.has(activeKey) ? activeKey : [...selected].pop() || null);
  if (activeKey && !selected.has(activeKey)) activeKey = [...selected].pop() || null;
  if (selRuler && keys.length) { const r = selRuler; selRuler = null; syncRuler(r); }
  selectionChanged();
}
function selectionChanged() {
  outlineSel.selectedObjects = [...selected].filter(k => k !== activeKey).map(holderOf).filter(Boolean);
  outlineAct.selectedObjects = activeKey ? [holderOf(activeKey)].filter(Boolean) : [];
  for (const h of userHolders.values()) updateLabel(h);
  attachGizmo(); sendPresence(); updateViewInfo(); scheduleUI(); requestRender();
}
function editableKeys() { return [...selected].filter(k => holderOf(k)?.visible); }

// remote peers' selections as coloured boxes
const remoteHelpers = [];
function updateRemoteSelection() {
  remoteHelpers.splice(0).forEach(h => h.removeFromParent());
  for (const p of peers) {
    if (p.id === me.id) continue;
    for (const k of p.sel || []) {
      const h = holderOf(k); if (!h || !h.visible) continue;
      const helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(h, true), new THREE.Color(p.color));
      helperRoot.add(helper); remoteHelpers.push(helper);
    }
  }
  scheduleUI(); requestRender();
}

// =====================================================================
// Picking
// =====================================================================
const raycaster = new THREE.Raycaster();
function mouseNDC(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}
function visibleChain(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; }
function holderFromObject(o) { for (; o; o = o.parent) if (o.userData?.c) return o; return null; }
function raycastAll(e, { selectable = false, exclude = null } = {}) {
  raycaster.setFromCamera(mouseNDC(e), camera);
  const roots = [userRoot, spaceRoot];
  const hits = raycaster.intersectObjects(roots, true);
  const clipZ = clipPlane.constant;
  for (const hit of hits) {
    if (!hit.object.isMesh || !visibleChain(hit.object)) continue;
    const h = holderFromObject(hit.object); if (!h) continue;
    if (exclude && exclude.has(h)) continue;
    if (h.userData.c === 'space') {
      if (hit.point.z > clipZ + 1e-4) continue;
      if (selectable && !prefs.spaceSelectable) return null;
    }
    hit.holder = h; return hit;
  }
  return null;
}
const keyOfHolder = h => h.userData.c + ':' + h.userData.id;
function hitNormal(hit) { return hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize() : new V3(0, 0, 1); }
function toScreen(p) {
  const v = p.clone().project(camera);
  return { x: (v.x + 1) / 2 * viewport.clientWidth, y: (1 - v.y) / 2 * viewport.clientHeight, behind: v.z > 1 };
}
function localXY(e) { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function groundPoint(e, z = 0) {
  raycaster.setFromCamera(mouseNDC(e), camera);
  const p = new V3(); return raycaster.ray.intersectPlane(new THREE.Plane(new V3(0, 0, 1), -z), p) ? p : null;
}

// Inference snapping: endpoints, midpoints, points on edges and faces — each labelled while hovering
const SNAP_LABEL = { vertex: '端点', mid: '中点', edge: 'エッジ上', face: '面上', ground: '地面', cursor: '3Dカーソル' };
function snapSurface(e, useSnap, exclude) {
  const hit = raycastAll(e, { exclude });
  const m = localXY(e);
  const nearest = (pts, kind, lim) => {
    let best = null, bd = lim;
    for (const c of pts) { const sp = toScreen(c); if (sp.behind) continue; const d = Math.hypot(sp.x - m.x, sp.y - m.y); if (d < bd) { bd = d; best = c; } }
    return best ? { p: best.clone(), kind, hit } : null;
  };
  if (useSnap) {
    const ends = [], segs = [];
    for (const r of Object.values(store.rulers)) ends.push(new V3(...r.a), new V3(...r.b));
    if (hit?.face) {
      const h = hit.holder;
      if (h.userData.c === 'objects' && store.objects[h.userData.id]?.type === 'box') {
        // real box corners and its 12 edges (not the triangle diagonals)
        const bb = h.userData.baseBox, mw = h.matrixWorld, C = [];
        for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) C.push(new V3(x, y, z).applyMatrix4(mw));
        ends.push(...C);
        for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) segs.push([C[i], C[i | bit]]);
      } else {
        const pos = hit.object.geometry.attributes.position, mw = hit.object.matrixWorld;
        const vs = [hit.face.a, hit.face.b, hit.face.c].map(i => new V3().fromBufferAttribute(pos, i).applyMatrix4(mw));
        ends.push(...vs); for (let i = 0; i < 3; i++) segs.push([vs[i], vs[(i + 1) % 3]]);
      }
    }
    const s = nearest(ends, 'vertex', 14) || nearest(segs.map(([p, q]) => p.clone().lerp(q, 0.5)), 'mid', 12) || nearest([cursor.pos], 'cursor', 10);
    if (s) return s;
    if (hit) {
      let eb = null, ebD = 9;
      for (const [p, q] of segs) {
        const c = new THREE.Line3(p, q).closestPointToPoint(hit.point, true, new V3()), sp = toScreen(c);
        const d = Math.hypot(sp.x - m.x, sp.y - m.y); if (d < ebD) { ebD = d; eb = c; }
      }
      if (eb) return { p: eb, kind: 'edge', hit };
    }
  }
  if (hit) return { p: hit.point.clone(), kind: 'face', hit };
  const g = groundPoint(e); return g ? { p: g, kind: 'ground', hit: null } : null;
}
function showSnapMark(s) {
  const el = $('snapMark');
  if (!s) return el.classList.add('hidden');
  const p = toScreen(s.p); el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  el.className = 'snap-' + s.kind; el.dataset.label = SNAP_LABEL[s.kind];
}

// =====================================================================
// 3D cursor
// =====================================================================
const cursor = { pos: new V3(SPAWN.x, SPAWN.y - 4, 0.09), normal: new V3(0, 0, 1) };
function setCursor(p, n) { cursor.pos.copy(p); cursor.normal.copy(n || new V3(0, 0, 1)); updateCursorEl(); scheduleUI(); }
function updateCursorEl() {
  const s = toScreen(cursor.pos), el = $('cursor3d');
  el.style.display = s.behind ? 'none' : ''; el.style.left = s.x + 'px'; el.style.top = s.y + 'px';
}

// =====================================================================
// Entities <-> holders
// =====================================================================
function entityOpFromHolder(k) {
  const [c, id] = splitKey(k), h = holderOf(k); if (!h) return null;
  const t = { loc: h.position.toArray(), rot: [h.rotation.x, h.rotation.y, h.rotation.z], scale: h.scale.toArray() };
  if (c === 'objects') return store.objects[id] ? { c, id, v: { ...store.objects[id], ...t } } : null;
  return { c, id, v: { ...(store.space[id] || {}), ...t } };
}
function nextName(base) {
  const names = new Set(Object.values(store.objects).map(o => o.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) { const n = `${base}.${String(i).padStart(3, '0')}`; if (!names.has(n)) return n; }
}
function newEntity(fields) {
  return { name: 'オブジェクト', loc: cursor.pos.toArray(), rot: [0, 0, 0], scale: [1, 1, 1], color: '#ffffff', opacity: 1, hidden: false,
    by: prefs.name || 'ゲスト', created: Date.now(), ...fields };
}

// ---------- operators ----------
function addBox(w = prefs.boxW, d = prefs.boxD, hgt = prefs.boxH, name = 'ボックス', color = '#f2f0ea') {
  const id = rid();
  const v = newEntity({ type: 'box', name: nextName(name), scale: [w / 1000, d / 1000, hgt / 1000], color });
  commit([{ c: 'objects', id, v }], 'ボックスを追加');
  setSelection(['objects:' + id], 'objects:' + id);
  showLastOp('ボックスを追加', [
    numDef('幅 X', () => store.objects[id]?.scale[0] * 1000, val => resizeEntity(id, 0, val)),
    numDef('奥行 Y', () => store.objects[id]?.scale[1] * 1000, val => resizeEntity(id, 1, val)),
    numDef('高さ Z', () => store.objects[id]?.scale[2] * 1000, val => resizeEntity(id, 2, val)),
  ]);
}
function resizeEntity(id, axis, mm) {
  const v = store.objects[id]; if (!v || !(mm > 0)) return;
  const scale = [...v.scale]; scale[axis] = mm / 1000;
  if (v.type === 'box') { prefs[['boxW', 'boxD', 'boxH'][axis]] = Math.round(mm); savePrefs(); }
  commit([{ c: 'objects', id, v: { ...v, scale } }], '寸法を変更');
}
function placementForCursor(heightM) {
  // on a wall: hang centred on the cursor, facing out of the wall; otherwise stand on the cursor facing the viewer
  const n = cursor.normal;
  if (Math.abs(n.z) < 0.5) {
    const h = new V3(n.x, n.y, 0).normalize();
    return { loc: cursor.pos.clone().addScaledVector(h, 0.003).add(new V3(0, 0, -heightM / 2)).toArray(), rot: [0, 0, Math.atan2(h.x, -h.y)] };
  }
  const toCam = new V3().subVectors(camera.position, cursor.pos); toCam.z = 0;
  const ang = toCam.lengthSq() > 1e-6 ? Math.atan2(toCam.x, -toCam.y) : 0;
  return { loc: cursor.pos.toArray(), rot: [0, 0, ang] };
}
async function importFiles(files) {
  for (const file of files) {
    const ext = extOf(file.name);
    if (!IMAGE_EXT.has(ext) && !MODEL_EXT.has(ext)) { toast('未対応の形式です：' + file.name); continue; }
    toast(`読み込み中：${file.name}`, 60000);
    try {
      const buf = await file.arrayBuffer();
      const parsed = await parseAsset(buf, ext);
      const up = await uploadAsset(file);
      const asset = { id: up.id, name: file.name, ext };
      assetCache.set(up.id, Promise.resolve(parsed));
      const id = rid(), base = file.name.replace(/\.[^.]+$/, '');
      if (IMAGE_EXT.has(ext)) {
        asset.w = parsed.w; asset.h = parsed.h;
        const widthM = 1, heightM = widthM * parsed.h / parsed.w;
        const pl = placementForCursor(heightM);
        commit([{ c: 'objects', id, v: newEntity({ type: 'image', name: nextName(base), asset, ...pl, scale: [widthM, widthM, widthM] }) }], '画像を読み込み');
        setSelection(['objects:' + id], 'objects:' + id);
        showLastOp('画像を読み込み', [
          numDef('幅', () => store.objects[id]?.scale[0] * 1000, val => { const v = store.objects[id]; if (v && val > 0) commit([{ c: 'objects', id, v: { ...v, scale: [val / 1000, val / 1000, val / 1000] } }], '画像の大きさ'); }),
          numDef('高さ', () => store.objects[id] ? store.objects[id].scale[2] * 1000 * asset.h / asset.w : 0, val => { const v = store.objects[id]; if (v && val > 0) { const s = val / 1000 * asset.w / asset.h; commit([{ c: 'objects', id, v: { ...v, scale: [s, s, s] } }], '画像の大きさ'); } }),
        ]);
      } else {
        const yup = ext !== 'stl';
        const size = new THREE.Box3().setFromObject(parsed, true).getSize(new V3());
        const maxd = Math.max(size.x, size.y, size.z);
        const unit = maxd > 500 ? 0.001 : maxd > 50 ? 0.01 : 1;
        commit([{ c: 'objects', id, v: newEntity({ type: 'model', name: nextName(base), asset, unit, yup, color: null }) }], '3Dデータを読み込み');
        setSelection(['objects:' + id], 'objects:' + id);
        showLastOp('3Dデータを読み込み', [unitDef(id), yupDef(id)]);
      }
      toast(`読み込みました：${file.name}`);
    } catch (err) { console.error(err); toast(`読み込めませんでした：${file.name}（${err.message}）`, 5000); }
  }
}
function duplicateSelected() {
  const keys = editableKeys().filter(k => k.startsWith('objects:')); if (!keys.length) return toast('複製できるのは追加したオブジェクトだけです');
  const ops = [], newKeys = [];
  for (const k of keys) {
    const v = store.objects[splitKey(k)[1]]; const id = rid();
    ops.push({ c: 'objects', id, v: { ...clone(v), name: nextName(v.name.replace(/\.\d{3}$/, '')), by: prefs.name, created: Date.now() } }); newKeys.push('objects:' + id);
  }
  commit(ops, '複製');
  setSelection(newKeys, 'objects:' + splitKey(newKeys[newKeys.length - 1])[1]);
  startModal('G');
}
function deleteSelected() {
  const keys = [...selected]; if (!keys.length && !selRuler) return;
  const ops = [];
  for (const k of keys) {
    const [c, id] = splitKey(k);
    if (c === 'objects') ops.push({ c, id, v: null });
    else if (c === 'space') ops.push({ c, id, v: { ...(store.space[id] || {}), deleted: true } });
  }
  if (selRuler) ops.push({ c: 'rulers', id: selRuler, v: null });
  setSelection([], null); selRuler = null;
  if (ops.length) commit(ops, '削除');
}
function restoreSpace(keys) { commit(keys.map(id => ({ c: 'space', id, v: { ...(store.space[id] || {}), deleted: false } })), '既存オブジェクトを復元'); }
function setHidden(keys, hidden) {
  const ops = keys.map(k => { const [c, id] = splitKey(k); return c === 'objects' ? { c, id, v: { ...store.objects[id], hidden } } : { c, id, v: { ...(store.space[id] || {}), hidden } }; });
  if (ops.length) commit(ops, hidden ? '非表示' : '表示');
}
function hideSelected() { const k = [...selected]; setSelection([], null); setHidden(k, true); }
function unhideAll() {
  const keys = [...Object.entries(store.objects).filter(([, v]) => v.hidden).map(([id]) => 'objects:' + id),
    ...Object.entries(store.space).filter(([, v]) => v.hidden).map(([id]) => 'space:' + id)];
  setHidden(keys, false);
}
function selectAll() {
  const keys = [...userHolders.entries()].filter(([, h]) => h.visible).map(([id]) => 'objects:' + id);
  if (prefs.spaceSelectable) for (const [id, h] of spaceHolders) if (h.visible) keys.push('space:' + id);
  setSelection(keys);
}
function dropToFloor() {
  const keys = editableKeys(); if (!keys.length) return;
  beginEdit(keys);
  const down = new THREE.Raycaster();
  for (const k of keys) {
    const h = holderOf(k), b = new THREE.Box3().setFromObject(h, true), c = b.getCenter(new V3());
    const own = new Set([h]);
    down.set(new V3(c.x, c.y, b.min.z + 0.001), new V3(0, 0, -1));
    const hit = down.intersectObjects([userRoot, spaceRoot], true).find(x => x.object.isMesh && visibleChain(x.object) && !own.has(holderFromObject(x.object)));
    const floor = hit ? hit.point.z : 0;
    h.position.z += floor - b.min.z; h.updateMatrixWorld(true);
  }
  endEdit('床に下ろす');
}
function cursorToSelected() { const b = new THREE.Box3(); for (const k of selected) b.expandByPoint(holderOf(k).position); if (!b.isEmpty()) setCursor(b.getCenter(new V3())); }
function selectedToCursor() {
  const keys = editableKeys(); if (!keys.length) return;
  beginEdit(keys); const c = new V3(); keys.forEach(k => c.add(holderOf(k).position)); c.divideScalar(keys.length);
  const d = cursor.pos.clone().sub(c); keys.forEach(k => holderOf(k).position.add(d)); endEdit('選択物を3Dカーソルへ');
}

// =====================================================================
// Modal transform: G / R / S  (Blender style)
// =====================================================================
let modal = null;
const guideLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8 }));
guideLine.renderOrder = 30; guideLine.visible = false; scene.add(guideLine);
let lastMouse = { clientX: 0, clientY: 0 }, ctrlDown = false;
const snapping = () => prefs.snap !== ctrlDown;

function startModal(type) {
  const keys = editableKeys(); if (!keys.length) return toast('オブジェクトを選択してください');
  if (modal) return;
  tc.detach();
  beginEdit(keys);
  const center = new V3(); keys.forEach(k => center.add(holderOf(k).getWorldPosition(new V3()))); center.divideScalar(keys.length);
  modal = { type, keys, center, mouse0: localXY(lastMouse), axis: null, plane: false, num: '',
    start: keys.map(k => { const h = holderOf(k); return { h, pos: h.position.clone(), quat: h.quaternion.clone(), scale: h.scale.clone() }; }),
    angAcc: 0, angPrev: null };
  modal.mouse = modal.mouse0;
  updateModal(); setHints();
}
function setModalAxis(a, plane) {
  if (modal.axis === a && modal.plane === plane) { modal.axis = null; modal.plane = false; }
  else { modal.axis = a; modal.plane = plane; }
  updateModal();
}
function updateModal() {
  const m = modal; if (!m) return;
  const c0 = toScreen(m.center), mouse = m.mouse;
  const inc = prefs.snapInc / 1000;
  let text = '', vcbVal = '';
  const num = m.num !== '' ? parseFloat(m.num) : null;
  // restore
  m.start.forEach(s => { s.h.position.copy(s.pos); s.h.quaternion.copy(s.quat); s.h.scale.copy(s.scale); });
  const axisVec = m.axis ? AXIS[m.axis].clone() : null;
  if (m.type === 'G') {
    let d = new V3();
    if (num != null && !isNaN(num)) {
      d.copy(axisVec && !m.plane ? axisVec : AXIS.x).multiplyScalar(num / 1000);
    } else if (axisVec && !m.plane) {
      const wpp = worldPerPixel(m.center), p1 = toScreen(m.center.clone().addScaledVector(axisVec, wpp * 100));
      const sv = new THREE.Vector2(p1.x - c0.x, p1.y - c0.y).divideScalar(wpp * 100);
      const md = new THREE.Vector2(mouse.x - m.mouse0.x, mouse.y - m.mouse0.y);
      let amt = sv.lengthSq() > 1e-6 ? md.dot(sv) / sv.lengthSq() : 0;
      if (snapping()) amt = Math.round(amt / inc) * inc;
      d.copy(axisVec).multiplyScalar(amt);
    } else if (axisVec && m.plane) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axisVec, m.center);
      const hit0 = rayPlane(m.mouse0, plane), hit1 = rayPlane(mouse, plane);
      if (hit0 && hit1) d.subVectors(hit1, hit0); d[m.axis] = 0;
      if (snapping()) d.set(Math.round(d.x / inc) * inc, Math.round(d.y / inc) * inc, Math.round(d.z / inc) * inc);
    } else {
      const wpp = worldPerPixel(m.center);
      d.addScaledVector(camRight(), (mouse.x - m.mouse0.x) * wpp).addScaledVector(camUp(), -(mouse.y - m.mouse0.y) * wpp);
      if (snapping()) d.set(Math.round(d.x / inc) * inc, Math.round(d.y / inc) * inc, Math.round(d.z / inc) * inc);
    }
    m.start.forEach(s => s.h.position.copy(s.pos).add(d));
    text = `移動  ${fmt(d.length())} mm  （X ${fmt(d.x)}　Y ${fmt(d.y)}　Z ${fmt(d.z)}）`; vcbVal = fmt(d.length()) + ' mm';
  } else if (m.type === 'R') {
    const viewAxis = new V3().subVectors(camera.position, m.center).normalize();
    if (nav.ortho) camera.getWorldDirection(viewAxis).negate();
    const ax = axisVec || viewAxis;
    const a = Math.atan2(-(mouse.y - c0.y), mouse.x - c0.x);
    if (m.angPrev == null) m.angPrev = Math.atan2(-(m.mouse0.y - c0.y), m.mouse0.x - c0.x);
    let da = a - m.angPrev; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    m.angAcc += da; m.angPrev = a;
    let ang = m.angAcc * (axisVec && axisVec.dot(viewAxis) < 0 ? -1 : 1);
    if (num != null && !isNaN(num)) ang = num * DEG;
    else if (snapping()) ang = Math.round(ang / (5 * DEG)) * 5 * DEG;
    const q = new THREE.Quaternion().setFromAxisAngle(ax, ang);
    m.start.forEach(s => { s.h.position.copy(s.pos).sub(m.center).applyQuaternion(q).add(m.center); s.h.quaternion.copy(q).multiply(s.quat); });
    text = `回転  ${(Math.round(ang / DEG * 100) / 100).toLocaleString('ja-JP')}°`; vcbVal = (Math.round(ang / DEG * 10) / 10) + '°';
  } else if (m.type === 'S') {
    const r0 = Math.max(4, Math.hypot(m.mouse0.x - c0.x, m.mouse0.y - c0.y));
    let f = Math.hypot(mouse.x - c0.x, mouse.y - c0.y) / r0;
    if (num != null && !isNaN(num)) f = num; else if (snapping()) f = Math.max(0.1, Math.round(f * 10) / 10);
    for (const s of m.start) {
      const fv = new V3(1, 1, 1);
      if (axisVec) {
        // scale the local axis that best matches the chosen global axis
        const local = [0, 1, 2].map(i => new V3().setFromMatrixColumn(new THREE.Matrix4().makeRotationFromQuaternion(s.quat), i));
        const pick = i => local.reduce((best, v, j) => Math.abs(v.dot(AXIS[i])) > Math.abs(local[best].dot(AXIS[i])) ? j : best, 0);
        if (m.plane) { for (const a of ['x', 'y', 'z']) if (a !== m.axis) fv.setComponent(pick(a), f); }
        else fv.setComponent(pick(m.axis), f);
      } else fv.setScalar(f);
      s.h.scale.copy(s.scale).multiply(fv);
      const off = s.pos.clone().sub(m.center);
      if (axisVec) { if (m.plane) { for (const a of ['x', 'y', 'z']) if (a !== m.axis) off[a] *= f; } else off[m.axis] *= f; } else off.multiplyScalar(f);
      s.h.position.copy(m.center).add(off);
    }
    text = `拡大縮小  ${f.toFixed(3)}`; vcbVal = f.toFixed(3);
  }
  if (m.axis) text += `　${m.plane ? m.axis.toUpperCase() + 'を除く平面' : 'グローバル ' + m.axis.toUpperCase() + ' 軸'}`;
  if (m.num !== '') text += `　［入力: ${m.num}${m.type === 'G' ? ' mm' : m.type === 'R' ? '°' : ''}］`;
  // guide line
  if (m.axis && !m.plane) {
    guideLine.geometry.setFromPoints([m.center.clone().addScaledVector(AXIS[m.axis], -500), m.center.clone().addScaledVector(AXIS[m.axis], 500)]);
    guideLine.material.color.set(AXIS_COLOR[m.axis]); guideLine.visible = true;
  } else guideLine.visible = false;
  m.start.forEach(s => s.h.updateMatrixWorld(true));
  $('modalText').textContent = text; $('modalText').classList.remove('hidden');
  setVCB({ G: '距離', R: '角度', S: '倍率' }[m.type], m.num !== '' ? m.num : vcbVal);
  liveEdit();
}
function rayPlane(pt, plane) {
  const r = viewport.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(pt.x / r.width * 2 - 1, -(pt.y / r.height) * 2 + 1), camera);
  return raycaster.ray.intersectPlane(plane, new V3());
}
function finishModal(cancel) {
  if (!modal) return;
  const label = { G: '移動', R: '回転', S: 'スケール' }[modal.type];
  modal = null; guideLine.visible = false;
  endEdit(label, cancel);
  $('modalText').classList.add('hidden');
  attachGizmo(); setHints(); requestRender();
}

// =====================================================================
// Gizmo tools (TransformControls)
// =====================================================================
let tool = 'select';
let gizmoStart = null;
function attachGizmo() {
  const mode = { move: 'translate', rotate: 'rotate', scale: 'scale' }[tool];
  const h = activeKey && holderOf(activeKey);
  if (mode && h && h.visible && !modal) { tc.setMode(mode); tc.attach(h); } else tc.detach();
  tc.setSpace(prefs.orient === 'local' ? 'local' : 'world');
  applyGizmoSnap(); requestRender();
}
function applyGizmoSnap() {
  const on = snapping();
  tc.setTranslationSnap(on ? prefs.snapInc / 1000 : null); tc.setRotationSnap(on ? 5 * DEG : null); tc.setScaleSnap(on ? 0.1 : null);
}
tc.addEventListener('change', requestRender);
tc.addEventListener('dragging-changed', e => {
  if (e.value) {
    const keys = editableKeys(); beginEdit(keys);
    const act = tc.object; act.updateMatrixWorld(true);
    gizmoStart = { inv: act.matrixWorld.clone().invert(), others: keys.map(holderOf).filter(h => h !== act).map(h => ({ h, m: h.matrixWorld.clone() })) };
  } else { gizmoStart = null; endEdit({ translate: '移動', rotate: '回転', scale: 'スケール' }[tc.getMode()]); }
});
tc.addEventListener('objectChange', () => {
  if (!gizmoStart) return;
  const act = tc.object; act.updateMatrixWorld(true);
  const delta = act.matrixWorld.clone().multiply(gizmoStart.inv);
  for (const { h, m } of gizmoStart.others) { new THREE.Matrix4().multiplyMatrices(delta, m).decompose(h.position, h.quaternion, h.scale); h.updateMatrixWorld(true); }
  liveEdit();
});

const TOOLS = [
  { id: 'select', tip: '選択（Space）', icon: '<path d="M4 2.5v10l2.8-2.6 1.9 4 1.7-.8-1.9-3.9H12z"/>' },
  { id: 'erase', tip: '消しゴム：クリックで削除（E）', icon: '<path d="M3 10.5 9 4l4 4-5.5 6H5zM6.5 14H14"/>' },
  'sep',
  { id: 'draw', tip: 'ボックスを描く：始点→対角→高さ（B）', icon: '<path d="M2.5 6 8 3l5.5 3v5L8 14l-5.5-3z"/><path d="M2.5 6 8 9l5.5-3M8 9v5"/>' },
  'sep',
  { id: 'move', tip: '移動（M／Gでマウス移動）', icon: '<path d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>' },
  { id: 'rotate', tip: '回転（Q／R）', icon: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5"/>' },
  { id: 'scale', tip: '尺度（S）', icon: '<path d="M2 7V2h5M14 9v5H9M2 2l5 5M14 14 9 9M9 2h5v5"/>' },
  'sep',
  { id: 'line', tip: 'ライン：床をクリックして点を打ち、ダブルクリックかEnterで終わる（L）', icon: '<path d="M2 12 6.5 6l3.5 4 4-6"/><circle cx="2" cy="12" r="1"/><circle cx="14" cy="4" r="1"/>' },
  { id: 'route', tip: '導線：人が歩く道すじを描く（P）', icon: '<circle cx="4" cy="3.5" r="1.3"/><path d="M4 6v4l-1.5 4M4 10l1.5 4M9 13.5h2.5a2 2 0 0 0 0-4H9a2 2 0 0 1 0-4h4"/>' },
  { id: 'measure', tip: 'メジャー：ドラッグで2点間を測る（T）', icon: '<path d="M2 11 11 2l3 3-9 9zM5 8l1.5 1.5M7 6l1.5 1.5M9 4l1.5 1.5"/>' },
  { id: 'cursor', tip: '3Dカーソルを置く（Shift+右クリックでも可）', icon: '<path d="M8 2.5 13.5 8 8 13.5 2.5 8z"/><circle cx="8" cy="8" r="1"/>' },
  'sep',
  { id: 'orbit', tip: 'オービット（O）', icon: '<ellipse cx="8" cy="8" rx="6" ry="2.6"/><path d="M8 2v12"/>' },
  { id: 'pan', tip: 'パン', icon: '<path d="M8 1.5v13M1.5 8h13M8 1.5 6.5 3M8 1.5 9.5 3M8 14.5 6.5 13M8 14.5l1.5-1.5M1.5 8 3 6.5M1.5 8 3 9.5M14.5 8 13 6.5M14.5 8 13 9.5"/>' },
  { id: 'zoom', tip: 'ズーム（Z）', icon: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>' },
  { id: 'extents', tip: '全体表示（Shift+Z／Home）', action: () => frameAll(), icon: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>' },
];
// only three tools on screen; the rest stay on their keys (G R S E O Z …)
const BAR_TOOLS = [['select', '選択・移動'], ['rotate', '回転'], ['draw', 'ボックス'], ['line', 'ライン'], ['route', '導線'], ['measure', '測る'], ['erase', '消しゴム']];
function renderToolbar() {
  $('toolbar').innerHTML = BAR_TOOLS.map(([id, label]) => { const t = TOOLS.find(x => x.id === id);
    return `<button class="tool ${tool === id ? 'on' : ''}" data-tool="${id}" title="${t.tip}"><svg class="i" viewBox="0 0 16 16">${t.icon}</svg><span class="t">${label}</span></button>`; }).join('');
  $('toolbar').querySelectorAll('.tool').forEach(b => b.onclick = () => { const t = TOOLS.find(x => x.id === b.dataset.tool); t.action ? t.action() : setTool(t.id); });
}
function setTool(t) {
  if (draw) cancelDraw();
  if (poly) { poly = null; updatePolyPreview(); }
  tool = t; renderToolbar(); attachGizmo(); setHints();
  renderer.domElement.style.cursor = { measure: 'crosshair', cursor: 'crosshair', draw: 'crosshair', erase: 'not-allowed', orbit: 'grab', pan: 'move', zoom: 'zoom-in' }[t] || 'default';
  if (t === 'measure') { rightTab = 'measure'; scheduleUI(); }
  setVCB(VCB_LABEL[t] || '距離', '');
  $('snapMark').classList.add('hidden');
}

// =====================================================================
// Look: sky & ground, black edges, grid, light/dark theme
// =====================================================================
const THEMES = {
  light: { zenith: '#9fc3e7', horizon: '#eef2f4', ground: '#d8d3c8', groundFar: '#c7c1b4', ruler: 0x222222, sel: 0x8e8ef5, act: 0x3d3dd0, grid: [0xb4afa4, 0xc9c4ba] },
  dark: { zenith: '#1c2028', horizon: '#3a3f48', ground: '#2d2e31', groundFar: '#232427', ruler: 0xffffff, sel: 0x8e8ef5, act: 0xc8c8ff, grid: [0x4a4e55, 0x3a3e44] },
};
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, depthTest: false,
  uniforms: { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() }, groundFar: { value: new THREE.Color() } },
  vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 zenith, horizon, ground, groundFar; varying vec3 vDir;
    void main() { float z = vDir.z; vec3 c = z > 0.0 ? mix(horizon, zenith, pow(z, 0.55)) : mix(ground, groundFar, pow(-z, 0.6)); gl_FragColor = vec4(c, 1.0); }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), skyMat);
sky.renderOrder = -10; sky.frustumCulled = false; sky.raycast = () => {}; scene.add(sky);
const spaceEdgeMat = new THREE.LineBasicMaterial({ color: 0x1b1b1b, transparent: true, opacity: 0.5, clippingPlanes: [clipPlane] });
const spaceEdges = [];
function applyLook() {
  const t = THEMES[prefs.theme] || THEMES.light;
  document.documentElement.dataset.theme = prefs.theme;
  for (const k of ['zenith', 'horizon', 'ground', 'groundFar']) skyMat.uniforms[k].value.set(t[k]);
  sky.visible = prefs.sky && !planMode;
  scene.background = planMode ? new THREE.Color(0xfbfaf8) : prefs.sky ? null : new THREE.Color(prefs.theme === 'dark' ? 0x2a2c30 : 0xe6e3dd);
  rulerMat.color.set(t.ruler); dotMat.color.set(t.ruler);
  outlineSel.visibleEdgeColor.set(t.sel); outlineSel.hiddenEdgeColor.set(t.sel).multiplyScalar(0.4);
  outlineAct.visibleEdgeColor.set(t.act); outlineAct.hiddenEdgeColor.set(t.act).multiplyScalar(0.4);
  for (const l of spaceEdges) l.visible = prefs.edges;
  const grid = helperRoot.getObjectByName('grid'); if (grid) grid.visible = prefs.grid;
  requestRender(); scheduleUI();
}
function toggleTheme() { prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyLook(); }

// =====================================================================
// Plan view: flat top-down drawing; the space is cut at 1.5 m and cut walls read as solid black
// =====================================================================
let planMode = false, nav3d = null;
const planFill = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, clippingPlanes: [clipPlane], polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
planFill.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  if (!gl_FrontFacing) gl_FragColor = vec4(vec3(0.05), 1.0);'); };
const planFloor = new THREE.MeshBasicMaterial({ color: 0xefede7, clippingPlanes: [clipPlane], polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
function setPlanMode(on) {
  if (on === planMode) return;
  planMode = on; document.body.classList.toggle('plan', on);
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', (b.dataset.view === 'plan') === on));
  for (const m of spaceMeshes) {
    // floors would hide the wall bottoms seen from above, so the plan is drawn on plain paper instead
    const floor = holderFromObject(m)?.userData.role === 'floor';
    if (on) { m.userData.mat3d = m.material; m.material = planFill; if (floor) m.visible = false; }
    else { if (m.userData.mat3d) m.material = m.userData.mat3d; m.visible = true; }
  }
  helperRoot.visible = !on;
  if (on) {
    nav3d = navSnapshot();
    // same orientation as the venue drawing: corridor on the left, gallery on the right
    nav.yaw = Math.PI; nav.pitch = Math.PI / 2; nav.ortho = true; nav.autoOrtho = false; nav.preset = 'top';
    nav.target.set(4, -14, 0);
    const half = Math.max(64 * viewport.clientHeight / Math.max(1, viewport.clientWidth), 16);
    nav.dist = half / Math.tan(persp.fov * DEG / 2);
  } else if (nav3d) {
    nav.target.fromArray(nav3d.target); Object.assign(nav, { dist: nav3d.dist, yaw: nav3d.yaw, pitch: nav3d.pitch, ortho: nav3d.ortho, preset: nav3d.preset }); persp.fov = nav3d.fov;
  }
  applyClip(); applyLook(); updateCamera(); setHints();
}
document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => setPlanMode(b.dataset.view === 'plan'));

// =====================================================================
// Measurements box (bottom right, like a value control box)
// =====================================================================
function setVCB(label, value) { $('vcbL').textContent = label; $('vcbV').textContent = value ?? ''; }
const VCB_LABEL = { draw: '寸法', measure: '長さ', move: '距離', rotate: '角度', scale: '倍率' };

// =====================================================================
// Box drawing tool: click a corner → click the opposite corner → pull up the height → click
// =====================================================================
let draw = null;
const drawPreview = new THREE.Group(); drawPreview.visible = false; scene.add(drawPreview);
{
  const m = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: 0x5b5bd6, transparent: true, opacity: 0.22, depthWrite: false }));
  const l = new THREE.LineSegments(boxEdges, new THREE.LineBasicMaterial({ color: 0x3d3dd0 }));
  m.raycast = l.raycast = () => {};
  drawPreview.add(m, l);
  const el = document.createElement('div'); el.className = 'lbl3d sel';
  drawPreview.userData.label = new CSS2DObject(el); drawPreview.userData.label.visible = false; scene.add(drawPreview.userData.label);
}
const INFER = ['vertex', 'mid', 'edge', 'cursor'];
function drawRect() {
  const a = draw.p0, b = draw.p1;
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, w: Math.abs(b.x - a.x), d: Math.abs(b.y - a.y) };
}
function updateDrawPreview() {
  const lbl = drawPreview.userData.label;
  if (!draw) { drawPreview.visible = false; lbl.visible = false; requestRender(); return; }
  const r = drawRect(), h = draw.phase === 2 ? draw.h : 0;
  drawPreview.visible = true; lbl.visible = true;
  drawPreview.position.set(r.cx, r.cy, draw.p0.z);
  drawPreview.scale.set(Math.max(r.w, 0.001), Math.max(r.d, 0.001), Math.max(h, 0.002));
  lbl.position.set(r.cx, r.cy, draw.p0.z + h + 0.01);
  lbl.element.textContent = draw.phase === 1 ? `${fmt(r.w)} × ${fmt(r.d)}` : `${fmt(r.w)} × ${fmt(r.d)} × ${fmt(h)}`;
  setVCB(draw.phase === 1 ? '寸法' : '高さ', draw.num !== '' ? draw.num : draw.phase === 1 ? `${fmt(r.w)}, ${fmt(r.d)}` : fmt(h));
  requestRender();
}
function drawMove(e) {
  const inc = prefs.snapInc / 1000;
  if (draw.phase === 1) {
    const s = snapSurface(e, snapping());
    const inferred = s && INFER.includes(s.kind);
    const p = inferred ? s.p.clone() : groundPoint(e, draw.p0.z);
    if (!p) return;
    showSnapMark(inferred ? s : null);
    p.z = draw.p0.z;
    if (snapping() && !inferred) { p.x = draw.p0.x + Math.round((p.x - draw.p0.x) / inc) * inc; p.y = draw.p0.y + Math.round((p.y - draw.p0.y) / inc) * inc; }
    draw.p1 = p;
  } else {
    const m = localXY(e), r = drawRect(), c = new V3(r.cx, r.cy, draw.p0.z);
    const wpp = worldPerPixel(c), c0 = toScreen(c), c1 = toScreen(c.clone().add(new V3(0, 0, wpp * 100)));
    const sv = new THREE.Vector2(c1.x - c0.x, c1.y - c0.y).divideScalar(wpp * 100);
    const md = new THREE.Vector2(m.x - draw.m0.x, m.y - draw.m0.y);
    let h = sv.lengthSq() > 1e-6 ? md.dot(sv) / sv.lengthSq() : 0;
    const s = snapping() ? snapSurface(e, true) : null;
    if (s && (s.kind === 'vertex' || s.kind === 'mid') && s.p.z > draw.p0.z + 0.001) { h = s.p.z - draw.p0.z; showSnapMark(s); }   // pull up to a hovered point's height
    else { $('snapMark').classList.add('hidden'); if (snapping()) h = Math.round(h / inc) * inc; }
    draw.h = Math.max(0.001, h);
  }
  updateDrawPreview();
}
function drawClick(e) {
  if (!draw) {
    const s = snapSurface(e, snapping()); if (!s) return;
    draw = { phase: 1, p0: s.p.clone(), p1: s.p.clone(), h: 0, num: '' };
    updateDrawPreview(); setHints(); return;
  }
  if (draw.phase === 1) { const r = drawRect(); if (r.w < 0.001 || r.d < 0.001) return; enterHeight(); return; }
  finishDraw();
}
function enterHeight() { draw.phase = 2; draw.m0 = localXY(lastMouse); draw.h = 0.001; draw.num = ''; updateDrawPreview(); setHints(); }
function finishDraw() {
  const r = drawRect(), h = draw.h, z = draw.p0.z;
  cancelDraw();
  const id = rid();
  prefs.boxW = Math.round(r.w * 1000); prefs.boxD = Math.round(r.d * 1000); prefs.boxH = Math.round(h * 1000); savePrefs();
  commit([{ c: 'objects', id, v: newEntity({ type: 'box', name: nextName('ボックス'), loc: [r.cx, r.cy, z], scale: [r.w, r.d, h], color: '#f2f0ea' }) }], 'ボックスを描く');
  setSelection(['objects:' + id], 'objects:' + id);
  showLastOp('ボックスを描く', [
    numDef('幅 X', () => store.objects[id]?.scale[0] * 1000, val => resizeEntity(id, 0, val)),
    numDef('奥行 Y', () => store.objects[id]?.scale[1] * 1000, val => resizeEntity(id, 1, val)),
    numDef('高さ Z', () => store.objects[id]?.scale[2] * 1000, val => resizeEntity(id, 2, val)),
  ]);
  setVCB('寸法', `${fmt(r.w)}, ${fmt(r.d)}, ${fmt(h)}`);
}
function cancelDraw() { draw = null; updateDrawPreview(); $('snapMark').classList.add('hidden'); setHints(); }
function drawKey(e) {
  if (/^[0-9.]$/.test(e.key) || e.key === ',' || e.key === '、' || e.key === '-') { draw.num += e.key === '、' ? ',' : e.key; updateDrawPreview(); return true; }
  if (e.code === 'Backspace') { draw.num = draw.num.slice(0, -1); updateDrawPreview(); return true; }
  if (e.code === 'Escape') { cancelDraw(); return true; }
  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    const parts = draw.num.split(',').map(x => parseFloat(x));
    if (draw.phase === 1) {
      if (parts.length >= 2 && parts.slice(0, 2).every(x => x > 0)) {
        const sx = Math.sign(draw.p1.x - draw.p0.x) || 1, sy = Math.sign(draw.p1.y - draw.p0.y) || 1;
        draw.p1 = draw.p0.clone().add(new V3(sx * parts[0] / 1000, sy * parts[1] / 1000, 0));
        if (parts[2] > 0) { draw.phase = 2; draw.h = parts[2] / 1000; finishDraw(); }
        else enterHeight();
      } else { draw.num = ''; updateDrawPreview(); toast('「幅,奥行」または「幅,奥行,高さ」の形で入力してください（例 900,450,900）', 3000); }
    } else {
      if (parts[0] > 0) draw.h = parts[0] / 1000;
      finishDraw();
    }
    return true;
  }
  return false;
}

// =====================================================================
// Scenes: saved viewpoints shared with everyone
// =====================================================================
function navSnapshot() { return { target: nav.target.toArray(), dist: nav.dist, yaw: nav.yaw, pitch: nav.pitch, ortho: nav.ortho, preset: nav.preset, fov: persp.fov }; }
function addScene() {
  const id = rid(), n = Object.keys(store.scenes).length + 1;
  commit([{ c: 'scenes', id, v: { name: `シーン ${n}`, view: navSnapshot(), created: Date.now(), by: prefs.name } }], 'シーンを追加');
  activeScene = id; scheduleUI(); toast('今の視点をシーンとして保存しました');
}
function updateScene(id) { const s = store.scenes[id]; if (s) commit([{ c: 'scenes', id, v: { ...s, view: navSnapshot() } }], 'シーンを更新'); }
async function renameScene(id) { const s = store.scenes[id]; if (!s) return; const n = await askText('シーンの名前', s.name); if (n && n.trim()) commit([{ c: 'scenes', id, v: { ...s, name: n.trim() } }], 'シーン名を変更'); }
let sceneAnim = 0;
function goScene(id) {
  const s = store.scenes[id]; if (!s) return;
  const from = navSnapshot(), to = s.view, t0 = performance.now(), dur = 450;
  const dyaw = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));
  nav.ortho = to.ortho; nav.autoOrtho = false;
  cancelAnimationFrame(sceneAnim);
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / dur), q = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    nav.target.fromArray(from.target).lerp(new V3(...to.target), q);
    nav.dist = from.dist + (to.dist - from.dist) * q; nav.yaw = from.yaw + dyaw * q; nav.pitch = from.pitch + (to.pitch - from.pitch) * q;
    persp.fov = from.fov + ((to.fov || from.fov) - from.fov) * q;
    nav.preset = k >= 1 ? to.preset : null; updateCamera();
    if (k < 1) sceneAnim = requestAnimationFrame(step); else { activeScene = id; scheduleUI(); }
  };
  step();
}
function renderSceneTabs() {
  const el = $('sceneTabs'); el.innerHTML = '';
  const list = Object.entries(store.scenes).sort((a, b) => (a[1].created || 0) - (b[1].created || 0));
  for (const [id, sc] of list) {
    const b = document.createElement('button'); b.className = 'stab' + (id === activeScene ? ' on' : ''); b.textContent = sc.name;
    b.title = 'クリックで移動／ダブルクリックで名前変更／右クリックでメニュー';
    b.onclick = () => goScene(id); b.ondblclick = () => renameScene(id);
    b.oncontextmenu = e => { e.preventDefault(); openMenu([{ label: 'この視点で上書き', action: () => updateScene(id) }, { label: '名前を変更', action: () => renameScene(id) }, '-', { label: '削除', action: () => commit([{ c: 'scenes', id, v: null }], 'シーンを削除') }], e.clientX, e.clientY, sc.name); };
    el.appendChild(b);
  }
  const add = document.createElement('button'); add.className = 'stab add'; add.textContent = '＋ シーン'; add.title = '今の視点をシーンとして保存（全員と共有）'; add.onclick = addScene;
  el.appendChild(add);
}

// =====================================================================
// Floor lines (tape / sign lines) and visitor routes: drawn as polylines on the floor
// =====================================================================
const LINE_COLORS = ['#f2c200', '#ffffff', '#3a3936', '#d6453d', '#3e7bfa', '#2fa36b'];
function polyLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
function ribbonGeometry(points, w, z = 0.003) {
  const pos = [], idx = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i], [bx, by] = points[i + 1];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy); if (L < 1e-6) continue;
    const nx = -dy / L * w / 2, ny = dx / L * w / 2, ex = dx / L * w / 2, ey = dy / L * w / 2;   // extended by w/2 so corners close
    const k = pos.length / 3;
    pos.push(ax - ex + nx, ay - ey + ny, z, bx + ex + nx, by + ey + ny, z, bx + ex - nx, by + ey - ny, z, ax - ex - nx, ay - ey - ny, z);
    idx.push(k, k + 3, k + 2, k, k + 2, k + 1);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function arrowGeometry(points, step = 1.6, z = 0.005) {
  const pos = [], L = polyLength(points);
  for (let d = step / 2; d < L; d += step) {
    const { p, dir } = pointAlong(points, d);
    const n = [-dir[1], dir[0]];
    pos.push(p[0] + dir[0] * 0.28, p[1] + dir[1] * 0.28, z, p[0] - dir[0] * 0.14 + n[0] * 0.2, p[1] - dir[1] * 0.14 + n[1] * 0.2, z, p[0] - dir[0] * 0.14 - n[0] * 0.2, p[1] - dir[1] * 0.14 - n[1] * 0.2, z);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}
function pointAlong(points, d) {
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i], L = Math.hypot(bx - ax, by - ay);
    if (d <= L || i === points.length - 1) { const t = L > 0 ? Math.min(1, Math.max(0, d / L)) : 0; return { p: [ax + (bx - ax) * t, ay + (by - ay) * t], dir: L > 0 ? [(bx - ax) / L, (by - ay) / L] : [1, 0] }; }
    d -= L;
  }
  return { p: points[0], dir: [1, 0] };
}

// drawing: click points, double-click / Enter to finish, Backspace removes the last point, Esc cancels
let poly = null;
const polyLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x5b5bd6, depthTest: false, transparent: true }));
polyLine.renderOrder = 25; polyLine.visible = false; scene.add(polyLine);
function polyPoint(e) {
  const s = snapSurface(e, snapping()); if (!s) return null;
  let p = s.p.clone(); if (poly) p.z = poly.z;
  if (poly && poly.pts.length) {
    const last = poly.pts[poly.pts.length - 1];
    if (e.shiftKey) { if (Math.abs(p.x - last.x) > Math.abs(p.y - last.y)) p.y = last.y; else p.x = last.x; }   // straight along X or Y
    else if (snapping() && !['vertex', 'mid', 'edge'].includes(s.kind)) {
      const inc = prefs.snapInc / 1000, d = p.clone().sub(last), L = Math.round(Math.hypot(d.x, d.y) / inc) * inc, a = Math.atan2(d.y, d.x);
      p.set(last.x + Math.cos(a) * L, last.y + Math.sin(a) * L, p.z);
    }
  }
  return { p, s };
}
function updatePolyPreview() {
  if (!poly) { polyLine.visible = false; requestRender(); return; }
  const pts = [...poly.pts, ...(poly.cursor ? [poly.cursor] : [])].map(p => p.clone().setZ(p.z + 0.01));
  polyLine.geometry.dispose(); polyLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  polyLine.material.color.set(poly.kind === 'route' ? 0x5b5bd6 : 0xd4a800); polyLine.visible = pts.length > 1;
  const L = polyLength(pts.map(p => [p.x, p.y]));
  setVCB('長さ', fmt(L) + ' mm'); requestRender();
}
function polyClick(e) {
  const r = polyPoint(e); if (!r) return;
  if (!poly) poly = { kind: tool, pts: [], z: r.p.z };
  r.p.z = poly.z;
  if (poly.pts.length && r.p.distanceTo(poly.pts[poly.pts.length - 1]) < 0.03) return finishPoly();   // second click on the same spot = finish
  poly.pts.push(r.p); updatePolyPreview(); setHints();
}
function polyMove(e) {
  const r = polyPoint(e); showSnapMark(r?.s);
  if (poly && r) { poly.cursor = r.p; updatePolyPreview(); }
}
function finishPoly() {
  const p = poly; poly = null; updatePolyPreview(); $('snapMark').classList.add('hidden'); setHints();
  if (!p || p.pts.length < 2) return;
  const o = p.pts[0], id = rid(), isRoute = p.kind === 'route';
  const v = newEntity({ type: p.kind, name: nextName(isRoute ? '導線' : 'ライン'), loc: [o.x, o.y, p.z], points: p.pts.map(q => [q.x - o.x, q.y - o.y]),
    width: isRoute ? 0.5 : 0.05, color: isRoute ? '#5b5bd6' : '#f2c200', opacity: isRoute ? 0.35 : 1, speed: 1.0, people: 5, interval: 3 });
  commit([{ c: 'objects', id, v }], isRoute ? '導線を描く' : 'ラインを引く');
  setSelection(['objects:' + id], 'objects:' + id);
}
function polyKey(e) {
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { finishPoly(); return true; }
  if (e.code === 'Escape') { poly = null; updatePolyPreview(); setHints(); return true; }
  if (e.code === 'Backspace' || e.code === 'Delete') { poly.pts.pop(); if (!poly.pts.length) poly = null; updatePolyPreview(); return true; }
  return false;
}
function buildPolyShape(h, v) {
  const ribbon = new THREE.Mesh(ribbonGeometry(v.points, v.width ?? 0.05), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  ribbon.userData.own = true; ribbon.userData.tint = true; h.add(ribbon);
  // a hairline on top keeps thin tape lines visible when zoomed out
  const hair = new THREE.Line(new THREE.BufferGeometry().setFromPoints(v.points.map(([x, y]) => new V3(x, y, 0.006))), new THREE.LineBasicMaterial());
  hair.userData.tintColorOnly = true; hair.raycast = () => {}; h.add(hair);
  if (v.type === 'route') {
    const arrows = new THREE.Mesh(arrowGeometry(v.points), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    arrows.userData.own = true; arrows.userData.tintColorOnly = true; h.add(arrows);
  }
  const b = new THREE.Box3(); for (const [x, y] of v.points) b.expandByPoint(new V3(x, y, 0)); b.expandByScalar((v.width ?? 0.05) / 2); b.max.z = 0.01; b.min.z = 0;
  h.userData.baseBox = b;
}

// =====================================================================
// Visitor flow: people walk along a route; you can ride along at eye height
// =====================================================================
const sim = { id: null, playing: false, t: 0, last: 0, follow: false, lookYaw: 0, lookPitch: 0, saved: null, fwd: null };
const walkers = new THREE.Group(); scene.add(walkers);
const walkerGeo = new THREE.CapsuleGeometry(0.22, 1.24, 4, 12).rotateX(Math.PI / 2).translate(0, 0, 0.85);
const noseGeo = new THREE.BoxGeometry(0.12, 0.1, 0.1).translate(0.24, 0, 1.55);
function routeWorld(id) {
  const v = store.objects[id], h = userHolders.get(id); if (!v || !h) return null;
  h.updateMatrixWorld(true);
  return { pts: v.points.map(([x, y]) => { const p = new V3(x, y, 0).applyMatrix4(h.matrixWorld); return [p.x, p.y]; }), z: h.position.z, v };
}
function startSim(id, follow = false) {
  stopSim(true);
  const v = store.objects[id]; if (!v) return;
  sim.id = id; sim.playing = true; sim.t = 0; sim.last = performance.now();
  const n = Math.max(1, Math.min(30, Math.round(v.people || 1)));
  for (let i = 0; i < n; i++) {
    const g = new THREE.Group(), mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(v.color || '#5b5bd6').offsetHSL(0, 0, (i % 3) * 0.08 - 0.05), roughness: 0.6 });
    g.add(new THREE.Mesh(walkerGeo, mat), new THREE.Mesh(noseGeo, mat)); g.visible = false; walkers.add(g);
  }
  if (follow) enterFollow();
  requestAnimationFrame(simLoop); scheduleUI();
}
function stopSim(quiet) {
  if (sim.follow) exitFollow();
  sim.playing = false; sim.id = null;
  walkers.children.slice().forEach(g => { g.children[0].material.dispose(); g.removeFromParent(); });
  requestRender(); if (!quiet) scheduleUI();
}
function enterFollow() {
  if (planMode) setPlanMode(false);
  sim.saved = navSnapshot(); sim.follow = true; sim.lookYaw = 0; sim.lookPitch = 0; sim.fwd = null;
  nav.ortho = false; toast('この人の目線で歩いています：ドラッグで見回す／Escで終わる', 4000); setHints();
}
function exitFollow() {
  sim.follow = false;
  if (sim.saved) { nav.target.fromArray(sim.saved.target); Object.assign(nav, { dist: sim.saved.dist, yaw: sim.saved.yaw, pitch: sim.saved.pitch, ortho: sim.saved.ortho, preset: sim.saved.preset }); updateCamera(); }
  setHints(); scheduleUI();
}
function simLoop(now) {
  if (!sim.playing) return;
  const r = routeWorld(sim.id); if (!r || r.pts.length < 2) { stopSim(); return; }
  const dt = Math.min(0.1, (now - sim.last) / 1000); sim.last = now; sim.t += dt;
  const L = polyLength(r.pts), speed = Math.max(0.1, r.v.speed || 1), gap = Math.max(0.2, r.v.interval || 3);
  walkers.children.forEach((g, i) => {
    const d = (sim.t - i * gap) * speed;
    if (d < 0) { g.visible = false; return; }
    const { p, dir } = pointAlong(r.pts, d % L);
    g.visible = !(sim.follow && i === 0);
    g.position.set(p[0], p[1], r.z); g.rotation.z = Math.atan2(dir[1], dir[0]);
  });
  if (sim.follow) {
    const d = (sim.t * speed) % L, { p } = pointAlong(r.pts, d), ahead = pointAlong(r.pts, Math.min(L, d + 1.2));
    const want = new V3(ahead.p[0] - p[0], ahead.p[1] - p[1], 0); if (want.lengthSq() < 1e-6) want.set(...pointAlong(r.pts, d).dir, 0);
    want.normalize(); sim.fwd = sim.fwd ? sim.fwd.lerp(want, 0.08).normalize() : want;
    const yaw = Math.atan2(sim.fwd.y, sim.fwd.x) + sim.lookYaw, f = new V3(Math.cos(yaw) * Math.cos(sim.lookPitch), Math.sin(yaw) * Math.cos(sim.lookPitch), Math.sin(sim.lookPitch));
    const eye = new V3(p[0], p[1], r.z + prefs.eye / 1000);
    nav.dist = 0.3; nav.yaw = Math.atan2(-f.y, -f.x); nav.pitch = Math.asin(-f.z); nav.target.copy(eye).addScaledVector(f, nav.dist); updateCamera();
  }
  requestRender(); requestAnimationFrame(simLoop);
}

// =====================================================================
// Three-view drawings (front / right side / top) → 3D model by silhouette carving
// =====================================================================
async function fileToCanvas(file, max = 900) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
// foreground = anything that differs clearly from the background colour sampled at the corners (or is opaque on transparent)
function silhouette(c) {
  const { width: w, height: h } = c, d = c.getContext('2d').getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
  let br = 0, bg = 0, bb = 0, n = 0, transparent = false;
  for (const [x0, y0] of [[0, 0], [w - 6, 0], [0, h - 6], [w - 6, h - 6]]) for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) { const i = (y * w + x) * 4; if (d[i + 3] < 128) transparent = true; br += d[i]; bg += d[i + 1]; bb += d[i + 2]; n++; }
  br /= n; bg /= n; bb /= n;
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3];
    mask[i] = transparent ? a > 128 : a > 128 && Math.hypot(d[i * 4] - br, d[i * 4 + 1] - bg, d[i * 4 + 2] - bb) > 48;
  }
  return { w, h, mask, rgb: d };
}
function cropView(c, sil, box) {
  const [x0, y0, x1, y1] = box || bboxOf(sil); if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0, h = y1 - y0, out = { w, h, mask: new Uint8Array(w * h), rgb: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y + y0) * sil.w + x + x0, di = y * w + x; out.mask[di] = sil.mask[si];
    for (let k = 0; k < 4; k++) out.rgb[di * 4 + k] = sil.rgb[si * 4 + k];
  }
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h); out.thumb = cv.toDataURL();
  return out;
}
function bboxOf(sil, region) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; const [rx0, ry0, rx1, ry1] = region || [0, 0, sil.w, sil.h];
  for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) if (sil.mask[y * sil.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1 + 1, y1 + 1];
}
// one sheet with three views: find the three biggest blobs; the pair side by side is front (left) + side (right), the other one is the top view
function splitSheet(c) {
  const sil = silhouette(c), { w, h } = sil, grown = new Uint8Array(w * h), R = Math.max(2, Math.round(Math.max(w, h) / 120));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sil.mask[y * w + x])
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) grown[Y * w + X] = 1; }
  const lab = new Int32Array(w * h), blobs = [];
  for (let i = 0; i < w * h; i++) {
    if (!grown[i] || lab[i]) continue;
    const id = blobs.length + 1, st = [i]; lab[i] = id; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, area = 0;
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - w, j + w]) if (k >= 0 && k < w * h && grown[k] && !lab[k] && Math.abs((k % w) - x) <= 1) { lab[k] = id; st.push(k); }
    }
    blobs.push({ area, box: [x0, y0, x1 + 1, y1 + 1], cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }
  const big = blobs.sort((a, b) => b.area - a.area).slice(0, 3);
  if (big.length < 3) throw new Error('図が3つ見つかりませんでした。正面・側面・上面を別々に入れてください。');
  let best = null;
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) { const dy = Math.abs(big[a].cy - big[b].cy); if (!best || dy < best.dy) best = { dy, pair: [big[a], big[b]], other: big[3 - a - b] }; }
  const [L, Rr] = best.pair.sort((a, b) => a.cx - b.cx);
  const tight = blob => bboxOf(sil, blob.box);
  return { front: cropView(c, sil, tight(L)), side: cropView(c, sil, tight(Rr)), top: cropView(c, sil, tight(best.other)) };
}
function carve(views, W, D, H, N) {
  const s = Math.max(W, D, H) / N, nx = Math.max(1, Math.round(W / s)), ny = Math.max(1, Math.round(D / s)), nz = Math.max(1, Math.round(H / s));
  const inside = (v, u, t) => { if (!v) return true; const x = Math.min(v.w - 1, Math.max(0, (u * v.w) | 0)), y = Math.min(v.h - 1, Math.max(0, (t * v.h) | 0)); return v.mask[y * v.w + x]; };
  const vox = new Uint8Array(nx * ny * nz), at = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && vox[(k * ny + j) * nx + i];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const u = (i + .5) / nx, w = (j + .5) / ny, z = (k + .5) / nz;
    if (inside(views.front, u, 1 - z) && inside(views.side, w, 1 - z) && inside(views.top, u, 1 - w)) vox[(k * ny + j) * nx + i] = 1;
  }
  const color = (v, u, t) => { if (!v) return [0.78, 0.76, 0.72]; const x = Math.min(v.w - 1, (u * v.w) | 0), y = Math.min(v.h - 1, (t * v.h) | 0), q = (y * v.w + x) * 4; return [v.rgb[q] / 255, v.rgb[q + 1] / 255, v.rgb[q + 2] / 255]; };
  const pos = [], col = [], sx = W / nx, sy = D / ny, sz = H / nz;
  const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!vox[(k * ny + j) * nx + i]) continue;
    for (const [fx, fy, fz] of FACES) {
      if (at(i + fx, j + fy, k + fz)) continue;
      const u = (i + .5) / nx, w = (j + .5) / ny, z = (k + .5) / nz;
      // blend the three views by the surface direction estimated from neighbouring voxels, so curved sides do not stripe
      let gx = 0, gy = 0, gz = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!at(i + dx, j + dy, k + dz)) { gx += dx; gy += dy; gz += dz; }
      let gl = Math.hypot(gx, gy, gz); if (gl < 1e-6) { gx = fx; gy = fy; gz = fz; gl = 1; }
      const wf = Math.abs(gy) / gl, ws = Math.abs(gx) / gl, wt = Math.abs(gz) / gl, ws_ = wf + ws + wt || 1;
      const cf = color(views.front, u, 1 - z), cs = color(views.side, w, 1 - z), ct = color(views.top, u, 1 - w);
      const c = [0, 1, 2].map(n => (cf[n] * wf + cs[n] * ws + ct[n] * wt) / ws_);
      // face quad corners in voxel space
      const cx = i + .5 + fx * .5, cy = j + .5 + fy * .5, cz = k + .5 + fz * .5;
      const a = fx ? [0, 1, 0] : [1, 0, 0], b = fz ? [0, 1, 0] : [0, 0, 1];
      const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([m, n]) => [(cx + (a[0] * m + b[0] * n) * .5) * sx - W / 2, (cy + (a[1] * m + b[1] * n) * .5) * sy - D / 2, (cz + (a[2] * m + b[2] * n) * .5) * sz]);
      const flip = (fx + fy + fz) * ((fx ? 1 : 0) + (fz ? 1 : 0) - (fy ? 1 : 0)) < 0;
      const tri = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (const t of tri) { pos.push(...q[t]); col.push(...c); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
function threeViewDialog() {
  const views = { front: null, side: null, top: null };
  const bg = document.createElement('div'); bg.className = 'dialog-bg';
  bg.innerHTML = `<div class="dialog tv-dialog">
    <h3>三面図から3Dモデルを作る</h3>
    <p class="note">三面図を1枚まとめて入れると、自動で正面・側面・上面に切り分けます（第三角法：上面は正面の上、右側面は正面の右）。別々の画像なら、それぞれの枠に入れてください。背景は白か透明にしてください。</p>
    <div class="tv-sheet" data-slot="sheet">三面図1枚をここにドロップ（またはクリック）</div>
    <div class="tv-grid">
      <div class="tv-slot" data-slot="top"><b>上面図</b><span>ドロップ／クリック</span></div>
      <div class="tv-slot" data-slot="front"><b>正面図</b><span>ドロップ／クリック</span></div>
      <div class="tv-slot" data-slot="side"><b>右側面図</b><span>ドロップ／クリック</span></div>
    </div>
    <div class="tv-dims">
      <label>高さ（mm）<input class="tf" id="tvH" value="1000"></label>
      <label>幅（mm）<input class="tf" id="tvW" value=""></label>
      <label>奥行（mm）<input class="tf" id="tvD" value=""></label>
      <label>細かさ <select class="sf" id="tvN"><option value="64">標準</option><option value="96">細かい</option><option value="128">とても細かい</option></select></label>
    </div>
    <div class="note">幅と奥行は、高さと図の縦横比から自動で計算します（数字を直すこともできます）。</div>
    <div class="btns" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-r="0">キャンセル</button><button class="btn primary" data-r="1" disabled>3Dモデルを作る</button></div>
  </div>`;
  const $$ = s => bg.querySelector(s), make = $$('[data-r="1"]');
  const pick = () => new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => res(i.files[0]); i.click(); });
  const ratio = v => v ? v.w / v.h : null;
  let manualW = false, manualD = false;
  const recalc = () => {
    const H = parseFloat($$('#tvH').value) || 1000;
    if (!manualW && ratio(views.front)) $$('#tvW').value = Math.round(H * ratio(views.front));
    if (!manualD && ratio(views.side)) $$('#tvD').value = Math.round(H * ratio(views.side));
    else if (!manualD && ratio(views.top) && parseFloat($$('#tvW').value)) $$('#tvD').value = Math.round(parseFloat($$('#tvW').value) / ratio(views.top));
    make.disabled = !(views.front || views.side || views.top);
  };
  const show = () => {
    for (const k of ['front', 'side', 'top']) { const el = $$(`[data-slot="${k}"]`); el.classList.toggle('on', !!views[k]); el.style.backgroundImage = views[k] ? `url(${views[k].thumb})` : ''; }
    recalc();
  };
  const take = async (slot, file) => {
    if (!file) return;
    try {
      const c = await fileToCanvas(file);
      if (slot === 'sheet') Object.assign(views, splitSheet(c));
      else { const sil = silhouette(c); views[slot] = cropView(c, sil); }
      show();
    } catch (err) { toast(err.message, 4000); }
  };
  bg.querySelectorAll('[data-slot]').forEach(el => {
    el.onclick = async () => take(el.dataset.slot, await pick());
    el.ondragover = e => { e.preventDefault(); el.classList.add('drag'); };
    el.ondragleave = () => el.classList.remove('drag');
    el.ondrop = e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drag'); take(el.dataset.slot, e.dataTransfer.files[0]); };
  });
  $$('#tvH').oninput = recalc; $$('#tvW').oninput = () => { manualW = true; }; $$('#tvD').oninput = () => { manualD = true; };
  bg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') bg.remove(); });
  $$('[data-r="0"]').onclick = () => bg.remove();
  make.onclick = async () => {
    const H = (parseFloat($$('#tvH').value) || 1000) / 1000, W = (parseFloat($$('#tvW').value) || H * 1000) / 1000, D = (parseFloat($$('#tvD').value) || W * 1000) / 1000;
    make.disabled = true; make.textContent = '作成中…';
    await new Promise(r => setTimeout(r, 30));
    try {
      const geo = carve(views, W, D, H, parseInt($$('#tvN').value, 10));
      if (!geo.attributes.position.count) throw new Error('形が取り出せませんでした。背景が白か透明になっているか確認してください。');
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })); mesh.name = '作品';
      const glb = await new GLTFExporter().parseAsync(mesh, { binary: true });
      const file = new File([glb], '作品（三面図）.glb', { type: 'model/gltf-binary' });
      const up = await uploadAsset(file), id = rid();
      assetCache.set(up.id, Promise.resolve(mesh));
      commit([{ c: 'objects', id, v: newEntity({ type: 'model', name: nextName('作品'), asset: { id: up.id, name: file.name, ext: 'glb' }, unit: 1, yup: false, color: null }) }], '三面図から3Dモデルを作る');
      setSelection(['objects:' + id], 'objects:' + id);
      bg.remove(); toast(`3Dモデルを作りました（${fmt(W)} × ${fmt(D)} × ${fmt(H)} mm）`, 4000);
    } catch (err) { console.error(err); toast(err.message, 5000); make.disabled = false; make.textContent = '3Dモデルを作る'; }
  };
  document.body.appendChild(bg);
}

// =====================================================================
// Pointer input on the viewport
// =====================================================================
let drag = null;   // {kind, x, y, ...}
const canvas = renderer.domElement;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  lastMouse = e; viewport.focus({ preventScroll: true });
  if (walk) { if (e.button === 0) exitWalk(false); else if (e.button === 2) exitWalk(true); return; }
  if (modal) { if (e.button === 0) finishModal(false); else if (e.button === 2) finishModal(true); e.preventDefault(); return; }
  closeMenus();
  const navBtn = e.button === 1 || (e.button === 0 && e.altKey);
  if (navBtn) {
    drag = { kind: e.shiftKey ? 'pan' : (e.ctrlKey || e.metaKey) ? 'zoom' : 'orbit', x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId); e.preventDefault(); return;
  }
  if (e.button === 2) {
    if (e.shiftKey) { const s = snapSurface(e, snapping()); if (s) setCursor(s.p, s.hit ? hitNormal(s.hit) : new V3(0, 0, 1)); requestRender(); return; }
    drag = { kind: 'rclick', x: e.clientX, y: e.clientY }; return;
  }
  if (e.button !== 0) return;
  if (tc.object && (tc.dragging || tc.axis)) return;      // gizmo handles it
  if (tool === 'orbit' || tool === 'pan' || tool === 'zoom') { drag = { kind: tool, x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); return; }
  if (tool === 'draw') { drawClick(e); return; }
  if (tool === 'line' || tool === 'route') { polyClick(e); return; }
  if (tool === 'erase') { drag = { kind: 'erase', x: e.clientX, y: e.clientY }; return; }
  if (tool === 'cursor') { const s = snapSurface(e, snapping()); if (s) setCursor(s.p, s.hit ? hitNormal(s.hit) : null); requestRender(); return; }
  if (tool === 'measure') {
    // grab an existing ruler end?
    const m = localXY(e);
    for (const [id, r] of Object.entries(store.rulers)) {
      for (const end of ['a', 'b']) {
        const s = toScreen(new V3(...r[end]));
        if (Math.hypot(s.x - m.x, s.y - m.y) < 9) {
          drag = { kind: 'rulerEnd', id, end, before: clone(r), x: e.clientX, y: e.clientY };
          selectRuler(id); canvas.setPointerCapture(e.pointerId); return;
        }
      }
    }
    const s = snapSurface(e, snapping());
    if (!s) return;
    drag = { kind: 'ruler', a: s.p.clone(), b: s.p.clone(), x: e.clientX, y: e.clientY, moved: false };
    canvas.setPointerCapture(e.pointerId); return;
  }
  // pressing on an object starts a drag-move once the mouse moves; pressing on empty space starts a box select
  const grab = (tool === 'select' || tool === 'move') && !e.shiftKey && !(e.ctrlKey || e.metaKey) ? raycastAll(e, { selectable: true }) : null;
  drag = { kind: 'select', x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, hit: grab };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  lastMouse = e;
  if (walk) return;
  if (modal) { modal.mouse = localXY(e); updateModal(); return; }
  if (!drag) {
    if (tool === 'draw' && draw) { drawMove(e); return; }
    if (tool === 'line' || tool === 'route') { polyMove(e); return; }
    if (tool === 'measure' || tool === 'draw' || tool === 'cursor') showSnapMark(snapSurface(e, snapping()));
    else if (tool === 'select' || tool === 'move') canvas.style.cursor = raycastAll(e, { selectable: true }) ? 'grab' : 'default';   // show what can be dragged
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (drag.kind === 'orbit') { orbit(dx, dy); drag.x = e.clientX; drag.y = e.clientY; }
  else if (drag.kind === 'pan') { pan(dx, dy); drag.x = e.clientX; drag.y = e.clientY; }
  else if (drag.kind === 'zoom') { zoom(Math.pow(1.006, dy)); drag.y = e.clientY; }
  else if (drag.kind === 'tweak') tweakMove(drag, e);
  else if (drag.kind === 'select') {
    if (Math.hypot(dx, dy) > 4 && drag.hit) { startTweak(drag); tweakMove(drag, e); return; }
    // dragging empty space moves the view (turns it in 3D, slides the plan); Shift/Ctrl+drag is a box select
    if (Math.hypot(dx, dy) > 4 && !drag.shift && !drag.ctrl && !drag.rect) { drag.kind = planMode ? 'pan' : 'orbit'; drag.viewDrag = true; drag.x = e.clientX; drag.y = e.clientY; canvas.style.cursor = 'grabbing'; return; }
    if (Math.hypot(dx, dy) > 4) {
      const r = viewport.getBoundingClientRect(), el = $('selRect');
      el.classList.remove('hidden');
      Object.assign(el.style, { left: Math.min(drag.x, e.clientX) - r.left + 'px', top: Math.min(drag.y, e.clientY) - r.top + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px' });
      drag.rect = true;
    }
  } else if (drag.kind === 'ruler') {
    const s = snapSurface(e, snapping()); if (!s) return;
    let b = s.p;
    if (e.shiftKey) { const d = b.clone().sub(drag.a); const ax = ['x', 'y', 'z'].reduce((m, k) => Math.abs(d[k]) > Math.abs(d[m]) ? k : m, 'x'); b = drag.a.clone(); b[ax] = s.p[ax]; }
    drag.b = b; drag.moved = Math.hypot(dx, dy) > 3; showSnapMark(s); setVCB('長さ', fmt(drag.a.distanceTo(b)) + ' mm');
    if (drag.moved) showTempRuler(drag.a, drag.b);
  } else if (drag.kind === 'rulerEnd') {
    const s = snapSurface(e, snapping()); if (!s) return; showSnapMark(s);
    const r = store.rulers[drag.id]; if (!r) return;
    r[drag.end] = s.p.toArray(); syncRuler(drag.id); send([{ c: 'rulers', id: drag.id, v: r }], false); requestRender();
  } else if (drag.kind === 'rclick') { /* waiting for release */ }
  updateStatusCoords(e);
});
canvas.addEventListener('pointerup', e => {
  const d = drag; drag = null; if (!d) return;
  if (d.viewDrag) { canvas.style.cursor = 'default'; return; }
  if (d.kind === 'tweak') {
    endEdit('移動'); $('modalText').classList.add('hidden'); setTool(tool); return;
  }
  if (d.kind === 'select') {
    $('selRect').classList.add('hidden');
    if (d.rect) boxSelect(d, e);
    else {
      const hit = raycastAll(e, { selectable: true });
      const k = hit ? keyOfHolder(hit.holder) : null;
      if (k) { if (d.shift) setSelection([k], k, 'toggle'); else setSelection([k], k); }
      else if (!d.shift) { setSelection([], null); if (selRuler) selectRuler(null); }
    }
  } else if (d.kind === 'ruler') {
    hideTempRuler(); $('snapMark').classList.add('hidden');
    if (d.moved && d.a.distanceTo(d.b) > 0.0005) {
      const id = rid(); commit([{ c: 'rulers', id, v: { a: d.a.toArray(), b: d.b.toArray(), by: prefs.name } }], '計測を追加'); selectRuler(id);
    } else pickRuler(e);
  } else if (d.kind === 'rulerEnd') {
    const r = store.rulers[d.id]; if (r) { send([{ c: 'rulers', id: d.id, v: r }]); pushUndo('計測を編集', [{ c: 'rulers', id: d.id, v: d.before }], [{ c: 'rulers', id: d.id, v: r }]); }
    $('snapMark').classList.add('hidden');
  } else if (d.kind === 'erase') {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) {
      const hit = raycastAll(e, { selectable: true });
      if (hit) { const k = keyOfHolder(hit.holder); setSelection([k], k); deleteSelected(); }
      else { pickRuler(e); if (selRuler) deleteSelected(); }
    }
  } else if (d.kind === 'rclick') {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) {
      const hit = raycastAll(e, { selectable: true });
      if (hit) { const k = keyOfHolder(hit.holder); if (!selected.has(k)) setSelection([k], k); }
      openMenu(objectMenu(), e.clientX, e.clientY, 'オブジェクト');
    }
  }
});
// drag-move: slide the selection across the floor plane under the cursor
function startTweak(d) {
  const k = keyOfHolder(d.hit.holder);
  if (!selected.has(k)) setSelection([k], k);
  const keys = editableKeys(); beginEdit(keys);
  d.kind = 'tweak';
  d.plane = new THREE.Plane(new V3(0, 0, 1), -d.hit.point.z); d.p0 = d.hit.point.clone();
  d.start = keys.map(key => { const h = holderOf(key); return { h, pos: h.position.clone() }; });
  canvas.style.cursor = 'grabbing';
}
function tweakMove(d, e) {
  raycaster.setFromCamera(mouseNDC(e), camera);
  const p = raycaster.ray.intersectPlane(d.plane, new V3()); if (!p) return;
  const dv = p.sub(d.p0); dv.z = 0;
  if (e.shiftKey) { if (Math.abs(dv.x) > Math.abs(dv.y)) dv.y = 0; else dv.x = 0; }
  if (snapping()) { const inc = prefs.snapInc / 1000; dv.x = Math.round(dv.x / inc) * inc; dv.y = Math.round(dv.y / inc) * inc; }
  for (const s of d.start) { s.h.position.copy(s.pos).add(dv); s.h.updateMatrixWorld(true); }
  liveEdit();
  setVCB('距離', fmt(dv.length()) + ' mm');
  $('modalText').textContent = `移動  ${fmt(dv.length())} mm（X ${fmt(dv.x)}　Y ${fmt(dv.y)}）　Shiftで縦横にそろえる`; $('modalText').classList.remove('hidden');
}
function boxSelect(d, e) {
  const r = viewport.getBoundingClientRect();
  const x0 = Math.min(d.x, e.clientX) - r.left, x1 = Math.max(d.x, e.clientX) - r.left, y0 = Math.min(d.y, e.clientY) - r.top, y1 = Math.max(d.y, e.clientY) - r.top;
  const keys = [];
  const test = (k, h) => {
    if (!h.visible) return;
    const c = new THREE.Box3().setFromObject(h, true).getCenter(new V3()); const s = toScreen(c);
    if (!s.behind && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) keys.push(k);
  };
  for (const [id, h] of userHolders) test('objects:' + id, h);
  if (prefs.spaceSelectable) for (const [id, h] of spaceHolders) test('space:' + id, h);
  setSelection(keys, undefined, d.ctrl ? 'remove' : d.shift ? 'add' : 'set');
}
function selectRuler(id) {
  const prev = selRuler; selRuler = id;
  if (prev) syncRuler(prev); if (id) { syncRuler(id); if (selected.size) setSelection([], null); }
  scheduleUI(); requestRender();
}
function pickRuler(e) {
  const m = localXY(e); let best = null, bestD = 8;
  for (const [id, r] of Object.entries(store.rulers)) {
    const a = toScreen(new V3(...r.a)), b = toScreen(new V3(...r.b));
    const seg = new THREE.Line3(new V3(a.x, a.y, 0), new V3(b.x, b.y, 0));
    const q = seg.closestPointToPoint(new V3(m.x, m.y, 0), true, new V3());
    const dd = Math.hypot(q.x - m.x, q.y - m.y); if (dd < bestD) { bestD = dd; best = id; }
  }
  selectRuler(best);
}

// wheel: mouse wheel zooms; trackpad two-finger scroll orbits (Shift pans), pinch zooms — like Blender on macOS
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (modal) return;
  const isMouseWheel = e.deltaMode === 1 || (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 && Math.abs(e.wheelDeltaY) % 120 === 0 && e.deltaX === 0);
  if (e.ctrlKey && !isMouseWheel) zoom(Math.pow(1.01, e.deltaY));
  else if (isMouseWheel || e.ctrlKey || e.metaKey) zoom(Math.pow(1.0015, e.deltaY * (e.deltaMode === 1 ? 30 : 1)));
  else if (e.shiftKey) pan(-e.deltaX, -e.deltaY);
  else orbit(-e.deltaX * 0.8, -e.deltaY * 0.8);
}, { passive: false });

// drag & drop import
viewport.addEventListener('dragover', e => { e.preventDefault(); $('dropHint').classList.remove('hidden'); });
viewport.addEventListener('dragleave', e => { if (!viewport.contains(e.relatedTarget)) $('dropHint').classList.add('hidden'); });
viewport.addEventListener('drop', e => {
  e.preventDefault(); $('dropHint').classList.add('hidden');
  const s = snapSurface(e, false); if (s) setCursor(s.p, s.hit ? hitNormal(s.hit) : null);
  importFiles([...e.dataTransfer.files]);
});

// =====================================================================
// Walk navigation (Shift+`)
// =====================================================================
let walk = null;
function enterWalk() {
  if (walk) return;
  if (nav.ortho) { nav.ortho = false; updateCamera(); }
  walk = { saved: { target: nav.target.clone(), dist: nav.dist, yaw: nav.yaw, pitch: nav.pitch }, keys: new Set(), last: performance.now() };
  canvas.requestPointerLock?.();
  setHints(); requestRender(); walkLoop();
}
function exitWalk(cancel) {
  if (!walk) return;
  if (cancel) Object.assign(nav, { ...walk.saved, target: walk.saved.target }); walk = null;
  document.exitPointerLock?.(); updateCamera(); setHints();
}
document.addEventListener('mousemove', e => {
  if (!walk) return;
  const pos = camera.position.clone();
  nav.yaw -= e.movementX * 0.0025; nav.pitch = THREE.MathUtils.clamp(nav.pitch - e.movementY * 0.0025, -1.5, 1.5);
  nav.target.copy(pos).addScaledVector(viewDir(), -nav.dist); updateCamera();
});
function walkLoop() {
  if (!walk) return;
  const now = performance.now(), dt = Math.min(0.05, (now - walk.last) / 1000); walk.last = now;
  const k = walk.keys, sp = (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1.6) * dt;
  const fwd = viewDir().negate(); fwd.z = 0; fwd.normalize(); const right = new V3(-Math.sin(nav.yaw), Math.cos(nav.yaw), 0);
  const mv = new V3();
  if (k.has('KeyW')) mv.add(fwd); if (k.has('KeyS')) mv.sub(fwd); if (k.has('KeyD')) mv.add(right); if (k.has('KeyA')) mv.sub(right);
  if (k.has('KeyE')) mv.z += 1; if (k.has('KeyQ')) mv.z -= 1;
  if (mv.lengthSq()) { nav.target.addScaledVector(mv.normalize(), sp); updateCamera(); }
  requestAnimationFrame(walkLoop);
}

// =====================================================================
// Keyboard (Blender keymap)
// =====================================================================
window.addEventListener('keydown', e => {
  if (e.key === 'Control' || e.key === 'Meta') { ctrlDown = true; applyGizmoSnap(); if (modal) updateModal(); }
  if (isTyping(e)) return;
  if (walk) {
    if (e.code === 'Escape') exitWalk(true); else if (e.code === 'Enter' || e.code === 'Space') exitWalk(false); else walk.keys.add(e.code);
    e.preventDefault(); return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (modal) {
    e.preventDefault();
    if (e.code === 'Escape') return finishModal(true);
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') return finishModal(false);
    if (['KeyX', 'KeyY', 'KeyZ'].includes(e.code)) return setModalAxis(e.code[3].toLowerCase(), e.shiftKey);
    if (/^[0-9.]$/.test(e.key) || (e.key === '-' && modal.num === '')) { modal.num += e.key; return updateModal(); }
    if (e.key === '-') { modal.num = modal.num.startsWith('-') ? modal.num.slice(1) : '-' + modal.num; return updateModal(); }
    if (e.code === 'Backspace') { modal.num = modal.num.slice(0, -1); return updateModal(); }
    if (['KeyG', 'KeyR', 'KeyS'].includes(e.code)) { const ty = e.code[3]; if (ty !== modal.type) { modal.type = ty; modal.num = ''; modal.angAcc = 0; modal.angPrev = null; modal.mouse0 = modal.mouse; updateModal(); } }
    return;
  }
  if (draw && tool === 'draw' && !mod && drawKey(e)) { e.preventDefault(); return; }
  if (poly && !mod && polyKey(e)) { e.preventDefault(); return; }
  if (e.code === 'Escape' && sim.follow) { exitFollow(); return; }
  if (e.code === 'Escape') { closeMenus(); if (drag?.kind === 'ruler') { drag = null; hideTempRuler(); } return; }
  if (mod && e.code === 'KeyZ') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && e.code === 'KeyY') { e.preventDefault(); return redo(); }
  if (mod && e.code === 'KeyS') { e.preventDefault(); return saveBackup(); }
  if (mod && e.code === 'KeyO') { e.preventDefault(); return $('jsonIn').click(); }
  if (mod && e.code === 'KeyI') { e.preventDefault(); return invertSelection(); }
  if (mod) return;
  const k = e.code;
  const numpad = { Numpad1: 'front', Numpad3: 'right', Numpad7: 'top', Digit1: 'front', Digit3: 'right', Digit7: 'top' };
  const opposite = { front: 'back', right: 'left', top: 'bottom' };
  if (numpad[k]) { e.preventDefault(); return setPreset(e.ctrlKey || e.altKey ? opposite[numpad[k]] : numpad[k]); }
  if (k === 'Numpad5' || k === 'Digit5') return toggleOrtho();
  if (k === 'Numpad0' || k === 'Digit0') return eyeView();
  if (k === 'Numpad2' || k === 'Digit2') return orbit(0, -2.5 / 0.006 * DEG * 6);
  if (k === 'Numpad8' || k === 'Digit8') return orbit(0, 2.5 / 0.006 * DEG * 6);
  if (k === 'Numpad4' || k === 'Digit4') return orbit(-15 * DEG / 0.006, 0);
  if (k === 'Numpad6' || k === 'Digit6') return orbit(15 * DEG / 0.006, 0);
  if (k === 'NumpadDecimal' || k === 'Period') return frameSelected();
  if (k === 'Home') return frameAll();
  if (k === 'NumpadAdd' || k === 'Equal') return zoom(0.8);
  if (k === 'NumpadSubtract' || k === 'Minus') return zoom(1.25);
  if (k === 'Backquote' && e.shiftKey) return enterWalk();
  if (k === 'KeyA' && e.shiftKey) { e.preventDefault(); return openMenu(addMenu(), lastMouse.clientX, lastMouse.clientY, '追加'); }
  if (k === 'KeyA' && e.altKey) { e.preventDefault(); return setSelection([], null); }
  if (k === 'KeyA') return selectAll();
  if (k === 'KeyD' && e.shiftKey) return duplicateSelected();
  if (k === 'KeyG') return startModal('G');
  if (k === 'KeyR') return startModal('R');
  if (k === 'KeyS') return startModal('S');
  if (k === 'KeyX' || k === 'Delete' || k === 'Backspace') {
    if (k === 'KeyX') { if (selected.size || selRuler) openMenu([{ label: '削除', action: deleteSelected }], lastMouse.clientX, lastMouse.clientY, 'OK?'); }
    else deleteSelected();
    return;
  }
  if (k === 'KeyH' && e.altKey) { e.preventDefault(); return unhideAll(); }
  if (k === 'KeyH' && e.shiftKey) { const keep = new Set(selected); return setHidden([...userHolders.keys()].map(id => 'objects:' + id).filter(x => !keep.has(x) && userHolders.get(splitKey(x)[1]).visible), true); }
  if (k === 'KeyH') return hideSelected();
  if (k === 'KeyN') { prefs.rightPanel = !prefs.rightPanel; savePrefs(); return scheduleUI(); }
  if (k === 'KeyT') return setTool('measure');
  if (k === 'KeyZ' && e.altKey) { prefs.xray = !prefs.xray; savePrefs(); return applyXray(); }
  if (k === 'KeyC' && e.shiftKey) { setCursor(new V3(SPAWN.x, SPAWN.y - 4, 0.09)); return frameAll(); }
  if (k === 'F2') { e.preventDefault(); return renameActive(); }
  if (k === 'Space' || k === 'KeyV') { e.preventDefault(); return setTool('select'); }
  if (k === 'KeyM') return setTool('move');
  if (k === 'KeyE') return setTool('erase');
  if (k === 'KeyB') return setTool('draw');
  if (k === 'KeyL') return setTool('line');
  if (k === 'KeyP') return setTool('route');
  if (k === 'KeyQ') return setTool('rotate');
  if (k === 'KeyO') return setTool('orbit');
  if (k === 'KeyZ' && e.shiftKey) return frameAll();
  if (k === 'KeyZ') return setTool('zoom');
});
window.addEventListener('keyup', e => {
  if (e.key === 'Control' || e.key === 'Meta') { ctrlDown = false; applyGizmoSnap(); if (modal) updateModal(); }
  if (walk) walk.keys.delete(e.code);
});
window.addEventListener('blur', () => { ctrlDown = false; });
function invertSelection() {
  const all = [...userHolders.entries()].filter(([, h]) => h.visible).map(([id]) => 'objects:' + id);
  setSelection(all.filter(k => !selected.has(k)));
}

// =====================================================================
// Menus
// =====================================================================
let openMenuEl = null;
function closeMenus() { $('menuLayer').innerHTML = ''; openMenuEl = null; document.querySelectorAll('.mbtn.open').forEach(b => b.classList.remove('open')); }
function openMenu(items, x, y, title, anchorBtn) {
  closeMenus();
  const el = document.createElement('div'); el.className = 'menu';
  if (title) el.innerHTML = `<div class="mt">${title}</div>`;
  for (const it of items) {
    if (it === '-') { el.insertAdjacentHTML('beforeend', '<div class="ms"></div>'); continue; }
    const row = document.createElement('div'); row.className = 'mi' + (it.disabled ? ' dis' : '');
    row.innerHTML = `<span></span>${it.shortcut ? `<span class="sc">${it.shortcut}</span>` : ''}`;
    row.firstChild.textContent = it.label;
    if (!it.disabled) row.onclick = ev => { ev.stopPropagation(); closeMenus(); it.action(); };
    el.appendChild(row);
  }
  $('menuLayer').appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 4) + 'px'; el.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
  openMenuEl = el; anchorBtn?.classList.add('open');
}
document.addEventListener('pointerdown', e => { if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('.mbtn')) closeMenus(); }, true);
const sel = () => selected.size > 0;
const addMenu = () => [
  { label: 'ボックス', action: () => addBox() },
  { label: '可動壁（3640 × 940 × 2700）', action: () => addBox(3640, 940, 2700, '可動壁', '#9a9894') },
  { label: 'ボックスを描く', shortcut: 'B', action: () => setTool('draw') },
  '-',
  { label: '画像（PNG / JPG）…', action: () => pickFiles('image') },
  { label: '3Dデータ（glb / gltf / obj / fbx / stl）…', action: () => pickFiles('model') },
  { label: '三面図から3Dモデルを作る…', action: threeViewDialog },
];
const objectMenu = () => [
  { label: '複製', shortcut: 'Shift D', action: duplicateSelected, disabled: !sel() },
  { label: '削除', shortcut: 'X', action: deleteSelected, disabled: !sel() && !selRuler },
  '-',
  { label: '床に下ろす', action: dropToFloor, disabled: !sel() },
  { label: '選択物を3Dカーソルへ', action: selectedToCursor, disabled: !sel() },
  { label: '3Dカーソルを選択物へ', action: cursorToSelected, disabled: !sel() },
  '-',
  { label: '名前を変更', shortcut: 'F2', action: renameActive, disabled: !activeKey?.startsWith('objects:') },
  { label: '非表示', shortcut: 'H', action: hideSelected, disabled: !sel() },
  { label: 'すべて再表示', shortcut: 'Alt H', action: unhideAll },
];
function pickFiles(kind) {
  const inp = $('fileIn');
  inp.accept = kind === 'image' ? '.png,.jpg,.jpeg,.webp' : kind === 'model' ? '.glb,.gltf,.obj,.fbx,.stl' : '.glb,.gltf,.obj,.fbx,.stl,.png,.jpg,.jpeg,.webp';
  inp.click();
}
$('fileIn').onchange = () => { const f = [...$('fileIn').files]; $('fileIn').value = ''; importFiles(f); };

const TOP_MENUS = {
  'ファイル': () => [
    { label: 'インポート（3Dデータ・画像）…', action: () => pickFiles('all') },
    '-',
    ...(LOCAL ? [] : [{ label: 'バックアップを保存（JSON）', shortcut: 'Ctrl S', action: saveBackup }]),
    { label: 'バックアップから復元…', shortcut: 'Ctrl O', action: () => $('jsonIn').click() },
    '-',
    ...(LOCAL ? [{ label: '配置をすべて消す', action: clearLayout }] : [{ label: '配置一覧を書き出し（CSV）', action: exportCSV }, { label: 'ビューを画像で保存（PNG）', action: saveScreenshot }]),
  ],
  '編集': () => [
    { label: '元に戻す' + (undoStack.length ? '：' + undoStack[undoStack.length - 1].label : ''), shortcut: 'Ctrl Z', action: undo, disabled: !undoStack.length },
    { label: 'やり直す' + (redoStack.length ? '：' + redoStack[redoStack.length - 1].label : ''), shortcut: 'Ctrl Shift Z', action: redo, disabled: !redoStack.length },
    '-',
    { label: '名前を変更', shortcut: 'F2', action: renameActive, disabled: !activeKey?.startsWith('objects:') },
    { label: '自分の名前と色…', action: () => nameDialog() },
  ],
  '追加': addMenu,
  'ヘルプ': () => [{ label: '使い方ガイド', action: openManual }, { label: 'キー操作の一覧', action: helpDialog }],
};
const VIEW_MENUS = {
  'ビュー': () => [
    { label: '右パネル', shortcut: 'N', action: () => { prefs.rightPanel = !prefs.rightPanel; savePrefs(); scheduleUI(); } },
    { label: '左パネル', action: () => { prefs.leftPanel = !prefs.leftPanel; savePrefs(); scheduleUI(); } },
    { label: 'ライト／ダーク', action: toggleTheme },
    { label: '今の視点をシーンに保存', action: () => addScene() },
    '-',
    { label: '前面', shortcut: 'テンキー1', action: () => setPreset('front') },
    { label: '右面', shortcut: 'テンキー3', action: () => setPreset('right') },
    { label: '上面（平面図）', shortcut: 'テンキー7', action: () => setPreset('top') },
    { label: '背面', shortcut: 'Ctrl テンキー1', action: () => setPreset('back') },
    { label: '透視投影／平行投影', shortcut: 'テンキー5', action: toggleOrtho },
    { label: '目線（スタート地点）', shortcut: 'テンキー0', action: eyeView },
    '-',
    { label: '選択物を表示', shortcut: 'テンキー .', action: frameSelected },
    { label: '全体を表示', shortcut: 'Home', action: frameAll },
    { label: 'ウォーク', shortcut: 'Shift `', action: enterWalk },
  ],
  '選択': () => [
    { label: 'すべて', shortcut: 'A', action: selectAll },
    { label: '解除', shortcut: 'Alt A', action: () => setSelection([], null) },
    { label: '反転', shortcut: 'Ctrl I', action: invertSelection },
  ],
  '追加': addMenu,
  'オブジェクト': objectMenu,
};
function buildMenuBar(el, menus) {
  for (const [name, items] of Object.entries(menus)) {
    const b = document.createElement('button'); b.className = 'mbtn'; b.textContent = name;
    b.onclick = () => { if (b.classList.contains('open')) return closeMenus(); const r = b.getBoundingClientRect(); openMenu(items(), r.left, r.bottom + 2, null, b); };
    b.onmouseenter = () => { if (openMenuEl && !b.classList.contains('open') && document.querySelector('.mbtn.open')) b.click(); };
    el.appendChild(b);
  }
}
const moreMenu = () => [
  { label: 'オブジェクト一覧（削除した壁・床も）', action: () => { $('leftCol').classList.remove('hidden'); renderOutliner(); } },
  { label: '表示とスナップの設定', action: () => $('settings').classList.toggle('hidden') },
  '-',
  { label: '全体を表示', shortcut: 'Home', action: frameAll },
  { label: '目線で見る（スタート地点）', shortcut: '0', action: () => { setPlanMode(false); eyeView(); } },
  { label: '歩いて見る（ウォーク）', shortcut: 'Shift `', action: () => { setPlanMode(false); enterWalk(); } },
  '-',
  { label: '画像・3Dデータを読み込む…', action: () => pickFiles('all') },
  ...(LOCAL ? [{ label: '配置をすべて消す', action: clearLayout }]
    : [{ label: 'バックアップを保存（JSON）', shortcut: 'Ctrl S', action: saveBackup }, { label: 'バックアップから復元…', action: () => $('jsonIn').click() }, { label: '配置一覧をCSVで書き出し', action: exportCSV }]),
  '-',
  { label: 'キー操作の一覧', action: helpDialog },
];
$('listBtn').onclick = () => { $('leftCol').classList.toggle('hidden'); renderOutliner(); };
$('moreBtn').onclick = () => { const r = $('moreBtn').getBoundingClientRect(); openMenu(moreMenu(), r.right - 240, r.bottom + 4); };
$('leftClose').onclick = () => $('leftCol').classList.add('hidden');
document.addEventListener('pointerdown', e => { const pop = $('settings'); if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !e.target.closest('#menuLayer, #moreBtn')) pop.classList.add('hidden'); });
$('addBtn').onclick = () => { const r = $('addBtn').getBoundingClientRect(); openMenu(addMenu(), r.left, r.bottom + 4); };
$('undoBtn').onclick = undo; $('redoBtn').onclick = redo; $('themeBtn').onclick = toggleTheme;

// =====================================================================
// Blender-style number field
// =====================================================================
function evalExpr(s) {
  s = s.replace(/mm/g, '').replace(/[，,]/g, '').replace(/×/g, '*').trim();
  if (!/^[-+*/().\d\s]+$/.test(s)) return NaN;
  try { return Function('"use strict";return (' + s + ')')(); } catch { return NaN; }
}
let scrubbing = false;
function numDef(label, get, set, o = {}) { return { kind: 'num', label, get, set, ...o }; }
// def: {label, get() -> display number, set(v), live(v)?, begin()?, end(cancel)?, unit, step, digits, min}
function numField(def) {
  const el = document.createElement('div'); el.className = 'nf';
  const unit = def.unit ?? 'mm', digits = def.digits ?? 0, step = def.step ?? 1;
  const show = (override) => {
    const v = override ?? def.get();
    el.innerHTML = `<span class="l"></span><span class="v"></span>`;
    // compact fields (3-up grids) show the unit next to the axis letter instead of after the value
    el.firstChild.textContent = def.compact && unit ? `${def.label} ${unit}` : (def.label || '');
    el.lastChild.textContent = v == null || isNaN(v) ? '—' : `${(Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString('ja-JP', { maximumFractionDigits: digits })}${unit && !def.compact ? ' ' + unit : ''}`;
    if (!def.label) el.classList.add('center');
  };
  show(); el.refresh = show;
  if (def.disabled) { el.classList.add('dis'); return el; }
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || el.querySelector('input')) return;
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    const start = def.get(), x0 = e.clientX; let scrub = false, val = start;
    const move = ev => {
      const dx = ev.clientX - x0;
      if (!scrub && Math.abs(dx) > 3) { scrub = true; def.begin?.(); }
      if (scrub) {
        scrubbing = true;
        val = start + dx * step * (ev.shiftKey ? 0.1 : 1);
        if (ev.ctrlKey || ev.metaKey) val = Math.round(val / (step * 10)) * step * 10;
        if (def.min != null) val = Math.max(def.min, val);
        if (def.live) { def.live(val); show(); } else show(val);
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
      scrubbing = false;
      if (scrub) { if (def.live) def.end?.(false); else def.set(val); show(); scheduleUI(); }
      else edit();
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  function edit() {
    const inp = document.createElement('input'); const v = def.get();
    inp.value = v == null || isNaN(v) ? '' : String(Math.round(v * 10 ** Math.max(digits, 2)) / 10 ** Math.max(digits, 2));
    el.appendChild(inp); inp.focus(); inp.select();
    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      if (ok) { let n = evalExpr(inp.value); if (!isNaN(n)) { if (def.min != null) n = Math.max(def.min, n); def.begin?.(); (def.live || def.set)(n); def.end ? def.end(false) : null; } }
      inp.remove(); show();
    };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
  }
  return el;
}
// a field bound to the active holder's transform (live while scrubbing, one undo step)
function xformField(label, read, write, o = {}) {
  return numField({
    label, compact: true, ...o,
    get: () => { const h = activeKey && holderOf(activeKey); return h ? read(h) : null; },
    begin: () => beginEdit([activeKey]),
    live: v => { const h = holderOf(activeKey); if (!h) return; write(h, v); h.updateMatrixWorld(true); liveEdit(); if (h.userData.c === 'objects') updateLabel(h); },
    set: v => { beginEdit([activeKey]); const h = holderOf(activeKey); write(h, v); endEdit(label); },
    end: () => endEdit(label),
    disabled: !activeKey,
  });
}
const unitDef = id => ({ kind: 'select', label: '単位', options: [['1', 'メートル (m)'], ['0.01', 'センチ (cm)'], ['0.001', 'ミリ (mm)'], ['0.0254', 'インチ (in)']],
  get: () => String(store.objects[id]?.unit ?? 1), set: v => { const e = store.objects[id]; if (e) commit([{ c: 'objects', id, v: { ...e, unit: +v } }], '単位を変更'); } });
const yupDef = id => ({ kind: 'check', label: 'Y軸が上のデータ（glb・fbx・obj）', get: () => !!store.objects[id]?.yup,
  set: v => { const e = store.objects[id]; if (e) commit([{ c: 'objects', id, v: { ...e, yup: v } }], '上方向を変更'); } });
function fieldFor(def) {
  if (def.kind === 'select') {
    const s = document.createElement('select'); s.className = 'sf';
    s.innerHTML = def.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); s.value = def.get(); s.onchange = () => def.set(s.value); return s;
  }
  if (def.kind === 'check') {
    const l = document.createElement('label'); l.className = 'chk'; l.innerHTML = '<input type="checkbox"><span></span>';
    l.lastChild.textContent = def.label; l.firstChild.checked = def.get(); l.firstChild.onchange = () => def.set(l.firstChild.checked); return l;
  }
  return numField(def);
}
function prow(label, ...els) {
  const r = document.createElement('div'); r.className = 'prow';
  r.innerHTML = '<span class="pl"></span>'; r.firstChild.textContent = label;
  if (els.length > 1) { const s = document.createElement('div'); s.className = 'stack'; s.append(...els); r.appendChild(s); } else r.append(...els);
  return r;
}
function panel(title, build, id) {
  const p = document.createElement('div'); p.className = 'panel' + (closedPanels.has(id || title) ? ' closed' : '');
  p.innerHTML = '<div class="ph"></div><div class="pb"></div>'; p.firstChild.textContent = title;
  p.firstChild.onclick = () => { p.classList.toggle('closed'); closedPanels[p.classList.contains('closed') ? 'add' : 'delete'](id || title); };
  build(p.lastChild); return p;
}
const closedPanels = new Set();

// =====================================================================
// Last operation panel (bottom-left, like Blender's "Adjust Last Operation")
// =====================================================================
let lastOp = null;
function showLastOp(title, defs) { lastOp = { title, defs }; renderLastOp(); }
function renderLastOp() {
  return $('lastOp').classList.add('hidden');   // the selection card covers this in the simple layout
  const el = $('lastOp');
  if (!lastOp) return el.classList.add('hidden');
  el.classList.remove('hidden'); $('lastOpTitle').textContent = lastOp.title;
  const body = $('lastOpBody'); body.innerHTML = '';
  for (const d of lastOp.defs) body.appendChild(d.kind === 'num' ? prow(d.label, numField({ ...d, label: '' })) : fieldFor(d));
}
$('lastOp').querySelector('.ph').onclick = () => $('lastOp').classList.toggle('collapsed');

// =====================================================================
// UI rendering (outliner, properties, sidebar, status)
// =====================================================================
let uiQueued = false, rightTab = 'props';
function scheduleUI() { if (!uiQueued) { uiQueued = true; requestAnimationFrame(() => { uiQueued = false; renderUI(); }); } }
function refreshPanels(fieldsOnly) {
  if (fieldsOnly) { document.querySelectorAll('#rightBody .nf').forEach(f => f.refresh?.()); for (const h of userHolders.values()) updateLabel(h); return; }
  scheduleUI();
}
function renderUI() {
  if (scrubbing) { renderOutliner(); renderStats(); return; }
  if (document.activeElement && document.activeElement.closest('#rightBody, #outliner') && document.activeElement.matches('input')) {
    renderOutliner(true); renderStats(); return;    // don't rebuild under the user's caret
  }
  renderOutliner(); renderRight(); renderStats(); renderLastOp(); updateViewInfo(); renderSceneTabs();
  $('undoBtn').disabled = !undoStack.length; $('redoBtn').disabled = !redoStack.length;
  $('snapBtn').classList.toggle('on', prefs.snap); $('labelsBtn').classList.toggle('on', prefs.labels);
  $('orientBtn').textContent = prefs.orient === 'local' ? 'ローカル' : 'グローバル';
}
const ICON = {
  box: '<path d="M8 2 14 5v6l-6 3-6-3V5z"/><path d="M2 5l6 3 6-3M8 8v6"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="m2 11 4-4 3 3 2-2 3 3"/>',
  model: '<path d="M8 1.5 14 5v6l-6 3.5L2 11V5z"/><path d="M8 8v6.5M2 5l6 3 6-3"/>',
  coll: '<path d="M2 4h5l1 1.5h6V13H2z"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8M3 12 13 4"/>',
  arrow: '<path d="M4 2v11l3-3 2 4 2-1-2-4h4z"/>',
  restore: '<path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5V5h2.5"/>',
  space: '<path d="M2 13V6l6-4 6 4v7zM6 13V9h4v4"/>',
};
const ico = (n, cls = '') => `<span class="ico ${cls}"><svg class="i" viewBox="0 0 16 16">${ICON[n]}</svg></span>`;
const openTree = new Set(['scene', 'user']);
function renderOutliner(soft) {
  const el = $('outliner'), q = $('oSearch').value.trim().toLowerCase(), scrollTop = el.scrollTop;
  if (soft) return;
  const rows = [];
  const peerSel = new Map(); for (const p of peers) if (p.id !== me.id) for (const k of p.sel || []) peerSel.set(k, p.color);
  const row = (o) => {
    const r = document.createElement('div');
    r.className = 'orow' + (o.key && selected.has(o.key) ? ' sel' : '') + (o.key && activeKey === o.key ? ' active' : '') + (o.deleted ? ' deleted' : '');
    r.style.paddingLeft = (o.depth * 14 + 2) + 'px';
    r.innerHTML = `<span class="tw">${o.tw ?? ''}</span>${o.icon}<span class="nm"></span>`;
    r.querySelector('.nm').textContent = o.name;
    if (o.key && peerSel.has(o.key)) r.insertAdjacentHTML('beforeend', `<span class="dot" style="background:${peerSel.get(o.key)}" title="他の人が選択中"></span>`);
    for (const b of o.buttons || []) {
      const btn = document.createElement('button'); btn.className = 'ib' + (b.off ? ' off' : ''); btn.title = b.title;
      btn.innerHTML = `<svg class="i" viewBox="0 0 16 16">${ICON[b.icon]}</svg>`;
      btn.onclick = ev => { ev.stopPropagation(); b.action(); }; r.appendChild(btn);
    }
    if (o.tw) r.querySelector('.tw').onclick = ev => { ev.stopPropagation(); openTree.has(o.id) ? openTree.delete(o.id) : openTree.add(o.id); renderOutliner(); };
    if (o.key) {
      r.onclick = ev => { if (ev.shiftKey || ev.ctrlKey || ev.metaKey) setSelection([o.key], o.key, 'toggle'); else setSelection([o.key], o.key); };
      r.ondblclick = () => { if (o.key.startsWith('objects:')) renameInline(r, o.key); else frameSelected(); };
    } else if (o.onclick) r.onclick = o.onclick;
    rows.push(r);
  };
  const tw = id => openTree.has(id) ? '▾' : '▸';
  row({ id: 'scene', depth: 0, tw: tw('scene'), icon: ico('coll', 'col'), name: 'すべて' });
  if (openTree.has('scene')) {
    const users = Object.entries(store.objects).sort((a, b) => (a[1].created || 0) - (b[1].created || 0));
    row({ id: 'user', depth: 1, tw: tw('user'), icon: ico('coll', 'col'), name: `配置（${users.length}）` });
    if (openTree.has('user')) {
      for (const [id, v] of users) {
        if (q && !v.name.toLowerCase().includes(q)) continue;
        row({ key: 'objects:' + id, depth: 2, icon: ico(v.type === 'box' ? 'box' : v.type === 'image' ? 'image' : 'model', v.type === 'image' ? 'img' : v.type === 'model' ? 'mdl' : ''), name: v.name,
          buttons: [{ icon: v.hidden ? 'eyeOff' : 'eye', off: v.hidden, title: '表示／非表示', action: () => setHidden(['objects:' + id], !v.hidden) }] });
      }
      if (!users.length) rows.push(Object.assign(document.createElement('div'), { className: 'note', style: 'padding:4px 34px', textContent: 'Shift+A で追加、またはファイルをドロップ' }));
    }
    const keys = [...spaceHolders.keys()], live = keys.filter(k => !spaceDeleted(k)), dead = keys.filter(k => spaceDeleted(k));
    row({ id: 'space', depth: 1, tw: tw('space'), icon: ico('space', 'col'), name: `展示空間（${live.length}）`,
      buttons: [{ icon: 'arrow', off: !prefs.spaceSelectable, title: prefs.spaceSelectable ? 'ビューで選択できます（クリックでロック）' : 'ビューでは選択できません（クリックで選択可能に）',
        action: () => { prefs.spaceSelectable = !prefs.spaceSelectable; savePrefs(); if (!prefs.spaceSelectable) setSelection([...selected].filter(k => !k.startsWith('space:'))); scheduleUI(); } }] });
    if (openTree.has('space')) {
      for (const k of live) {
        const name = displayName('space:' + k); if (q && !name.toLowerCase().includes(q)) continue;
        const hidden = !!store.space[k]?.hidden;
        row({ key: 'space:' + k, depth: 2, icon: ico('box'), name, buttons: [{ icon: hidden ? 'eyeOff' : 'eye', off: hidden, title: '表示／非表示', action: () => setHidden(['space:' + k], !hidden) }] });
      }
      row({ id: 'deleted', depth: 2, tw: tw('deleted'), icon: ico('coll', 'col'), name: `削除済み（${dead.length}）`,
        buttons: dead.length ? [{ icon: 'restore', title: 'すべて復元', action: () => restoreSpace(dead) }] : [] });
      if (openTree.has('deleted')) for (const k of dead) {
        const name = displayName('space:' + k); if (q && !name.toLowerCase().includes(q)) continue;
        row({ id: 'd:' + k, depth: 3, icon: ico('box'), name, deleted: true, buttons: [{ icon: 'restore', title: '復元', action: () => restoreSpace([k]) }] });
      }
    }
  }
  el.replaceChildren(...rows); el.scrollTop = scrollTop;
}
$('oSearch').addEventListener('input', () => renderOutliner());
function renameInline(r, key) {
  const nm = r.querySelector('.nm'), id = splitKey(key)[1], v = store.objects[id];
  const inp = document.createElement('input'); inp.className = 'tf'; inp.value = v.name; nm.replaceChildren(inp); inp.focus(); inp.select();
  let done = false;
  const fin = ok => { if (done) return; done = true; const n = inp.value.trim(); if (ok && n && n !== v.name) commit([{ c: 'objects', id, v: { ...store.objects[id], name: n } }], '名前を変更'); else renderOutliner(); };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
  inp.onblur = () => fin(true);
}
function renameActive() {
  if (!activeKey?.startsWith('objects:')) return;
  const r = [...$('outliner').querySelectorAll('.orow.active')][0];
  if (r) renameInline(r, activeKey);
}

function renderRight() {
  const show = !!(activeKey && holderOf(activeKey));
  $('rightCol').classList.toggle('hidden', !show);
  const el = $('rightBody'); el.innerHTML = '';
  if (show) renderProps(el);
}

// selection card: only what you need to place a piece — size, position, angle, colour
const SWATCHES = ['#f2f0ea', '#ffffff', '#9a9894', '#3a3936', '#c9a77c', '#7d8f6a', '#5b5bd6'];
function renderProps(el) {
  const [c, id] = splitKey(activeKey), h = holderOf(activeKey), v = c === 'objects' ? store.objects[id] : null;
  const title = document.createElement('div'); title.className = 'props-title';
  title.innerHTML = '<input class="tf"><button class="icon-btn" title="選択を解除（Esc）">✕</button>';
  const nameIn = title.querySelector('input'); nameIn.value = v ? v.name : displayName(activeKey); nameIn.disabled = !v;
  nameIn.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') nameIn.blur(); };
  nameIn.onchange = () => { const n = nameIn.value.trim(); if (v && n) commit([{ c, id, v: { ...store.objects[id], name: n } }], '名前を変更'); };
  title.querySelector('button').onclick = () => setSelection([], null);
  el.appendChild(title);

  if (v?.type === 'line' || v?.type === 'route') return renderPolyCard(el, c, id, v);
  const dim = (i, label) => xformField(label, hh => dims(hh).getComponent(i) * 1000,
    (hh, val) => { const base = hh.userData.baseBox.getSize(new V3()).getComponent(i); if (base > 1e-6 && val > 0) hh.scale.setComponent(i, Math.sign(hh.scale.getComponent(i) || 1) * val / 1000 / base); }, { step: 5, min: 1 });
  const loc = (i, label) => xformField(label, hh => hh.position.getComponent(i) * 1000, (hh, val) => hh.position.setComponent(i, val / 1000), { step: 5 });
  if (v?.type === 'image') { const st = document.createElement('div'); st.className = 'stack two'; st.append(dim(0, '幅'), dim(2, '高さ')); el.appendChild(prow('寸法', st)); }
  else el.appendChild(prow('寸法', dim(0, '幅'), dim(1, '奥行'), dim(2, '高さ')));
  el.appendChild(prow('位置', loc(0, 'X'), loc(1, 'Y'), loc(2, 'Z')));
  const rotRow = document.createElement('div'); rotRow.className = 'stack two';
  const rot = xformField('角度', hh => hh.rotation.z / DEG, (hh, val) => { hh.rotation.z = val * DEG; }, { unit: '°', digits: 1, step: 0.5 });
  const r90 = document.createElement('button'); r90.className = 'btn'; r90.textContent = '90° 回す';
  r90.onclick = () => { beginEdit([activeKey]); const hh = holderOf(activeKey); hh.rotation.z += Math.PI / 2; hh.updateMatrixWorld(true); endEdit('90°回転'); };
  rotRow.append(rot, r90); el.appendChild(prow('回転', rotRow));

  if (v && v.type !== 'model') {
    const sw = document.createElement('div'); sw.className = 'swatches';
    const setColor = col => commit([{ c, id, v: { ...store.objects[id], color: col } }], '色を変更');
    for (const col of SWATCHES) {
      const b = document.createElement('button'); b.className = 'swatch' + ((v.color || '').toLowerCase() === col ? ' on' : ''); b.style.background = col; b.title = col; b.onclick = () => setColor(col); sw.appendChild(b);
    }
    const custom = document.createElement('input'); custom.type = 'color'; custom.className = 'swatch-custom'; custom.value = v.color || '#ffffff'; custom.title = 'ほかの色';
    custom.onchange = () => setColor(custom.value); sw.appendChild(custom);
    el.appendChild(prow('色', sw));
  }
  if (v?.type === 'model') el.appendChild(prow('単位', fieldFor(unitDef(id))));
  if (v?.type === 'image') {
    // floor signs: lay the picture flat on the floor (or stand it up again)
    const flat = Math.abs((h.rotation.x / DEG) + 90) < 1;
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = flat ? '立てる' : '床に寝かせる（床サイン）';
    b.onclick = () => { beginEdit([activeKey]); const hh = holderOf(activeKey); if (flat) { hh.rotation.x = 0; } else { hh.rotation.x = -Math.PI / 2; hh.position.z = floorAt(hh.position.x, hh.position.y, hh.position.z + 0.5) + 0.003; } hh.updateMatrixWorld(true); endEdit(flat ? '画像を立てる' : '画像を床に寝かせる'); };
    el.appendChild(prow('置き方', b));
  }

  const btns = document.createElement('div'); btns.className = 'btns';
  const mk = (label, fn, cls = '') => { const x = document.createElement('button'); x.className = 'btn ' + cls; x.textContent = label; x.onclick = fn; btns.appendChild(x); };
  if (v) mk('複製', duplicateSelected);
  mk('削除', deleteSelected, 'danger');
  if (c === 'space' && store.space[id] && (store.space[id].loc || store.space[id].rot || store.space[id].scale))
    mk('元の位置に戻す', () => { const o = { ...store.space[id] }; delete o.loc; delete o.rot; delete o.scale; commit([{ c, id, v: o }], '位置を元に戻す'); });
  el.appendChild(btns);
}

function renderPolyCard(el, c, id, v) {
  const L = polyLength(v.points);
  const num = (label, key, unit, step, digits, scale = 1, min = 0) => numField({ label, unit, step, digits, min, get: () => (store.objects[id]?.[key] ?? 0) * scale,
    set: val => commit([{ c, id, v: { ...store.objects[id], [key]: Math.max(min, val) / scale } }], label + 'を変更') });
  if (v.type === 'line') {
    el.appendChild(prow('長さ', Object.assign(document.createElement('div'), { className: 'note', textContent: `${fmt(L)} mm` })));
    el.appendChild(prow('太さ', num('太さ', 'width', 'mm', 5, 0, 1000, 5)));
  } else {
    const secs = L / (v.speed || 1);
    el.appendChild(prow('長さ', Object.assign(document.createElement('div'), { className: 'note', textContent: `${L.toFixed(1)} m　ゆっくり歩いて約${secs >= 60 ? Math.floor(secs / 60) + '分' : ''}${Math.round(secs % 60)}秒` })));
    el.appendChild(prow('速さ', num('歩く速さ', 'speed', 'm/秒', 0.05, 2, 1, 0.2)));
    el.appendChild(prow('人数', num('人数', 'people', '人', 0.2, 0, 1, 1)));
    el.appendChild(prow('間隔', num('間隔', 'interval', '秒', 0.1, 1, 1, 0.3)));
    el.appendChild(prow('幅', num('通路の幅', 'width', 'mm', 10, 0, 1000, 100)));
    const play = document.createElement('div'); play.className = 'btns';
    const running = sim.playing && sim.id === id;
    play.innerHTML = `<button class="btn primary">${running ? '■ 止める' : '▶ 人を歩かせる'}</button><button class="btn">${sim.follow && running ? '目線をやめる' : '👁 この人の目線で歩く'}</button>`;
    play.children[0].onclick = () => running ? stopSim() : startSim(id);
    play.children[1].onclick = () => (sim.follow && running) ? exitFollow() : startSim(id, true);
    el.appendChild(play);
  }
  const sw = document.createElement('div'); sw.className = 'swatches';
  for (const col of v.type === 'line' ? LINE_COLORS : ['#5b5bd6', '#d6453d', '#2fa36b', '#f2c200', '#3a3936']) {
    const b = document.createElement('button'); b.className = 'swatch' + ((v.color || '').toLowerCase() === col ? ' on' : ''); b.style.background = col;
    b.onclick = () => commit([{ c, id, v: { ...store.objects[id], color: col } }], '色を変更'); sw.appendChild(b);
  }
  el.appendChild(prow('色', sw));
  const btns = document.createElement('div'); btns.className = 'btns';
  for (const [label, fn, cls] of [['複製', duplicateSelected, ''], ['削除', () => { if (sim.id === id) stopSim(); deleteSelected(); }, 'danger']]) { const x = document.createElement('button'); x.className = 'btn ' + cls; x.textContent = label; x.onclick = fn; btns.appendChild(x); }
  el.appendChild(btns);
}
function floorAt(x, y, fromZ) {
  const rc = new THREE.Raycaster(new V3(x, y, fromZ), new V3(0, 0, -1));
  const hit = rc.intersectObjects([spaceRoot], true).find(hh => hh.object.isMesh && visibleChain(hh.object) && hitNormal(hh).z > 0.5);
  return hit ? hit.point.z : 0;
}
let lastOpacityBefore = null;

function transformRows(b) {
  const loc = i => xformField(['X', 'Y', 'Z'][i], h => h.position.getComponent(i) * 1000, (h, v) => h.position.setComponent(i, v / 1000), { step: 5 });
  const rot = i => xformField(['X', 'Y', 'Z'][i], h => h.rotation.toArray()[i] / DEG, (h, v) => { const r = h.rotation.toArray(); r[i] = v * DEG; h.rotation.set(r[0], r[1], r[2]); }, { unit: '°', digits: 1, step: 0.5 });
  const scl = i => xformField(['X', 'Y', 'Z'][i], h => h.scale.getComponent(i), (h, v) => h.scale.setComponent(i, v || 0.001), { unit: '', digits: 3, step: 0.005 });
  const dim = i => xformField(['X', 'Y', 'Z'][i], h => dims(h).getComponent(i) * 1000,
    (h, v) => { const base = h.userData.baseBox.getSize(new V3()).getComponent(i); if (base > 1e-6 && v > 0) h.scale.setComponent(i, Math.sign(h.scale.getComponent(i) || 1) * v / 1000 / base); }, { step: 5, min: 1 });
  b.appendChild(prow('寸法', dim(0), dim(1), dim(2)));
  b.appendChild(prow('位置', loc(0), loc(1), loc(2)));
  b.appendChild(prow('回転', rot(0), rot(1), rot(2)));
  b.appendChild(prow('倍率', scl(0), scl(1), scl(2)));
}

function renderMeasure(body) {
  body.appendChild(panel('メジャー', b => {
    const list = Object.entries(store.rulers);
    if (!list.length) b.insertAdjacentHTML('beforeend', '<div class="note">メジャーツール（T）で2点間をドラッグして測ります。端点・中点・エッジに吸着します（Ctrlで吸着の切り替え、Shiftで軸方向にそろえる）。</div>');
    list.forEach(([id, r], i) => {
      const a = new V3(...r.a), bb = new V3(...r.b), d = bb.clone().sub(a);
      const row = document.createElement('div'); row.className = 'orow' + (selRuler === id ? ' active' : '');
      row.innerHTML = `<span class="nm">#${i + 1}　<b>${fmt(d.length())} mm</b>　<span style="color:var(--muted)">水平 ${fmt(Math.hypot(d.x, d.y))}・高さ ${fmt(Math.abs(d.z))}</span></span><button class="ib" title="削除">✕</button>`;
      row.onclick = () => selectRuler(id);
      row.querySelector('.ib').onclick = ev => { ev.stopPropagation(); commit([{ c: 'rulers', id, v: null }], '計測を削除'); };
      b.appendChild(row);
    });
    if (list.length) { const bt = document.createElement('div'); bt.className = 'btns'; bt.innerHTML = '<button class="btn danger">すべて削除</button>'; bt.firstChild.onclick = () => commit(list.map(([id]) => ({ c: 'rulers', id, v: null })), '計測をすべて削除'); b.appendChild(bt); }
  }, 'p-measure'));
}
function renderViewTab(body) {
  body.appendChild(panel('シーン（保存した視点）', b => {
    const list = Object.entries(store.scenes).sort((x, y) => (x[1].created || 0) - (y[1].created || 0));
    if (!list.length) b.insertAdjacentHTML('beforeend', '<div class="note">ビュー左上の「＋」で今の視点を保存すると、全員で共有できます。</div>');
    for (const [id, sc] of list) {
      const row = document.createElement('div'); row.className = 'orow' + (activeScene === id ? ' active' : '');
      row.innerHTML = `<span class="nm"></span><button class="ib" title="今の視点で上書き">↻</button><button class="ib" title="削除">✕</button>`;
      row.querySelector('.nm').textContent = sc.name; row.onclick = () => goScene(id);
      row.querySelectorAll('.ib')[0].onclick = ev => { ev.stopPropagation(); updateScene(id); };
      row.querySelectorAll('.ib')[1].onclick = ev => { ev.stopPropagation(); commit([{ c: 'scenes', id, v: null }], 'シーンを削除'); };
      b.appendChild(row);
    }
  }, 'p-scenes'));
  body.appendChild(panel('カメラ', b => {
    b.appendChild(prow('焦点距離', numField({ label: '', unit: 'mm', step: 0.5, min: 8, get: () => 18 / Math.tan(persp.fov * DEG / 2), set: v => { persp.fov = 2 * Math.atan(18 / Math.max(8, v)) / DEG; updateCamera(); } })));
    b.appendChild(prow('目線', numField({ label: '', step: 10, min: 300, get: () => prefs.eye, set: v => { prefs.eye = Math.round(v); savePrefs(); } })));
    const bt = document.createElement('div'); bt.className = 'btns';
    for (const [l, f] of [['目線（0）', eyeView], ['平面図（7）', () => setPreset('top')], ['全体表示', frameAll], ['ウォーク', enterWalk]]) { const x = document.createElement('button'); x.className = 'btn'; x.textContent = l; x.onclick = f; bt.appendChild(x); }
    b.appendChild(bt);
  }, 'p-camera'));
  body.appendChild(panel('表示', b => {
    const ck = (label, key, fn) => { const l = document.createElement('label'); l.className = 'chk'; l.innerHTML = '<input type="checkbox"><span></span>'; l.lastChild.textContent = label; l.firstChild.checked = !!prefs[key]; l.firstChild.onchange = () => { prefs[key] = l.firstChild.checked; savePrefs(); fn(); }; b.appendChild(l); };
    ck('エッジ（輪郭線）', 'edges', applyLook); ck('空と地面', 'sky', applyLook); ck('グリッド', 'grid', applyLook);
  }, 'p-look'));
  body.appendChild(panel('3Dカーソル', b => {
    const f = i => numField({ label: ['X', 'Y', 'Z'][i], compact: true, step: 5, get: () => cursor.pos.getComponent(i) * 1000, set: v => { cursor.pos.setComponent(i, v / 1000); updateCursorEl(); requestRender(); } });
    b.appendChild(prow('位置', f(0), f(1), f(2)));
  }, 'p-cursor'));
}

function renderStats() {
  const n = userHolders.size, vis = [...userHolders.values()].filter(h => h.visible).length;
  const others = peers.filter(p => p.id !== me.id).length;
  $('stats').textContent = `配置 ${selected.size}/${n}（表示 ${vis}）｜計測 ${Object.keys(store.rulers).length}` + (LOCAL ? '' : `｜共同編集 ${others + 1}人`);
}
function renderPeers() {
  const el = $('peers'); el.innerHTML = '';
  const list = [...peers].sort((a, b) => (b.id === me.id) - (a.id === me.id));
  for (const p of list) {
    const d = document.createElement('div'); d.className = 'peer' + (p.id === me.id ? ' me' : ''); d.style.background = p.color;
    d.textContent = (p.name || '?').slice(0, 1); d.title = p.id === me.id ? `${p.name}（自分）クリックで変更` : p.name;
    if (p.id === me.id) d.onclick = () => nameDialog();
    el.appendChild(d);
  }
  renderStats(); scheduleUI();
}
function setHints() {
  const k = (key, t) => `<span class="k"><b>${key}</b>${t}</span>`;
  let h;
  if (walk) h = [k('W A S D', '移動'), k('Q E', '上下'), k('Shift', '速く'), k('クリック / Enter', '確定'), k('Esc / 右クリック', 'キャンセル')];
  else if (modal) h = [k('左クリック / Enter', '確定'), k('右クリック / Esc', 'キャンセル'), k('X Y Z', '軸に制限'), k('Shift+X Y Z', '平面'), k('数字', '値を入力'), k('Ctrl', 'スナップ切替')];
  else if (tool === 'draw') h = !draw ? [k('クリック', '始点'), k('Esc', 'やめる')]
    : draw.phase === 1 ? [k('クリック', '対角の点'), k('数値 Enter', '幅,奥行（例 900,450）'), k('Esc', 'やめる')]
    : [k('上下に動かす', '高さ'), k('クリック', '確定'), k('数値 Enter', '高さ（mm）'), k('Esc', 'やめる')];
  else if (tool === 'erase') h = [k('クリック', 'オブジェクト・メジャーを削除')];
  else if (tool === 'line' || tool === 'route') h = [k('クリック', '点を打つ'), k('ダブルクリック / Enter', '終わる'), k('Shift', '縦横にまっすぐ'), k('Backspace', '1点戻す'), k('Esc', 'やめる')];
  else if (tool === 'orbit' || tool === 'pan' || tool === 'zoom') h = [k('ドラッグ', { orbit: '回転', pan: '平行移動', zoom: 'ズーム' }[tool]), k('Space', '選択に戻る')];
  else if (tool === 'measure') h = [k('ドラッグ', '2点間を測る'), k('Ctrl', '吸着の切り替え'), k('Shift', '軸にそろえる'), k('端をドラッグ', '編集'), k('X / Delete', '削除')];
  else if (tool === 'rotate') h = [k('物をクリック', '選ぶ'), k('輪をドラッグ', '回す'), k('Ctrl', '5°刻みの切り替え')];
  else h = [k('物をドラッグ', '移動'), k('何もない所をドラッグ', planMode ? '平行移動' : '視点を回す'), k('Shift+ドラッグ', '範囲選択'), k('ホイール', 'ズーム'), k('Delete', '削除')];
  if (sim.follow) h = [k('ドラッグ', '見回す'), k('Esc', '目線をやめる')];
  $('hints').innerHTML = h.join('');
}
function updateStatusCoords(e) { /* cursor readout lives in the status bar's right side */ }

// =====================================================================
// Header controls
// =====================================================================
$('snapBtn').onclick = () => { prefs.snap = !prefs.snap; savePrefs(); applyGizmoSnap(); scheduleUI(); };
$('snapInc').replaceWith(Object.assign(numField({ label: '', step: 1, min: 1, get: () => prefs.snapInc, set: v => { prefs.snapInc = Math.max(1, Math.round(v)); savePrefs(); applyGizmoSnap(); } }), { id: 'snapInc', className: 'nf center hdr-num' }));
$('clipBtn').onclick = () => { prefs.clip = !prefs.clip; savePrefs(); applyClip(); };
$('clipH').replaceWith(Object.assign(numField({ label: '', step: 10, min: 100, get: () => prefs.clipH, set: v => { prefs.clipH = Math.round(v); savePrefs(); applyClip(); }, live: v => { prefs.clipH = Math.round(v); applyClip(); }, end: () => savePrefs() }), { id: 'clipH', className: 'nf center hdr-num' }));
$('labelsBtn').onclick = () => { prefs.labels = !prefs.labels; savePrefs(); for (const h of userHolders.values()) updateLabel(h); scheduleUI(); requestRender(); };
$('xrayBtn').onclick = () => { prefs.xray = !prefs.xray; savePrefs(); applyXray(); };
$('orientBtn').onclick = () => { prefs.orient = prefs.orient === 'local' ? 'global' : 'local'; savePrefs(); attachGizmo(); scheduleUI(); };

// navigation gizmo (axis balls) + buttons
const gz = $('gizmoCanvas'), gctx = gz.getContext('2d');
let gizmoHits = [];
function drawGizmo() {
  const S = 192, c = S / 2, R = 64;
  gctx.clearRect(0, 0, S, S);
  gctx.beginPath(); gctx.arc(c, c, R + 22, 0, Math.PI * 2); gctx.fillStyle = 'rgba(27,29,33,.72)'; gctx.fill();
  gctx.strokeStyle = 'rgba(255,255,255,.08)'; gctx.lineWidth = 2; gctx.stroke();
  const inv = camera.quaternion.clone().invert();
  const items = [];
  for (const a of ['x', 'y', 'z']) for (const sgn of [1, -1]) {
    const v = AXIS[a].clone().multiplyScalar(sgn).applyQuaternion(inv);
    items.push({ a, sgn, x: c + v.x * R, y: c - v.y * R, z: v.z });
  }
  items.sort((p, q) => p.z - q.z);
  gizmoHits = items;
  // thin axis spokes with letter tags; negative ends are small hollow squares
  for (const it of items) {
    const col = AXIS_COLOR[it.a], alpha = 0.55 + 0.45 * (it.z + 1) / 2;
    gctx.globalAlpha = alpha;
    gctx.strokeStyle = col; gctx.lineWidth = it.sgn > 0 ? 3 : 1.5;
    gctx.beginPath(); gctx.moveTo(c, c); gctx.lineTo(c + (it.x - c) * (it.sgn > 0 ? 0.78 : 0.86), c + (it.y - c) * (it.sgn > 0 ? 0.78 : 0.86)); gctx.stroke();
    if (it.sgn > 0) {
      gctx.fillStyle = '#15171a'; gctx.beginPath(); gctx.roundRect(it.x - 13, it.y - 13, 26, 26, 7); gctx.fill();
      gctx.strokeStyle = col; gctx.lineWidth = 2.5; gctx.stroke();
      gctx.fillStyle = col; gctx.font = '600 16px sans-serif'; gctx.textAlign = 'center'; gctx.textBaseline = 'middle'; gctx.fillText(it.a.toUpperCase(), it.x, it.y + 1);
    } else {
      gctx.strokeStyle = col; gctx.lineWidth = 2; gctx.strokeRect(it.x - 6, it.y - 6, 12, 12);
    }
  }
  gctx.globalAlpha = 1;
  gctx.fillStyle = '#e8eaed'; gctx.beginPath(); gctx.arc(c, c, 3, 0, Math.PI * 2); gctx.fill();
}
{
  let gd = null;
  gz.addEventListener('pointerdown', e => { gd = { x: e.clientX, y: e.clientY, moved: false }; gz.setPointerCapture(e.pointerId); });
  gz.addEventListener('pointermove', e => { if (!gd) return; const dx = e.clientX - gd.x, dy = e.clientY - gd.y; if (Math.abs(dx) + Math.abs(dy) > 2) gd.moved = true; if (gd.moved) { orbit(dx, dy); gd.x = e.clientX; gd.y = e.clientY; } });
  gz.addEventListener('pointerup', e => {
    if (gd && !gd.moved) {
      const r = gz.getBoundingClientRect(), x = (e.clientX - r.left) * gz.width / r.width, y = (e.clientY - r.top) * gz.height / r.height;
      const hit = [...gizmoHits].reverse().find(it => Math.hypot(it.x - x, it.y - y) < 16);
      if (hit) {
        const map = { 'x1': 'right', 'x-1': 'left', 'y1': 'back', 'y-1': 'front', 'z1': 'top', 'z-1': 'bottom' };
        const p = map[hit.a + hit.sgn];
        if (nav.preset === p) setPreset({ right: 'left', left: 'right', back: 'front', front: 'back', top: 'bottom', bottom: 'top' }[p]); else setPreset(p);
      }
    }
    gd = null;
  });
  const dragBtn = (el, fn) => {
    let d = null;
    el.addEventListener('pointerdown', e => { d = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => { if (!d) return; fn(e.clientX - d.x, e.clientY - d.y); d = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', () => { d = null; });
  };
  dragBtn($('navZoom'), (dx, dy) => zoom(Math.pow(1.01, dy)));
  dragBtn($('navPan'), (dx, dy) => pan(dx, dy));
  $('navEye').onclick = eyeView;
  $('navOrtho').onclick = frameAll;
}

// =====================================================================
// Files: backup, CSV, screenshot
// =====================================================================
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
async function clearLayout() {
  if (!await askConfirm('置いたボックス・画像・3Dデータ・計測・シーンをすべて消します。（元に戻す で戻せます）', 'すべて消す')) return;
  const ops = ['objects', 'rulers', 'scenes'].flatMap(c => Object.keys(store[c]).map(id => ({ c, id, v: null })));
  setSelection([], null); if (ops.length) commit(ops, '配置をすべて消す');
}
// in-page replacements for confirm() / prompt(), which the published page cannot use
function dialogShell(title, bodyHTML, okLabel) {
  return new Promise(resolve => {
    const bg = document.createElement('div'); bg.className = 'dialog-bg';
    bg.innerHTML = `<div class="dialog"><h3></h3>${bodyHTML}<div class="btns" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-r="0">キャンセル</button><button class="btn primary" data-r="1"></button></div></div>`;
    bg.querySelector('h3').textContent = title; bg.querySelector('[data-r="1"]').textContent = okLabel;
    const inp = bg.querySelector('input');
    const done = ok => { bg.remove(); resolve(ok ? (inp ? inp.value : true) : (inp ? null : false)); };
    bg.querySelectorAll('[data-r]').forEach(b => b.onclick = () => done(b.dataset.r === '1'));
    bg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    document.body.appendChild(bg); (inp || bg.querySelector('[data-r="1"]')).focus(); inp?.select();
  });
}
const askConfirm = (message, okLabel = 'OK') => dialogShell(message, '', okLabel);
const askText = (title, value = '') => dialogShell(title, `<input class="tf" id="askTextInput" value="${String(value).replace(/"/g, '&quot;')}">`, 'OK');
function saveBackup() { download(`layout-${stamp()}.json`, new Blob([JSON.stringify({ app: 'tenji-planner', version: 2, ...store }, null, 1)], { type: 'application/json' })); }
$('jsonIn').onchange = async () => {
  const f = $('jsonIn').files[0]; $('jsonIn').value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!await askConfirm(LOCAL ? '今の配置をこのバックアップで置き換えます。（元に戻す で戻せます）' : '共有中のデータをこのバックアップで置き換えます。全員の画面に反映されます。（元に戻す で戻せます）', '置き換える')) return;
    const ops = [];
    for (const c of Object.keys(store)) {
      for (const id of Object.keys(store[c])) if (!(d[c] || {})[id]) ops.push({ c, id, v: null });
      for (const [id, v] of Object.entries(d[c] || {})) ops.push({ c, id, v });
    }
    setSelection([], null); commit(ops, 'バックアップから復元');
  } catch (err) { toast('読み込めませんでした：' + err.message, 4000); }
};
function exportCSV() {
  const rows = [['名前', '種類', '幅X(mm)', '奥行Y(mm)', '高さZ(mm)', '位置X(mm)', '位置Y(mm)', '位置Z(mm)', '回転Z(°)', '色', 'ファイル', '作成者']];
  for (const [id, v] of Object.entries(store.objects)) {
    const h = userHolders.get(id); const d = h ? dims(h) : new V3();
    rows.push([v.name, { box: 'ボックス', image: '画像', model: '3Dデータ' }[v.type], ...d.toArray().map(x => Math.round(x * 1000)), ...v.loc.map(x => Math.round(x * 1000)), Math.round(v.rot[2] / DEG * 10) / 10, v.color || '', v.asset?.name || '', v.by || '']);
  }
  const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`layout-${stamp()}.csv`, new Blob([csv], { type: 'text/csv' }));
}
function saveScreenshot() { render(true); renderer.domElement.toBlob(b => download(`view-${stamp()}.png`, b)); }

// =====================================================================
// Dialogs, toast
// =====================================================================
let toastTimer;
function toast(msg, ms = 1800) { const t = $('toast'); t.textContent = msg; t.style.opacity = 1; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.opacity = 0, ms); }
function nameDialog() {
  const bg = document.createElement('div'); bg.className = 'dialog-bg';
  let color = prefs.color || PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
  bg.innerHTML = `<div class="dialog"><h3>共同編集で表示する名前</h3><input class="tf" maxlength="20" placeholder="例：池田"><div class="swatches"></div><div class="btns" style="justify-content:flex-end"><button class="btn primary">OK</button></div></div>`;
  const inp = bg.querySelector('input'); inp.value = prefs.name;
  const sw = bg.querySelector('.swatches');
  const paint = () => { sw.innerHTML = ''; for (const c of PEER_COLORS) { const s = document.createElement('div'); s.className = 'sw' + (c === color ? ' on' : ''); s.style.background = c; s.onclick = () => { color = c; paint(); }; sw.appendChild(s); } };
  paint();
  const ok = () => { prefs.name = inp.value.trim() || 'ゲスト'; prefs.color = color; savePrefs(); bg.remove(); location.reload(); };
  bg.querySelector('.btn').onclick = ok; inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') ok(); };
  document.body.appendChild(bg); inp.focus();
}
// user guide (manual.html), shown inside the app
async function openManual() {
  const bg = document.createElement('div'); bg.className = 'dialog-bg'; bg.onclick = e => { if (e.target === bg) bg.remove(); };
  bg.innerHTML = '<div class="dialog manual-dialog"><div class="manual-head"><b>使い方ガイド</b><span class="spacer"></span><button class="btn">閉じる</button></div><div class="manual" id="manualBody">読み込み中…</div></div>';
  bg.querySelector('.btn').onclick = () => bg.remove();
  bg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') bg.remove(); });
  document.body.appendChild(bg); bg.querySelector('.btn').focus();
  try {
    const doc = new DOMParser().parseFromString(await (await fetch('manual.html')).text(), 'text/html');
    bg.querySelector('#manualBody').replaceChildren(...doc.querySelector('main').childNodes);
  } catch { bg.querySelector('#manualBody').textContent = '使い方ガイドを読み込めませんでした。'; }
}
function helpDialog() {
  const bg = document.createElement('div'); bg.className = 'dialog-bg'; bg.onclick = e => { if (e.target === bg) bg.remove(); };
  const rows = [
    ['視点'], ['中ボタンドラッグ / Alt+左ドラッグ', '視点回転'], ['Shift+中 / Shift+Alt+左', '平行移動'], ['ホイール / Ctrl+中', 'ズーム'],
    ['トラックパッド 2本指', '視点回転（Shiftで平行移動・ピンチでズーム）'], ['テンキー 1 / 3 / 7（数字キーでも可）', '前面 / 右面 / 上面（Ctrlで反対側）'],
    ['テンキー 5', '透視投影 ↔ 平行投影'], ['テンキー 0', '目線（スタート地点・床+1600mm）'], ['テンキー . / Home', '選択物を表示 / 全体を表示'], ['Shift+`', 'ウォーク（WASD・QE）'],
    ['選択'], ['左クリック', '選択（Shiftで追加）'], ['左ドラッグ', '矩形選択（Shift追加・Ctrl除外）'], ['A / Alt+A / Ctrl+I', 'すべて / 解除 / 反転'],
    ['編集'], ['G / R / S', '移動 / 回転 / 拡大縮小 → X・Y・Z で軸制限、Shift+軸で平面、数字で値（mm・°・倍率）'], ['Ctrl（操作中）', 'スナップ切替（ヘッダーの磁石で既定値）'],
    ['Shift+D', '複製'], ['X / Delete', '削除'], ['H / Alt+H / Shift+H', '隠す / すべて表示 / 選択以外を隠す'], ['Shift+A', '追加メニュー'], ['Shift+右クリック', '3Dカーソルを置く（壁に置くと画像が壁に掛かる）'],
    ['F2', '名前を変更'], ['Ctrl+Z / Ctrl+Shift+Z', '元に戻す / やり直す'], ['N / T', 'サイドバー / ツールバー'], ['Alt+Z', 'X線'], ['M', '計測ツール'],
    ['ファイル'], ['ドラッグ＆ドロップ', 'glb・gltf・obj・fbx・stl・png・jpg を読み込み'], ['Ctrl+S', 'バックアップ保存（JSON）'],
  ];
  bg.innerHTML = `<div class="dialog" style="width:min(640px,calc(100vw - 32px))"><h3>操作方法</h3><p class="note" style="margin:-6px 0 8px">キー操作はBlenderとほぼ同じ配置です。</p><div class="keymap">${rows.map(r => r.length === 1 ? `<h4>${r[0]}</h4>` : `<b>${r[0]}</b><span>${r[1]}</span>`).join('')}</div><div class="btns" style="justify-content:flex-end;margin-top:12px"><button class="btn primary">閉じる</button></div></div>`;
  bg.querySelector('.btn').onclick = () => bg.remove();
  document.body.appendChild(bg);
}

// =====================================================================
// Render loop
// =====================================================================
const tmpV = new V3();
function render(force) {
  if (!needsRender && !force) return;
  needsRender = false;
  // keep ruler dots a constant on-screen size
  const px = p => (nav.ortho ? (ortho.top - ortho.bottom) : 2 * camera.position.distanceTo(p) * Math.tan(persp.fov * DEG / 2)) / viewport.clientHeight;
  for (const g of [...rulerObjs.values(), tempRuler].filter(Boolean)) for (const d of [g.userData.da, g.userData.db]) d.scale.setScalar(px(d.getWorldPosition(tmpV)) * 3.5);
  sky.position.copy(camera.position);
  composer.render(); labelRenderer.render(scene, camera); updateCursorEl(); drawGizmo();
}
renderer.setAnimationLoop(() => render());

// =====================================================================
// Start
// =====================================================================
renderToolbar(); setHints(); applyClip(); applyLook(); updateCamera(); setVCB('距離', ''); scheduleUI();
$('helpBtn').onclick = openManual;
if (!prefs.guideShown) { prefs.guideShown = true; savePrefs(); setTimeout(() => toast('はじめての方は、右上の「？」から使い方ガイドを開けます', 6000), 2500); }
if (LOCAL || prefs.name) connect(); else nameDialog();
window.planner = { store, selected, nav, camera: () => camera, holderOf, setSelection, commit, startModal };   // for debugging

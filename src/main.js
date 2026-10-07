import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  SHAPES, DEG, MOVE, normPlat, localParts, worldParts, partsBounds, supportY, stepBody,
  shapeCount, shapeDef, setCustomShapes, isSimplePolygon, chainOk, normalizeShape,
} from './shapes.js';
import { paintSky, SUN } from './sky.js';
import { createClouds } from './clouds.js';
import { generate, rngFrom, STYLES, DIFFS } from './gen.js';

const $ = (id) => document.getElementById(id);

// ---------- Рендер в стиле N64 ----------
const RES_H = 240;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
$('game').appendChild(renderer.domElement);

function drawTex(size, draw, repeat = false) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Небо: рисуется один раз в картинку 360x180 и используется как фон сцены
function makeSky() {
  const W = 1024, H = 512, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H);
  paintSky(img.data, W, H);
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

const scene = new THREE.Scene();
scene.background = makeSky();
scene.fog = new THREE.Fog(0xb0d8ff, 24, 150);
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 250);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.AmbientLight(0xffffff, 0.3));
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(5, 10, 6); // то же направление, что у солнца на небе (см. sky.js)
scene.add(sun);

// Динамический ambient occlusion. Слабо/сильно: меняйте kernelRadius и maxDistance
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const ssao = new SSAOPass(scene, camera, 320, RES_H);
ssao.kernelRadius = 2.5;
composer.addPass(ssao);
composer.addPass(new OutputPass());

// Дальность камеры. Пороги SSAO заданы в долях дальности, поэтому пересчитываем их вместе с ней
function setFar(f) {
  camera.far = f; camera.updateProjectionMatrix();
  ssao.minDistance = 0.125 / f; ssao.maxDistance = 3 / f;
}
setFar(250);

// Редакторские подсказки (сетка, призрак, пунктир, контуры) не должны давать тень в SSAO
let outlines = [];
const helpers = new THREE.Group();
helpers.visible = false;
scene.add(helpers);
const marker = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 6), new THREE.MeshBasicMaterial({ color: 0xff2222 }));
marker.visible = false; scene.add(marker);
{
  const ssaoRender = ssao.render.bind(ssao);
  ssao.render = (...args) => {
    const hide = [helpers, marker, ...outlines], was = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    ssaoRender(...args);
    hide.forEach((o, i) => (o.visible = was[i]));
  };
}

function resize() {
  const w = Math.round(RES_H * innerWidth / innerHeight);
  renderer.setSize(w, RES_H, false);
  composer.setSize(w, RES_H);
  camera.aspect = w / RES_H;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const mat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
const box = (parent, w, h, d, m, x, y, z) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z); parent.add(o); return o;
};

const clouds = createClouds(scene);

// ---------- PBR-материалы ----------
// У платформ физически корректный материал (MeshStandardMaterial): шероховатость и металличность берутся
// из карты, а отражения — из того же неба, что нарисовано на фоне, с усиленным солнцем.
// Поэтому плитки блестят на солнце и ловят блики при движении камеры.
const TILE_M = 2; // метров на одно повторение текстуры: размер плитки не зависит от размера платформы
const maxAniso = renderer.capabilities.getMaxAnisotropy();

function mapTex(size, fn, srgb) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4, px = fn(x, y);
    img.data[o] = px[0]; img.data[o + 1] = px[1]; img.data[o + 2] = px[2]; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;               // пиксельный вид, как на N64
  t.minFilter = THREE.LinearMipmapLinearFilter;    // но без мерцания вдали
  t.anisotropy = Math.min(4, maxAniso);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

// Плитка 64x64 = 2x2 клетки по 1 м, в клетках швы. Карты: цвет, «шероховатость/металл» (G/B), рельеф.
const TS = 64, tileR = rngFrom('tiles');
const flake = new Uint8Array(TS * TS).map(() => (tileR() < 0.05 ? 1 : 0)); // металлические блёстки
const cellOf = (x, y) => ((x >> 5) + (y >> 5)) & 1;
const seam = (x, y) => (x & 31) < 2 || (y & 31) < 2;
const bevel = (x, y) => (x & 31) === 2 || (y & 31) === 2;
const noise = (x, y) => ((x * 73856093) ^ (y * 19349663)) & 15;
const albedoTex = mapTex(TS, (x, y) => {
  const c = Math.max(0, Math.min(255, (seam(x, y) ? 150 : cellOf(x, y) ? 205 : 255) + noise(x, y) - 8));
  return [c, c, c];
}, true);
const ormTex = mapTex(TS, (x, y) => {
  if (seam(x, y)) return [255, 255, 0];
  if (flake[y * TS + x]) return [255, 60, 255];
  return cellOf(x, y) ? [255, 215, 70] : [255, 185, 120];
}, false);
const bumpTex = mapTex(TS, (x, y) => { const h = seam(x, y) ? 40 : bevel(x, y) ? 230 : 150 + noise(x, y); return [h, h, h]; }, false);

// Окружение для отражений: то же небо, но солнце ярче 1.0 (HDR), чтобы блики были настоящими
function makeEnv() {
  const W = 512, H = 256, px = new Uint8ClampedArray(W * H * 4);
  paintSky(px, W, H);
  const half = new Uint16Array(W * H * 4), toH = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < H; j++) {
    const lat = (0.5 - (j + 0.5) / H) * Math.PI, y = Math.sin(lat), c = Math.cos(lat), row = H - 1 - j;
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      const sd = c * Math.cos(phi) * SUN[0] + y * SUN[1] + c * Math.sin(phi) * SUN[2];
      const boost = sd > 0 ? 1 + 2 * Math.pow(sd, 30) + 18 * Math.pow(sd, 1500) : 1;
      const o = (j * W + i) * 4, d = (row * W + i) * 4;
      for (let k = 0; k < 3; k++) half[d + k] = toH(Math.pow(px[o + k] / 255, 2.2) * boost);
      half[d + 3] = toH(1);
    }
  }
  const t = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  const pm = new THREE.PMREMGenerator(renderer), rt = pm.fromEquirectangular(t);
  t.dispose(); pm.dispose();
  return rt.texture;
}
const envTex = makeEnv();

// Темы платформ: цвета + «характер» поверхности (rough/metal умножаются на карту)
const THEMES = [
  { name: 'Классика', colors: [0x4caf50, 0xff9800, 0x42a5f5, 0xe91e63, 0xffeb3b], rough: 0.5, metal: 0.45, env: 1.0 },
  { name: 'Лёд', colors: [0x9fd8ff, 0xc8ecff, 0x7fc4f0, 0xe6f7ff, 0xa8b8ff], rough: 0.22, metal: 0.1, env: 1.4 },
  { name: 'Золото', colors: [0xffd24d, 0xffb300, 0xe6c36a, 0xd9a441, 0xfff0a0], rough: 0.32, metal: 1.0, env: 1.3 },
  { name: 'Вулкан', colors: [0x8a3b2a, 0xb5502f, 0x5b3a35, 0xd9622b, 0x6e4a40], rough: 0.75, metal: 0.35, env: 0.9 },
  { name: 'Конфеты', colors: [0xff7eb6, 0x7ee8c0, 0xffe27e, 0xb59cff, 0x7fd3ff], rough: 0.28, metal: 0.15, env: 1.2 },
  { name: 'Нефрит', colors: [0x2e9b6a, 0x3fb58a, 0x1f7a5a, 0x66d19e, 0x8fe3b8], rough: 0.3, metal: 0.3, env: 1.2 },
];
const platMat = (color, th) => new THREE.MeshStandardMaterial({
  color, map: albedoTex, roughnessMap: ormTex, metalnessMap: ormTex, bumpMap: bumpTex, bumpScale: 0.6,
  roughness: th.rough, metalness: th.metal, vertexColors: true, envMap: envTex, envMapIntensity: th.env,
});
const gloss = (color, rough, metal, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMap: envTex, envMapIntensity: 1.2, ...extra });

// ---------- Сохранение: только рекорды ----------
const SAVE_KEY = 'n64parkour.v1';
let save = { best: {}, skin: null };
try {
  const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
  if (s.best && typeof s.best === 'object') save.best = s.best;
  if (s.skin && typeof s.skin === 'object') save.skin = s.skin;
} catch { /* без сохранений тоже работает */ }
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* ignore */ } }

// ---------- Уровни: формат, кодирование ----------
// Уровень: { name, plats, coins, cps (чекпоинты), goal, start, shapes (свои формы), req (монеты обязательны), theme }
function classic() {
  const plats = [[0, 0, 0, 8, 8], [0, 0.5, -8, 4, 4], [3, 1.2, -13, 3, 3], [-1, 2, -18, 3, 3],
    [-5, 2.5, -23, 3, 3], [-5, 3.5, -28, 2.5, 2.5], [0, 4.2, -30, 3, 3], [5, 5, -32, 3, 3],
    [10, 6, -36, 2.5, 2.5], [10, 6.5, -42, 1.5, 6], [10, 7.5, -50, 6, 6]];
  return {
    id: 'classic', name: 'Классика', plats, coins: plats.slice(1, 10).map(([x, y, z]) => [x, y + 1.3, z]),
    cps: [], shapes: [], req: false, theme: 0, goal: [10, 9.1, -50], start: [0, 0, 0],
  };
}

// Платформа в полном виде: [x, y, z, ширина, глубина, форма, поворот, наклон, толщина]
const fullP = (a) => [a[0], a[1], a[2], a[3], a[4], a[5] ?? 0, a[6] ?? 0, a[7] ?? 0, a[8] ?? 1];
// В ссылках и кодах храним без хвоста значений по умолчанию, чтобы коды были короче
const trimP = (a) => {
  const b = fullP(a), dflt = [0, 0, 0, 0, 0, 0, 0, 0, 1];
  while (b.length > 5 && b[b.length - 1] === dflt[b.length - 1]) b.pop();
  return b;
};

// Проверка чужих уровней (из ссылки, кода, Мастерской)
function sanitize(j) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const ok = (a, n, lo, hi) => Array.isArray(a) && a.length === n && a.every((v) => num(v) && v >= lo && v <= hi);
  if (!j || !Array.isArray(j.p) || !j.p.length || j.p.length > 80) return null;
  const shapes = Array.isArray(j.sh) ? j.sh : [];
  const okShape = (poly) => Array.isArray(poly) && poly.length >= 3 && poly.length <= 40
    && poly.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((v) => num(v) && Math.abs(v) <= 0.5001))
    && isSimplePolygon(poly);
  if (shapes.length > 24 || !shapes.every(okShape)) return null;
  const nShapes = SHAPES.length + shapes.length;
  const okP = (a) => Array.isArray(a) && a.length >= 5 && a.length <= 9 && a.every(num)
    && a.slice(0, 3).every((v) => Math.abs(v) <= 300)
    && a[3] >= 1 && a[3] <= 30 && a[4] >= 1 && a[4] <= 30
    && (a[5] === undefined || (Number.isInteger(a[5]) && a[5] >= 0 && a[5] < nShapes))
    && (a[6] === undefined || Math.abs(a[6]) <= 720)
    && (a[7] === undefined || Math.abs(a[7]) <= 60)
    && (a[8] === undefined || (a[8] >= 0.25 && a[8] <= 20));
  if (!j.p.every(okP)) return null;
  const c = Array.isArray(j.c) ? j.c.slice(0, 100) : [];
  const f = Array.isArray(j.f) ? j.f.slice(0, 20) : [];
  if (!c.every((a) => ok(a, 3, -300, 300)) || !f.every((a) => ok(a, 3, -300, 300))) return null;
  if (!ok(j.g, 3, -300, 300) || !ok(j.s, 3, -300, 300)) return null;
  return {
    name: String(j.n || 'Без названия').slice(0, 40), plats: j.p.map(fullP), coins: c, cps: f, goal: j.g, start: j.s,
    shapes, req: !!j.q, theme: Number.isInteger(j.th) && j.th >= 0 && j.th < THEMES.length ? j.th : 0,
  };
}
const enc = (lv) => btoa(unescape(encodeURIComponent(JSON.stringify({
  n: lv.name, p: lv.plats.map(trimP), c: lv.coins, g: lv.goal, s: lv.start,
  ...(lv.cps && lv.cps.length ? { f: lv.cps } : {}),
  ...(lv.shapes && lv.shapes.length ? { sh: lv.shapes } : {}),
  ...(lv.req ? { q: 1 } : {}),
  ...(lv.theme ? { th: lv.theme } : {}),
})))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function dec(code) {
  try { return sanitize(JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g, '+').replace(/_/g, '/')))))); }
  catch { return null; }
}

// Идентификатор уровня для рекордов
function lvId(lv) {
  if (lv.id) return lv.id;
  if (lv.seed) return `S:${lv.seed}:${lv.style || 'mix'}:${lv.diff || 2}`;
  const a = [lv.plats.map(trimP), lv.coins, lv.goal, lv.start];
  if (lv.req || (lv.shapes && lv.shapes.length) || (lv.cps && lv.cps.length) || lv.theme) a.push([!!lv.req, lv.shapes || [], lv.cps || [], lv.theme | 0]);
  const s = JSON.stringify(a);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'H:' + (h >>> 0).toString(36);
}

// ---------- Построение уровня ----------
const coinGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 8).rotateX(Math.PI / 2);
const coinMat = gloss(0xffd800, 0.28, 1, { emissive: 0x2a1c00 });
const goalGeo = new THREE.IcosahedronGeometry(0.7, 0);
const goalMat = gloss(0xfff176, 0.22, 0.9, { emissive: 0x6a4a00 });
const goalLockedMat = new THREE.MeshBasicMaterial({ color: 0x8a94b0, wireframe: true }); // звезда закрыта, пока не собраны все монеты (если включено в уровне)
const outlineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 });
const flagGeo = new THREE.CylinderGeometry(0.2, 0.2, 2.4, 6), clothGeo = new THREE.BoxGeometry(0.9, 0.55, 0.06);
const flagOff = new THREE.MeshLambertMaterial({ color: 0x9aa4b8 });
const flagOn = new THREE.MeshLambertMaterial({ color: 0x3ddc68, emissive: 0x0a4a1a });
const orbit = { cx: 0, cz: 0, rx: 15, rz: 15, top: 0 };
let L, levelGroup = new THREE.Group(), parts = [], platMeshes = [], coins = [], flags = [], goal, goalOpen = true, voidY = -15;
scene.add(levelGroup);

// Геометрия платформы из выпуклых частей. Градиент по вершинам (как Gouraud на N64):
// светлее сверху и в центре платформы, темнее к краям и вниз.
// Текстура кладётся по метрам (TILE_M метров на повторение), а не по размеру платформы:
// при растягивании платформы плитки не растягиваются, а просто добавляются.
// На пандусе текстура считается вдоль поверхности (умножаем на sec), чтобы не растягивалась и на наклоне.
// g — тангенс наклона: верх поднимается в сторону -Z.
function platGeometry(lparts, g) {
  const pos = [], nor = [], col = [], uv = [];
  const K = 1 / TILE_M, sec = Math.sqrt(1 + g * g);
  let gx = 0, gz = 0, cnt = 0;
  for (const q of lparts) for (const [x, z] of q.poly) { gx += x; gz += z; cnt++; }
  gx /= cnt; gz /= cnt;
  let R = 0.001;
  for (const q of lparts) for (const [x, z] of q.poly) R = Math.max(R, Math.hypot(x - gx, z - gz));
  const lit = (x, z) => 1 - 0.3 * Math.min(1, Math.hypot(x - gx, z - gz) / R);

  // внутренние швы между частями одной высоты (общие рёбра) не рисуем
  const key = (a, b, dy) => {
    const A = `${Math.round(a[0] * 1e4)},${Math.round(a[1] * 1e4)}`, B = `${Math.round(b[0] * 1e4)},${Math.round(b[1] * 1e4)}`;
    return (A < B ? A + '|' + B : B + '|' + A) + '|' + dy;
  };
  const edgeCount = new Map();
  for (const q of lparts) for (let i = 0; i < q.poly.length; i++) {
    const k = key(q.poly[i], q.poly[(i + 1) % q.poly.length], q.dy);
    edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
  }

  // вершина: [x, y, z, яркость, u, v]
  const tri = (A, B, C, want) => {
    const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2];
    const e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) { [B, C] = [C, B]; nx = -nx; ny = -ny; nz = -nz; }
    for (const V of [A, B, C]) {
      pos.push(V[0], V[1], V[2]); nor.push(nx, ny, nz); col.push(V[3], V[3], V[3]); uv.push(V[4], V[5]);
    }
  };
  for (const q of lparts) {
    const P = q.poly, n = P.length;
    let cx = 0, cz = 0;
    for (const [x, z] of P) { cx += x; cz += z; }
    cx /= n; cz /= n;
    const yt = (z) => q.dy - g * z, yb = (z) => yt(z) - q.T;
    const top = (x, z, b) => [x, yt(z), z, b, x * K, z * K * sec];
    const bot = (x, z) => [x, yb(z), z, 0.3, x * K, z * K];
    // верх (веером из центра) и низ
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      tri(top(cx, cz, lit(cx, cz)), top(a[0], a[1], lit(a[0], a[1])), top(b[0], b[1], lit(b[0], b[1])), [0, 1, 0]);
      tri(bot(cx, cz), bot(a[0], a[1]), bot(b[0], b[1]), [0, -1, 0]);
    }
    // стены в два ряда по высоте
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      if (edgeCount.get(key(a, b, q.dy)) > 1) continue;
      const ex = b[0] - a[0], ez = b[1] - a[1], el = Math.hypot(ex, ez) || 1;
      const want = [(a[0] + b[0]) / 2 - cx, 0, (a[1] + b[1]) / 2 - cz];
      const V = (pt, t) => {
        const y = yb(pt[1]) + (yt(pt[1]) - yb(pt[1])) * t;
        return [pt[0], y, pt[1], 0.35 + 0.35 * t, ((pt[0] * ex + pt[1] * ez) / el) * K, y * K];
      };
      for (const [t0, t1] of [[0, 0.5], [0.5, 1]]) {
        tri(V(a, t0), V(b, t0), V(b, t1), want);
        tri(V(a, t0), V(b, t1), V(a, t1), want);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  return geo;
}

function setGoalOpen(open) {
  goalOpen = open;
  if (goal) goal.material = open ? goalMat : goalLockedMat;
}
function setFlag(i, on) {
  const f = flags[i];
  if (f) f.material = f.children[0].material = on ? flagOn : flagOff;
}

let hoverObj = null;
function buildLevel(lv) {
  scene.remove(levelGroup);
  levelGroup.traverse((o) => { if (o.userData.own) o.geometry.dispose(); if (o.userData.ownMat) o.material.dispose(); });
  levelGroup = new THREE.Group(); scene.add(levelGroup);
  parts = []; platMeshes = []; coins = []; flags = []; outlines = []; hoverObj = null;
  setCustomShapes(lv.shapes || []);
  const th = THEMES[lv.theme | 0] || THEMES[0];
  lv.plats.forEach((a, i) => {
    const pl = normPlat(a);
    const geo = platGeometry(localParts(pl), Math.tan(pl.t * DEG));
    const m = new THREE.Mesh(geo, platMat(th.colors[i % th.colors.length], th));
    m.position.set(pl.x, pl.y, pl.z); m.rotation.y = pl.r * DEG;
    m.userData = { k: 'p', i, own: true, ownMat: true };
    const ol = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), outlineMat);
    ol.userData = { k: 'o', own: true }; ol.visible = mode === 'edit';
    m.add(ol); outlines.push(ol);
    levelGroup.add(m); platMeshes.push(m);
    parts.push(...worldParts(pl));
  });
  lv.coins.forEach(([x, y, z], i) => {
    const c = new THREE.Mesh(coinGeo, coinMat);
    c.position.set(x, y, z); c.userData = { k: 'c', i };
    levelGroup.add(c); coins.push(c);
  });
  (lv.cps || []).forEach(([x, y, z], i) => {
    const f = new THREE.Mesh(flagGeo, flagOff);
    f.position.set(x, y + 1.2, z); f.userData = { k: 'f', i };
    const cloth = new THREE.Mesh(clothGeo, flagOff); cloth.position.set(0.55, 0.85, 0);
    f.add(cloth); levelGroup.add(f); flags.push(f);
  });
  goal = new THREE.Mesh(goalGeo, goalMat);
  goal.position.set(...lv.goal); goal.userData = { k: 'g' };
  levelGroup.add(goal);
  setGoalOpen(true);
  marker.position.set(lv.start[0], lv.start[1] + 0.6, lv.start[2]);

  const B = partsBounds(parts);
  orbit.cx = (B.minX + B.maxX) / 2; orbit.cz = (B.minZ + B.maxZ) / 2;
  orbit.rx = Math.max(15, (B.maxX - B.minX) / 2); orbit.rz = Math.max(15, (B.maxZ - B.minZ) / 2);
  orbit.top = B.hi;
  voidY = B.lo - 12;
  clouds.setBands({ cx: orbit.cx, cz: orbit.cz, r: Math.max(orbit.rx, orbit.rz) + 100, low: B.lo, high: B.hi });
  refreshShapeButtons();
}

// ---------- Игрок и раскраски ----------
// Каждая часть тела — отдельный PBR-материал, поэтому скин меняет не только цвет, но и блеск (металл, глянец).
const SKIN_KEYS = ['legs', 'shirt', 'head', 'cap', 'belt'];
const SKINS = [
  { name: 'Классика', legs: 0x1565c0, shirt: 0xd32f2f, head: 0xffcc99, cap: 0xd32f2f, belt: 0x5d4037 },
  { name: 'Зелёный', legs: 0x1a237e, shirt: 0x2e9b3a, head: 0xffcc99, cap: 0x2e9b3a, belt: 0x5d4037 },
  { name: 'Ниндзя', legs: 0x1c1c1c, shirt: 0x2b2b2b, head: 0xf0c8a0, cap: 0x8e0000, belt: 0xb71c1c },
  { name: 'Космонавт', legs: 0xe0e0e0, shirt: 0xf5f5f5, head: 0x37474f, cap: 0xeeeeee, belt: 0xff6f00, rough: 0.3, metal: 0.25 },
  { name: 'Золотой рыцарь', legs: 0xb8860b, shirt: 0xffd24d, head: 0xffe08a, cap: 0xffc107, belt: 0x8d6e00, rough: 0.25, metal: 1 },
  { name: 'Хром', legs: 0xb0bec5, shirt: 0xe0e6ea, head: 0xcfd8dc, cap: 0x90a4ae, belt: 0x455a64, rough: 0.12, metal: 1 },
  { name: 'Ледяной', legs: 0x4aa3e0, shirt: 0xbfe8ff, head: 0xe3f6ff, cap: 0x7fc4f0, belt: 0x2f6f9f, rough: 0.15, metal: 0.2 },
  { name: 'Клубника', legs: 0xf8bbd0, shirt: 0xe91e63, head: 0xffe0b2, cap: 0xc2185b, belt: 0x6a1b9a, rough: 0.3, metal: 0.1 },
  { name: 'Вулкан', legs: 0x3e2723, shirt: 0xd9622b, head: 0xe0a070, cap: 0x8a3b2a, belt: 0xffb300, rough: 0.7, metal: 0.3 },
  { name: 'Призрак', legs: 0xdedede, shirt: 0xffffff, head: 0xf5f5f5, cap: 0xcfd8ff, belt: 0x9fa8da, rough: 0.2, metal: 0 },
  { name: 'Радужный (анимация)', legs: 0x1565c0, shirt: 0xd32f2f, head: 0xffcc99, cap: 0xd32f2f, belt: 0xffffff, rough: 0.25, metal: 0.4, rainbow: true },
];
const player = new THREE.Group();
const skinMats = {};
const skinPart = (key, w, h, d, x, y, z) => { skinMats[key] = skinMats[key] || gloss(0xffffff, 0.55, 0.1, { flatShading: true }); box(player, w, h, d, skinMats[key], x, y, z); };
const darkMat = gloss(0x111111, 0.4, 0, { flatShading: true });
skinPart('legs', 0.6, 0.4, 0.35, 0, 0.2, 0);          // штаны и ботинки
skinPart('shirt', 0.7, 0.6, 0.4, 0, 0.7, 0);          // майка
skinPart('belt', 0.74, 0.1, 0.44, 0, 0.42, 0);        // пояс
skinPart('head', 0.45, 0.45, 0.45, 0, 1.25, 0);       // голова
skinPart('cap', 0.5, 0.15, 0.5, 0, 1.55, 0);          // кепка
skinPart('cap', 0.46, 0.05, 0.22, 0, 1.5, 0.32);      // козырёк
box(player, 0.07, 0.09, 0.04, darkMat, -0.1, 1.28, 0.23); // глаза
box(player, 0.07, 0.09, 0.04, darkMat, 0.1, 1.28, 0.23);
scene.add(player);

let skin = SKINS[0], skinId = 0;
function applySkin(sk) {
  skin = sk;
  for (const k of SKIN_KEYS) {
    const m = skinMats[k];
    m.color.setHex(sk[k]); m.roughness = sk.rough ?? 0.55; m.metalness = sk.metal ?? 0.1;
  }
}
// «Радужный» скин: цвета плавно переливаются по кругу (у каждой части свой сдвиг)
function skinAnim(t) {
  if (!skin.rainbow) return;
  SKIN_KEYS.forEach((k, i) => { if (k !== 'belt') skinMats[k].color.setHSL((t * 0.15 + i * 0.2) % 1, 0.85, 0.55); });
}
const hexStr = (n) => '#' + n.toString(16).padStart(6, '0');
function syncSkinUI() {
  $('skinSel').value = String(skinId);
  const ids = { legs: 'skLegs', shirt: 'skShirt', head: 'skHead', cap: 'skCap', belt: 'skBelt' };
  for (const k of SKIN_KEYS) $(ids[k]).value = hexStr(skin[k]);
}
function chooseSkin(id) {
  skinId = id;
  if (id === 'custom') { const c = save.skin && save.skin.colors; applySkin({ name: 'Свои цвета', ...(c || SKINS[0]) }); }
  else applySkin(SKINS[id]);
  save.skin = id === 'custom' ? { id, colors: Object.fromEntries(SKIN_KEYS.map((k) => [k, skin[k]])) } : { id };
  persist(); syncSkinUI();
}
function customSkin(colors) {
  save.skin = { id: 'custom', colors };
  chooseSkin('custom');
}
const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.5, 8).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 })
);
scene.add(shadow);


// ---------- Драконы ----------
const dragonRoot = new THREE.Group(); // чтобы разом прятать драконов в редакторе
scene.add(dragonRoot);
const scaleTex = drawTex(32, (g) => {
  g.fillStyle = '#222'; g.fillRect(0, 0, 32, 32);
  for (let y = 0; y < 8; y++) for (let x = -1; x < 8; x++) {
    const px = x * 4 + (y % 2) * 2, py = y * 4;
    const gr = g.createLinearGradient(0, py, 0, py + 3);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#8a8a8a');
    g.fillStyle = gr; g.fillRect(px, py, 3, 3);
  }
}, true);
scaleTex.repeat.set(3, 2);
const glitter = drawTex(32, (g) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, 32, 32); g.fillStyle = '#fff';
  for (let i = 0; i < 28; i++) g.fillRect((Math.random() * 32) | 0, (Math.random() * 32) | 0, 1, 1);
}, true);
glitter.repeat.set(2, 2);

const sparkleMats = [];
const mk = (color, extra = {}) => {
  const m = new THREE.MeshPhongMaterial({ color, map: scaleTex, specular: 0xffffff, shininess: 90, flatShading: true,
    emissive: 0xfff2b0, emissiveMap: glitter, emissiveIntensity: 0.5, ...extra });
  sparkleMats.push(m); return m;
};
function wingGeo(pts) {
  const s = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  const g = new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.1, uv.getY(i) * 0.1);
  return g;
}
const innerG = wingGeo([[0, -1], [9, -2], [9, 6], [4, 7], [0, 5]]);
const outerG = wingGeo([[0, -2], [13, -5], [11, 1], [8, 4], [4, 3], [0, 6]]);
const ball = new THREE.SphereGeometry(1, 7, 5);
const spikeG = new THREE.ConeGeometry(0.3, 0.9, 4);
const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffee00 });
const dragons = [];

// f: во сколько раз орбита шире уровня, h: высота полёта, spd: скорость (знак = направление)
function makeDragon(color, f, h, spd, ph) {
  const body = mk(color), bone = mk(0xe8dcc0);
  const dark = mk(new THREE.Color(color).multiplyScalar(0.6), { side: THREE.DoubleSide });
  const d = { f, h, spd, a: ph, ph, segs: [], wings: [] };
  for (let i = 0; i < 20; i++) {
    const r = 2.4 * (1 - i / 24) + 0.3;
    const s = new THREE.Mesh(ball, body);
    s.scale.set(r, r * 0.9, r * 1.6);
    const sp = new THREE.Mesh(spikeG, bone); sp.position.y = 1.05; s.add(sp);
    dragonRoot.add(s); d.segs.push(s);
  }
  d.head = new THREE.Group();
  box(d.head, 2.6, 2, 3.2, body, 0, 0, 0);
  box(d.head, 1.7, 1.1, 2.4, body, 0, -0.35, 2.5);
  for (const sd of [-1, 1]) {
    const hn = new THREE.Mesh(new THREE.ConeGeometry(0.35, 2.6, 5), bone);
    hn.position.set(sd, 1.3, -0.8); hn.rotation.x = -1; d.head.add(hn);
    box(d.head, 0.3, 0.4, 0.6, eyeMat, sd * 1.32, 0.5, 0.8);
  }
  dragonRoot.add(d.head);
  d.shoulder = new THREE.Group();
  for (const side of [1, -1]) {
    const inner = new THREE.Group(); inner.position.set(side * 2.2, 1.2, 0); inner.scale.x = side;
    inner.add(new THREE.Mesh(innerG, dark));
    const outer = new THREE.Group(); outer.position.x = 9;
    outer.add(new THREE.Mesh(outerG, dark));
    inner.add(outer); d.shoulder.add(inner);
    d.wings.push([inner, outer, side]);
  }
  dragonRoot.add(d.shoulder);
  dragons.push(d);
}
makeDragon(0x2e9b4a, 1.0, 4, 11, 0);
makeDragon(0xc0392b, 1.4, 8, -14, 2);
makeDragon(0x7b3fc9, 1.9, 12, 9, 4);

const P1 = new THREE.Vector3(), Q1 = new THREE.Vector3();
function updateDragons(dt, time) {
  if (!dragonRoot.visible) return;
  glitter.offset.x += dt * 0.12; glitter.offset.y -= dt * 0.05;
  const tw = 0.5 + 0.4 * Math.sin(time * 5);
  sparkleMats.forEach((m) => (m.emissiveIntensity = tw));
  for (const d of dragons) {
    // орбита подстраивается под размер текущего уровня
    const rx = orbit.rx * d.f + 32, rz = orbit.rz * d.f + 32, avg = (rx + rz) / 2;
    const s = Math.sign(d.spd), gap = 3.4 / avg, y0 = d.h + orbit.top * 0.5;
    d.a += (d.spd / avg) * dt;
    const at = (a, o) => o.set(orbit.cx + rx * Math.cos(a), y0 + 3 * Math.sin(2 * a), orbit.cz + rz * Math.sin(a));
    const place = (o, a) => { at(a, P1); at(a + s * 0.02, Q1); o.position.copy(P1); o.lookAt(Q1); };
    place(d.head, d.a);
    d.segs.forEach((seg, i) => place(seg, d.a - s * (i + 1) * gap));
    d.shoulder.position.copy(d.segs[3].position);
    d.shoulder.quaternion.copy(d.segs[3].quaternion);
    d.wings.forEach(([inner, outer, side]) => {
      inner.rotation.z = side * Math.sin(time * 4.2 + d.ph) * 0.6;
      outer.rotation.z = Math.sin(time * 4.2 + d.ph - 1) * 0.5;
    });
  }
}

// ---------- Физика и состояние ----------
const { SPEED, JUMP, GRAV } = MOVE;
const p = new THREE.Vector3(), v = new THREE.Vector3(), tmp = new THREE.Vector3();
const st = { onGround: false, landed: false, landVy: 0 };
let coyote = 0, face = 0, got = 0, time = 0, won = false;

const keys = {};
let mode = 'play', jumpBuf = 0, camA = 0, snapCam = false, clockT = 0, testRun = false, levelId = '';
let goalToastAt = 0, spawn = [0, 0, 0], cpIdx = -1, lastHud = '';
const hud = $('hud'), msg = $('msg');
const mouse = new THREE.Vector2();

const HELP_PLAY = 'WASD: бег. Пробел: прыжок. Q/E, стрелки или мышь с зажатой кнопкой: камера. R: заново. M: меню. Флажок — чекпоинт.';
const HELP_EDIT = 'ЛКМ клик: поставить. ЛКМ тянуть: вращать камеру. ПКМ тянуть: двигать. ПКМ клик: стереть. Колесо: зум. Shift+колесо или Z/X: высота. R: повернуть. F: вся карта. Ctrl+Z: отмена. Своя форма: клики по точкам, Enter — замкнуть, Backspace/ПКМ — убрать точку, Esc — отмена. M: меню.';

let toastT;
function toast(t, ms = 2200) {
  const el = $('toast');
  el.textContent = t; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms);
}

function reset() {
  spawn = L.start.slice(); cpIdx = -1;
  flags.forEach((_, i) => setFlag(i, false));
  p.set(...spawn); v.set(0, 0, 0); st.onGround = false;
  got = 0; time = 0; won = false; jumpBuf = 0; coyote = 0;
  coins.forEach((c) => (c.visible = true));
  setGoalOpen(!L.req || coins.length === 0); // звезда закрыта только если в уровне включены обязательные монеты
  levelId = lvId(L);
  msg.style.display = 'none';
  snapCam = true;
}
function respawn() { p.set(...spawn); v.set(0, 0, 0); st.onGround = false; snapCam = true; }

addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  keys[e.code] = true;
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'KeyM') $('panel').classList.toggle('hide');
  if (mode === 'play') {
    if (e.code === 'Space') jumpBuf = 0.15;
    if (e.code === 'KeyR') reset();
  } else {
    if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); return; }
    if (e.code === 'Enter' && ed.tool === 'draw') { e.preventDefault(); finishDraw(); }
    if (e.code === 'Escape') cancelDraw();
    if (e.code === 'Backspace' && ed.tool === 'draw') { e.preventDefault(); undoDrawPoint(); }
    if (e.code === 'KeyZ') { ed.h -= 0.5; syncUI(); }
    if (e.code === 'KeyX') { ed.h += 0.5; syncUI(); }
    if (e.code === 'KeyR') { ed.rot = (ed.rot + (e.shiftKey ? -15 : 15) + 360) % 360; ed.dirty = true; syncUI(); }
    if (e.code === 'KeyF') fitView();
    const ti = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7'].indexOf(e.code);
    if (ti >= 0) setTool(TOOLS[ti][0]);
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
addEventListener('mousemove', (e) => {
  if (mode === 'play' && e.buttons) camA -= e.movementX * 0.005;
});

function win() {
  won = true;
  const total = coins.length;
  let extra = '';
  if (testRun) extra = '<br>Тест уровня: рекорд не сохраняется';
  else {
    const prev = save.best[levelId];
    if (prev == null || time < prev) { save.best[levelId] = time; extra += '<br>Новый рекорд!'; }
    else extra += `<br>Рекорд: ${prev.toFixed(1)} с`;
    persist();
  }
  msg.style.display = 'flex';
  msg.innerHTML = `ЗВЕЗДА!<br>Время: ${time.toFixed(1)} с${total ? `, монет: ${got}/${total}` : ''}${extra}<br>R: сыграть ещё`;
}

function update(dt) {
  camA += ((keys.ArrowLeft || keys.KeyQ ? 1 : 0) - (keys.ArrowRight || keys.KeyE ? 1 : 0)) * 2 * dt;

  const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  let dx = -Math.sin(camA) * f + Math.cos(camA) * r, dz = -Math.cos(camA) * f - Math.sin(camA) * r;
  const len = Math.hypot(dx, dz);
  if (len > 0) { dx /= len; dz /= len; face = Math.atan2(dx, dz); }
  v.x = dx * SPEED; v.z = dz * SPEED;

  coyote = st.onGround ? 0.1 : coyote - dt;
  jumpBuf -= dt;
  if (jumpBuf > 0 && coyote > 0) { v.y = JUMP; coyote = 0; jumpBuf = 0; st.onGround = false; }

  // Физика мелкими шагами, чтобы быстрое падение или бег не проскакивали сквозь платформы
  const n = Math.max(1, Math.ceil(dt / 0.01)), h = dt / n;
  for (let i = 0; i < n; i++) {
    v.y = Math.max(-35, v.y - GRAV * h);
    stepBody(parts, p, v, h, st);
  }

  if (p.y < voidY) respawn();

  // чекпоинты
  (L.cps || []).forEach((c, i) => {
    if (i !== cpIdx && Math.abs(p.x - c[0]) < 2.2 && Math.abs(p.z - c[2]) < 2.2 && Math.abs(p.y - c[1]) < 1.2) {
      if (cpIdx >= 0) setFlag(cpIdx, false);
      cpIdx = i; spawn = [c[0], c[1], c[2]]; setFlag(i, true); toast('Чекпоинт!', 1200);
    }
    if (flags[i]) flags[i].rotation.y += dt * (i === cpIdx ? 2 : 0);
  });

  tmp.set(p.x, p.y + 0.8, p.z);
  for (const c of coins) {
    if (!c.visible) continue;
    c.rotation.y += dt * 4;
    if (c.position.distanceTo(tmp) < 1) {
      c.visible = false; got++;
      if (got >= coins.length) {
        if (L.req) { setGoalOpen(true); toast('Все монеты собраны! Беги к звезде'); }
        else toast('Все монеты собраны!');
      }
    }
  }
  goal.rotation.y += dt * (goalOpen ? 2 : 0.8);
  goal.scale.setScalar(goalOpen ? 1 + 0.08 * Math.sin(clockT * 5) : 1);
  if (!won && goal.position.distanceTo(tmp) < 1.4) {
    if (goalOpen) win();
    else if (clockT > goalToastAt) { toast(`В этом уровне нужны все монеты! Осталось: ${coins.length - got}`); goalToastAt = clockT + 1.5; }
  }
  if (!won) time += dt;

  const best = save.best[levelId], need = L.req && coins.length && got < coins.length;
  const txt = `МОНЕТЫ ${got}/${coins.length}${need ? '  НУЖНЫ ВСЕ' : ''}   ВРЕМЯ ${time.toFixed(1)}\n${best != null ? 'РЕКОРД ' + best.toFixed(1) : ''}${cpIdx >= 0 ? '   ЧЕКПОИНТ' : ''}`;
  if (txt !== lastHud) { hud.textContent = txt; lastHud = txt; }

  skinAnim(clockT);
  player.position.copy(p);
  player.rotation.y = face;
  const gy = supportY(parts, p.x, p.z, p.y + 0.05);
  shadow.visible = gy > -Infinity;
  shadow.position.set(p.x, gy + 0.02, p.z);

  tmp.set(p.x + Math.sin(camA) * 8, p.y + 4.5, p.z + Math.cos(camA) * 8);
  if (snapCam) camera.position.copy(tmp); else camera.position.lerp(tmp, 1 - Math.exp(-6 * dt));
  camera.lookAt(p.x, p.y + 1.2, p.z);
  snapCam = false;
}

// ---------- Редактор уровней ----------
const TOOLS = [['plat', 'Платформа'], ['coin', 'Монета'], ['goal', 'Звезда'], ['start', 'Старт'], ['erase', 'Стереть'], ['cp', 'Чекпоинт'], ['draw', 'Своя форма']];
const ed = {
  tool: 'plat', shape: 0, w: 3, d: 3, rot: 0, tilt: 0, k: 1, h: 0, step: 0.5, snap: true,
  mx: 0, my: 0, mz: 0, below: null,                // куда сейчас целится курсор и что под ним
  tx: 0, ty: 0, tz: 0, yaw: 0.5, pitch: 0.95, dist: 22, // камера: точка, вокруг которой вращаемся
  over: false, dirty: true, draw: [], drawY: 0,
};
const ray = new THREE.Raycaster(), ray2 = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitP = new THREE.Vector3(), rayO = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0);

// Призрак платформы, сетка, пунктир вниз и «тень» на поверхности под курсором: всё это даёт ощущение глубины
const ghostShape = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x7dff9a, transparent: true, opacity: 0.5, depthWrite: false }));
const ghostEdges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff }));
ghostShape.add(ghostEdges);
const ghostBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }));
const footMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false });
const footprint = new THREE.Mesh(new THREE.BufferGeometry(), footMat);
const dot = new THREE.Mesh(new THREE.CircleGeometry(0.45, 12).rotateX(-Math.PI / 2), footMat);
const dropGeo = new THREE.BufferGeometry();
dropGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
const dropLine = new THREE.Line(dropGeo, new THREE.LineBasicMaterial({ color: 0xffee55 }));
dropLine.frustumCulled = false;
const grid1 = new THREE.GridHelper(64, 64, 0xffffff, 0xffffff), grid2 = new THREE.GridHelper(60, 12, 0xffffff, 0xffffff);
for (const g of [grid1, grid2]) { g.material.transparent = true; g.material.depthWrite = false; }
grid1.material.opacity = 0.12; grid2.material.opacity = 0.3;
helpers.add(grid1, grid2, ghostShape, ghostBox, footprint, dot, dropLine);

// Контур своей формы, которую рисуют: линия, замкнутая на курсор (красная, если есть самопересечение), и точки
const drawGeo = new THREE.BufferGeometry();
const drawLine = new THREE.LineLoop(drawGeo, new THREE.LineBasicMaterial({ color: 0xffee55, depthTest: false }));
const drawPts = new THREE.Points(drawGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false, depthTest: false }));
for (const o of [drawLine, drawPts]) { o.frustumCulled = false; o.renderOrder = 10; o.visible = false; helpers.add(o); }
let lastDrawKey = '';
function refreshDraw(cursor) {
  const pts = cursor ? [...ed.draw, cursor] : ed.draw.slice();
  const key = JSON.stringify([pts, ed.drawY]);
  drawLine.visible = drawPts.visible = pts.length > 0;
  if (key === lastDrawKey) return;
  lastDrawKey = key;
  const arr = new Float32Array(pts.length * 3);
  pts.forEach((q, i) => arr.set([q[0], ed.drawY + 0.06, q[1]], i * 3));
  drawGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  drawGeo.setDrawRange(0, pts.length);
  drawLine.material.color.setHex(pts.length >= 3 && !isSimplePolygon(pts) ? 0xff5555 : 0xffee55);
}

function rebuildGhost() {
  const pl = normPlat([0, 0, 0, ed.w, ed.d, ed.shape, 0, ed.tilt, ed.k]);
  const geo = platGeometry(localParts(pl), Math.tan(ed.tilt * DEG));
  ghostShape.geometry.dispose(); ghostShape.geometry = geo;
  ghostEdges.geometry.dispose(); ghostEdges.geometry = new THREE.EdgesGeometry(geo, 25);
  footprint.geometry = geo;
  ed.dirty = false;
}

// История для отмены
const hist = [];
const snap = () => JSON.stringify({ name: L.name, plats: L.plats, coins: L.coins, cps: L.cps, shapes: L.shapes, req: L.req, theme: L.theme, goal: L.goal, start: L.start });
function pushHist() { hist.push(snap()); if (hist.length > 60) hist.shift(); }
function undo() {
  const s = hist.pop();
  if (!s) return say('Нечего отменять');
  Object.assign(L, JSON.parse(s));
  ed.draw = [];
  edited();
  $('ename').value = L.name; syncLevelUI();
}

// Что под курсором: верх существующей платформы (если включено прилипание) или плоскость на высоте ed.h
function computePlacement() {
  const rd = (x) => Math.round(x / ed.step) * ed.step, lim = (x) => Math.max(-290, Math.min(290, x));
  ray.setFromCamera(mouse, camera);
  const planeY = ed.tool === 'draw' && ed.draw.length ? ed.drawY : ed.h;
  let x = 0, z = 0, y = planeY, got = false;
  if (ed.snap && ed.tool !== 'erase' && ed.tool !== 'draw') {
    const hit = ray.intersectObjects(platMeshes, false)[0];
    if (hit && hit.face && hit.face.normal.y > 0.5) {
      x = rd(hit.point.x); z = rd(hit.point.z); y = Math.round(hit.point.y * 100) / 100; got = true;
    }
  }
  if (!got) {
    plane.constant = -planeY;
    if (!ray.ray.intersectPlane(plane, hitP)) return false;
    x = rd(hitP.x); z = rd(hitP.z);
  }
  ed.mx = lim(x); ed.mz = lim(z); ed.my = y;
  rayO.set(ed.mx, ed.my + 0.02, ed.mz);
  ray2.set(rayO, DOWN); ray2.far = 200;
  const b = ray2.intersectObjects(platMeshes, false)[0];
  ed.below = b ? b.point.y : null;
  return true;
}

function setHover(o) {
  if (hoverObj === o) return;
  if (hoverObj) { if (hoverObj.userData.k === 'p') hoverObj.material.emissive.setHex(0); else hoverObj.scale.setScalar(1); }
  hoverObj = o;
  if (o) { if (o.userData.k === 'p') o.material.emissive.setHex(0xaa2222); else o.scale.setScalar(1.5); }
}

const fmt = (x) => String(Math.round(x * 100) / 100);
let lastInfo = '';
const GHOST_BOX = { coin: [0.8, 0.8, 0.8, 1.3], goal: [1.4, 1.4, 1.4, 1.6], start: [0.8, 1.2, 0.8, 0.6], cp: [0.6, 2.4, 0.6, 1.2] };

function updateGuides() {
  const t = ed.tool, plat = t === 'plat';
  const have = ed.over && computePlacement();
  ghostShape.visible = have && plat;
  ghostBox.visible = have && !!GHOST_BOX[t];
  dropLine.visible = footprint.visible = dot.visible = false;
  const gx = have ? ed.mx : ed.tx, gz = have ? ed.mz : ed.tz, gy = have ? ed.my : ed.h;
  grid1.position.set(Math.round(gx), gy + 0.03, Math.round(gz));
  grid2.position.set(Math.round(gx / 5) * 5, gy + 0.03, Math.round(gz / 5) * 5);

  let txt = '';
  if (have) {
    if (t === 'erase') {
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObjects(levelGroup.children, false)[0];
      setHover(hit && (hit.object.userData.k === 'p' || hit.object.userData.k === 'c' || hit.object.userData.k === 'f') ? hit.object : null);
    } else {
      setHover(null);
      let startY = ed.my;
      if (plat) {
        if (ed.dirty) rebuildGhost();
        ghostShape.position.set(ed.mx, ed.my, ed.mz); ghostShape.rotation.y = ed.rot * DEG;
      } else if (GHOST_BOX[t]) {
        const S = GHOST_BOX[t];
        ghostBox.scale.set(S[0], S[1], S[2]); ghostBox.position.set(ed.mx, ed.my + S[3], ed.mz);
        startY = ed.my + S[3];
      }
      const bottom = ed.below != null ? ed.below : startY - 30;
      const a = dropGeo.attributes.position;
      a.setXYZ(0, ed.mx, startY, ed.mz); a.setXYZ(1, ed.mx, bottom, ed.mz); a.needsUpdate = true;
      dropLine.visible = startY - bottom > 0.05;
      if (ed.below != null && ed.my - ed.below > 0.05) {
        const f = plat ? footprint : dot;
        f.visible = true; f.position.set(ed.mx, ed.below + 0.04, ed.mz);
        if (plat) { f.rotation.y = ed.rot * DEG; f.scale.set(1, 0.02, 1); }
      }
    }
    txt = `X ${fmt(ed.mx)}   Z ${fmt(ed.mz)}   ВЫСОТА ${fmt(ed.my)}` + (ed.below != null ? `   (над платформой +${fmt(ed.my - ed.below)})` : '   (под ним пусто)') + '\n';
  } else setHover(null);
  if (t === 'draw') refreshDraw(have ? [ed.mx, ed.mz] : null); else drawLine.visible = drawPts.visible = false;
  txt += `Плоскость высоты: ${fmt(ed.h)}${ed.snap ? ' (прилипание к платформам)' : ''}   Платформ: ${L.plats.length}/80   Монет: ${L.coins.length}/100   Чекпоинтов: ${L.cps.length}/20${L.req ? '   [монеты обязательны]' : ''}`;
  if (txt !== lastInfo) { $('edinfo').textContent = txt; lastInfo = txt; }
}

function updateEdit(dt) {
  ed.yaw += ((keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0)) * 1.8 * dt;
  const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), sp = ed.dist * 0.8 * dt;
  ed.tx += (-Math.sin(ed.yaw) * f + Math.cos(ed.yaw) * r) * sp;
  ed.tz += (-Math.cos(ed.yaw) * f - Math.sin(ed.yaw) * r) * sp;
  ed.ty += (ed.h - ed.ty) * (1 - Math.exp(-8 * dt)); // камера смотрит на плоскость, на которой строим
  const cp = Math.cos(ed.pitch);
  camera.position.set(ed.tx + Math.sin(ed.yaw) * cp * ed.dist, ed.ty + Math.sin(ed.pitch) * ed.dist, ed.tz + Math.cos(ed.yaw) * cp * ed.dist);
  camera.lookAt(ed.tx, ed.ty, ed.tz);
  camera.updateMatrixWorld();
  updateGuides();
  coins.forEach((c) => (c.rotation.y += dt * 4));
  goal.rotation.y += dt * 2;
}

function fitView() {
  const B = partsBounds(parts);
  let x0 = B.minX, x1 = B.maxX, z0 = B.minZ, z1 = B.maxZ;
  for (const [x, , z] of [...L.coins, ...L.cps, L.goal, L.start]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  ed.tx = (x0 + x1) / 2; ed.tz = (z0 + z1) / 2;
  ed.dist = Math.min(180, Math.max(10, Math.hypot(x1 - x0, z1 - z0) * 0.9 + 6));
  ed.pitch = 0.9;
}

function edited() { L.seed = null; L.id = null; L.style = null; buildLevel(L); if (mode === 'edit') setGoalOpen(true); $('lvname').textContent = L.name; }
function erase() {
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(levelGroup.children, false)[0];
  const u = hit && hit.object.userData;
  if (!u) return;
  if (u.k === 'p' && L.plats.length > 1) { pushHist(); L.plats.splice(u.i, 1); }
  else if (u.k === 'c') { pushHist(); L.coins.splice(u.i, 1); }
  else if (u.k === 'f') { pushHist(); L.cps.splice(u.i, 1); }
  else return;
  edited();
}
function place() {
  if (!computePlacement()) return;
  const { tool: t, mx: x, my: y, mz: z } = ed;
  if (t === 'erase') return erase();
  if (t === 'draw') return addDrawPoint();
  if (t === 'cp' && L.cps.length >= 20) return say('Максимум 20 чекпоинтов');
  if (t === 'plat' && L.plats.length >= 80) return say('Максимум 80 платформ');
  if (t === 'coin' && L.coins.length >= 100) return say('Максимум 100 монет');
  pushHist();
  if (t === 'plat') L.plats.push([x, y, z, ed.w, ed.d, ed.shape, ed.rot, ed.tilt, ed.k]);
  else if (t === 'coin') L.coins.push([x, y + 1.3, z]);
  else if (t === 'goal') L.goal = [x, y + 1.6, z];
  else if (t === 'start') L.start = [x, y, z];
  else if (t === 'cp') L.cps.push([x, y, z]);
  edited();
}

// Мышь в редакторе: клик — поставить / стереть, ЛКМ-перетаскивание — вращать камеру, ПКМ или СКМ — двигать
const cv = renderer.domElement;
const drag = { on: false, btn: 0, x: 0, y: 0, sx: 0, sy: 0, moved: false, shift: false };
const setMouse = (e) => mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
cv.addEventListener('pointerdown', (e) => {
  if (mode !== 'edit') return;
  cv.setPointerCapture(e.pointerId);
  Object.assign(drag, { on: true, btn: e.button, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, shift: e.shiftKey });
  setMouse(e); ed.over = true;
});
cv.addEventListener('pointermove', (e) => {
  if (mode !== 'edit') return;
  setMouse(e); ed.over = true;
  if (!drag.on) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) drag.moved = true;
  if (!drag.moved) return;
  if (drag.btn === 0 && !drag.shift) {
    ed.yaw -= dx * 0.006;
    ed.pitch = Math.max(0.08, Math.min(1.5, ed.pitch + dy * 0.005));
  } else {
    const k = ed.dist * 0.0012, sx = Math.cos(ed.yaw), sz = -Math.sin(ed.yaw), fx = -Math.sin(ed.yaw), fz = -Math.cos(ed.yaw);
    const fk = k / Math.max(0.35, Math.sin(ed.pitch));
    ed.tx += -sx * dx * k + fx * dy * fk; ed.tz += -sz * dx * k + fz * dy * fk;
  }
});
cv.addEventListener('pointerup', (e) => {
  if (!drag.on) return;
  drag.on = false;
  if (mode !== 'edit' || drag.moved) return;
  setMouse(e);
  if (drag.btn === 0) place();
  else if (drag.btn === 2) { if (ed.tool === 'draw' && ed.draw.length) undoDrawPoint(); else erase(); }
});
cv.addEventListener('pointerleave', () => { if (!drag.on) ed.over = false; });
cv.addEventListener('wheel', (e) => {
  if (mode !== 'edit') return;
  e.preventDefault();
  const dlt = e.deltaY || e.deltaX;
  if (e.shiftKey) { ed.h += dlt < 0 ? 0.5 : -0.5; syncUI(); }
  else ed.dist = Math.max(4, Math.min(180, ed.dist * (1 + Math.sign(dlt) * 0.1)));
}, { passive: false });

// ---------- Меню, Мастерская, ссылки ----------
let sayT;
function say(t) { $('status').textContent = t; clearTimeout(sayT); sayT = setTimeout(() => ($('status').textContent = ''), 4000); }

function syncUI() {
  $('edw').value = ed.w; $('edd').value = ed.d; $('edrot').value = ed.rot;
  $('edtilt').value = ed.tilt; $('edk').value = ed.k; $('edh').value = ed.h;
}
function syncLevelUI() { $('edreq').checked = !!L.req; $('edtheme').value = L.theme | 0; }

function updateDrawUI() {
  const n = ed.draw.length;
  $('drawinfo').textContent = n
    ? `Точек: ${n}. ${n < 3 ? 'Нужно минимум 3.' : 'Замкните: клик по первой точке или Enter.'}`
    : 'Кликайте точки контура на плоскости построения. Форма может быть любой, но без самопересечений.';
  $('btnDrawDone').disabled = n < 3;
  $('btnDrawUndo').disabled = n < 1;
}
function setTool(t) {
  ed.tool = t;
  if (t !== 'draw') ed.draw = [];
  $('drawbox').style.display = t === 'draw' ? 'block' : 'none';
  updateDrawUI();
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
}

// ----- Рисование своей формы -----
function addDrawPoint() {
  const pt = [ed.mx, ed.mz], n = ed.draw.length;
  if (n === 0) ed.drawY = ed.h;
  if (n >= 3 && Math.hypot(pt[0] - ed.draw[0][0], pt[1] - ed.draw[0][1]) < Math.max(0.35, ed.step * 0.75)) return finishDraw();
  if (n >= 40) return say('Максимум 40 точек. Замкните форму (Enter)');
  if (!chainOk(ed.draw, pt)) return say('Линии не должны пересекаться');
  ed.draw.push(pt); updateDrawUI();
}
function undoDrawPoint() { ed.draw.pop(); updateDrawUI(); }
function cancelDraw() { ed.draw = []; updateDrawUI(); }
const r3 = (x) => Math.round(x * 1000) / 1000;
function finishDraw() {
  const pts = ed.draw;
  if (pts.length < 3) return say('Нужно минимум 3 точки');
  if (!isSimplePolygon(pts)) return say('Контур пересекает сам себя');
  if (L.shapes.length >= 24) return say('Максимум 24 своих формы');
  if (L.plats.length >= 80) return say('Максимум 80 платформ');
  const nz = normalizeShape(pts);
  if (nz.w < 1 || nz.d < 1 || nz.w > 30 || nz.d > 30) return say('Размер формы должен быть от 1 до 30');
  pushHist();
  L.shapes.push(nz.poly);
  const idx = SHAPES.length + L.shapes.length - 1;
  L.plats.push([r3(nz.cx), r3(ed.drawY), r3(nz.cz), r3(nz.w), r3(nz.d), idx, 0, ed.tilt, ed.k]);
  ed.draw = []; ed.shape = idx; ed.w = r3(nz.w); ed.d = r3(nz.d); ed.rot = 0; ed.dirty = true;
  edited();
  setTool('plat'); syncUI();
  say('Форма добавлена и стоит на месте. Её можно ставить ещё, она появилась в списке форм.');
}
function delShape() {
  const i = ed.shape - SHAPES.length;
  if (i < 0) return say('Встроенные формы удалить нельзя');
  if (L.plats.some((a) => (a[5] ?? 0) === ed.shape)) return say('Форма используется платформами: сначала сотрите их');
  pushHist();
  L.shapes.splice(i, 1);
  L.plats.forEach((a) => { if (a[5] > ed.shape) a[5]--; });
  ed.shape = 0; ed.dirty = true;
  edited();
}

function markShape() {
  document.querySelectorAll('#shapes button').forEach((b) => b.classList.toggle('on', +b.dataset.shape === ed.shape));
  $('shapename').textContent = shapeDef(ed.shape).name;
  $('btnDelShape').disabled = ed.shape < SHAPES.length;
}
function refreshShapeButtons() {
  const holder = $('shapes'), n = shapeCount();
  holder.textContent = '';
  for (let i = 0; i < n; i++) {
    const b = document.createElement('button'), def = shapeDef(i);
    b.dataset.shape = i; b.textContent = def.icon; b.title = def.name; b.onclick = () => setShape(i);
    holder.append(b);
  }
  if (ed.shape >= n) { ed.shape = 0; ed.dirty = true; }
  markShape();
}
function setShape(i) {
  ed.shape = i; ed.dirty = true; setTool('plat'); markShape();
}
TOOLS.forEach(([id, name], i) => {
  const b = document.createElement('button');
  b.dataset.tool = id; b.textContent = `${i + 1} ${name}`; b.onclick = () => setTool(id);
  $('tools').append(b);
});

function setTab(t) {
  document.querySelectorAll('.pane').forEach((el) => (el.style.display = el.id === 'pane-' + t ? 'block' : 'none'));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  const e = t === 'edit';
  helpers.visible = marker.visible = e;
  outlines.forEach((o) => (o.visible = e));
  if (!e) { setHover(null); ed.over = false; cancelDraw(); }
  dragonRoot.visible = !e;
  hud.style.display = e ? 'none' : '';
  $('edinfo').style.display = e ? 'block' : 'none';
  $('help').textContent = e ? HELP_EDIT : HELP_PLAY;
  cv.style.cursor = e ? 'crosshair' : '';
  if (e !== (mode === 'edit')) {
    mode = e ? 'edit' : 'play';
    scene.fog.near = e ? 80 : 24; scene.fog.far = e ? 420 : 150;
    setFar(e ? 600 : 250);
    if (e) {
      player.visible = shadow.visible = false;
      setGoalOpen(true);
      msg.style.display = 'none';
      $('ename').value = L.name; syncLevelUI();
      ed.tx = L.start[0]; ed.tz = L.start[2]; ed.h = L.start[1]; ed.ty = ed.h;
      hist.length = 0; syncUI(); fitView();
    } else { player.visible = true; testRun = true; reset(); }
  }
  if (t === 'work') loadWork();
}
function play(lv) {
  lv.shapes = lv.shapes || []; lv.cps = lv.cps || []; lv.theme = lv.theme | 0; lv.req = !!lv.req;
  L = lv; buildLevel(L); hist.length = 0;
  $('lvname').textContent = L.name; $('seed').value = L.seed ?? '';
  if (L.seed) { $('seedStyle').value = L.style || 'mix'; $('seedDiff').value = L.diff || 2; }
  syncLevelUI();
  const wasEdit = mode === 'edit';
  setTab('play');
  testRun = false;
  if (!wasEdit) reset();
}

async function copyLink() {
  const base = location.href.split('#')[0];
  const link = L.seed ? `${base}#S=${encodeURIComponent(L.seed)}&T=${L.style || 'mix'}&D=${L.diff || 2}` : `${base}#L=${enc(L)}`;
  try { await navigator.clipboard.writeText(link); say('Ссылка скопирована'); } catch { prompt('Скопируйте ссылку:', link); }
}
const ghRepo = () => ({
  owner: location.hostname.endsWith('github.io') ? location.hostname.split('.')[0] : 'OWNER',
  repo: location.pathname.split('/')[1] || 'REPO',
});

// Мастерская: уровни лежат в Issues репозитория. Владелец ставит метку "workshop" = одобрено.
async function loadWork() {
  const list = $('worklist'), { owner, repo } = ghRepo();
  list.textContent = 'Загрузка…';
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?labels=workshop&state=open&per_page=50`);
    if (!res.ok) throw new Error(res.status);
    const items = [];
    for (const it of await res.json()) {
      if (it.pull_request) continue;
      const m = /```level\s+([\w-]+)\s+```/.exec(it.body || '');
      const lv = m && dec(m[1]);
      if (lv) items.push({ lv, author: it.user.login, likes: (it.reactions && it.reactions['+1']) || 0, url: it.html_url });
    }
    items.sort((a, b) => b.likes - a.likes);
    list.textContent = items.length ? '' : 'Пока пусто. Станьте первым!';
    for (const it of items) {
      const row = document.createElement('div'); row.className = 'item';
      const b = document.createElement('button');
      b.textContent = `${it.lv.name} · ${it.author} · 👍${it.likes}`;
      b.onclick = () => play(it.lv);
      const a = document.createElement('a'); a.href = it.url; a.target = '_blank'; a.textContent = '↗';
      row.append(b, a); list.append(row);
    }
  } catch { list.textContent = 'Не удалось загрузить Мастерскую (она работает на GitHub Pages).'; }
}

document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$('panel').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') e.target.blur(); });
document.querySelectorAll('.link').forEach((b) => (b.onclick = copyLink));
const genLevel = (seed) => generate(seed, $('seedStyle').value, +$('seedDiff').value, THEMES.length);
$('btnSeed').onclick = () => play(genLevel($('seed').value.trim() || 'default'));
$('btnRand').onclick = () => { const s = Math.random().toString(36).slice(2, 8); $('seed').value = s; play(genLevel(s)); };
$('btnClassic').onclick = () => play(classic());
$('btnCode').onclick = () => { const lv = dec($('code').value.trim()); lv ? play(lv) : say('Код не подходит'); };
$('btnTest').onclick = () => setTab('play');
$('btnNew').onclick = () => {
  pushHist();
  L = { name: 'Мой уровень', plats: [[0, 0, 0, 6, 6]], coins: [], cps: [], shapes: [], req: false, theme: 0, goal: [0, 1.6, -8], start: [0, 0, 0] };
  buildLevel(L); setGoalOpen(true); $('ename').value = L.name; $('lvname').textContent = L.name; syncLevelUI();
  hist.length = 0; ed.tx = 0; ed.tz = 0; ed.h = 0; syncUI(); fitView();
};
$('btnWork').onclick = loadWork;
$('btnUndo').onclick = undo;
$('camTop').onclick = () => { ed.pitch = 1.5; };
$('camSide').onclick = () => { ed.pitch = 0.12; };
$('camFit').onclick = fitView;
$('btnDrawDone').onclick = finishDraw;
$('btnDrawUndo').onclick = undoDrawPoint;
$('btnDrawCancel').onclick = cancelDraw;
$('btnDelShape').onclick = delShape;
$('btnReset').onclick = () => {
  if (!confirm('Сбросить все рекорды?')) return;
  save.best = {}; persist();
};
$('btnSubmit').onclick = () => {
  const { owner, repo } = ghRepo();
  const body = `Название: ${L.name}\n\n\`\`\`level\n${enc(L)}\n\`\`\`\n`;
  window.open(`https://github.com/${owner}/${repo}/issues/new?title=${encodeURIComponent('[Уровень] ' + L.name)}&body=${encodeURIComponent(body)}`, '_blank');
  say('Нажмите Submit new issue на странице GitHub');
};
const num = (id, lo, hi, fn) => {
  $(id).oninput = (e) => { const x = parseFloat(e.target.value); if (Number.isFinite(x)) { fn(Math.max(lo, Math.min(hi, x))); ed.dirty = true; } };
};
num('edw', 1, 30, (x) => (ed.w = x));
num('edd', 1, 30, (x) => (ed.d = x));
num('edrot', -720, 720, (x) => (ed.rot = x));
num('edtilt', -60, 60, (x) => (ed.tilt = x));
num('edk', 0.25, 20, (x) => (ed.k = x));
num('edh', -300, 300, (x) => (ed.h = x));
$('edstep').onchange = (e) => { ed.step = +e.target.value; e.target.blur(); };
$('edsnap').onchange = (e) => { ed.snap = e.target.checked; e.target.blur(); };
$('edreq').onchange = (e) => { L.req = e.target.checked; L.seed = null; L.id = null; L.style = null; e.target.blur(); };
$('edtheme').onchange = (e) => { L.theme = +e.target.value; edited(); e.target.blur(); };
$('ename').oninput = (e) => { L.name = e.target.value.slice(0, 40); $('lvname').textContent = L.name; };

// списки стилей, сложностей и тем берём из кода, чтобы не дублировать их в HTML
for (const [k, n] of Object.entries(STYLES)) $('seedStyle').add(new Option(n, k));
for (const [k, n] of Object.entries(DIFFS)) $('seedDiff').add(new Option(n, k));
THEMES.forEach((t, i) => $('edtheme').add(new Option(t.name, i)));
$('seedDiff').value = 2;
SKINS.forEach((sk, i) => $('skinSel').add(new Option(sk.name, i)));
$('skinSel').add(new Option('Свои цвета', 'custom'));
{
  const ids = { legs: 'skLegs', shirt: 'skShirt', head: 'skHead', cap: 'skCap', belt: 'skBelt' };
  const readColors = () => Object.fromEntries(SKIN_KEYS.map((k) => [k, parseInt($(ids[k]).value.slice(1), 16)]));
  for (const k of SKIN_KEYS) $(ids[k]).oninput = () => customSkin(readColors());
  $('skinSel').onchange = (e) => {
    const v = e.target.value;
    if (v === 'custom') customSkin(save.skin && save.skin.colors ? save.skin.colors : Object.fromEntries(SKIN_KEYS.map((k) => [k, skin[k]])));
    else chooseSkin(+v);
    e.target.blur();
  };
  $('btnSkinRand').onclick = () => {
    const c = new THREE.Color(), h = Math.random(), col = (dh, sat, lig) => { c.setHSL((h + dh) % 1, sat, lig); return c.getHex(); };
    customSkin({ legs: col(0.5, 0.6, 0.35), shirt: col(0, 0.75, 0.5), head: col(0.08 + Math.random() * 0.02, 0.6, 0.78), cap: col(0.33, 0.7, 0.45), belt: col(0.16, 0.5, 0.3) });
  };
  const sv = save.skin;
  if (sv && sv.id === 'custom' && sv.colors) chooseSkin('custom');
  else chooseSkin(sv && Number.isInteger(sv.id) && SKINS[sv.id] ? sv.id : 0);
}

function loadHash() {
  const h = location.hash.slice(1);
  if (h.startsWith('S=')) {
    const q = new URLSearchParams(h);
    play(generate(q.get('S'), q.get('T') || 'mix', +q.get('D') || 2, THEMES.length));
  } else if (h.startsWith('L=')) { const lv = dec(h.slice(2)); if (lv) play(lv); else say('Ссылка на уровень повреждена'); }
}
addEventListener('hashchange', loadHash);

// ---------- Старт ----------
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  clockT += dt;
  if (mode === 'play') update(dt); else updateEdit(dt);
  updateDragons(dt, clockT);
  clouds.update(dt, clockT, camera.position);
  composer.render();
}
setTool('plat'); syncUI();
play(classic());
loadHash();
loop();

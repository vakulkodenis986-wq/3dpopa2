import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SHAPES, DEG, normPlat, localParts, worldParts, partsBounds, supportY, stepBody, closest } from './shapes.js';
import { paintSky } from './sky.js';
import { createClouds } from './clouds.js';

const $ = (id) => document.getElementById(id);
let TINT = true;

// ── Настройки ──────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'n64parkour.cfg.v1';
const defSettings = () => ({ ssao: true, fog: true, dragons: true, clouds: true, tint: true });
let settings = defSettings();
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch {}
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };
TINT = settings.tint;

// ── Персонаж ───────────────────────────────────────────────────────────────
const DEF_CHAR = { name: 'ИГРОК', shirt: 0xd32f2f, pants: 0x1565c0, skin: 0xffcc99, shoes: 0x4e342e, hat: 0 };
const n2h = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
const h2n = (s) => parseInt(String(s).replace('#', ''), 16);

// ── Рендер N64 ─────────────────────────────────────────────────────────────
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
const mainFog = new THREE.Fog(0xb0d8ff, 24, 150);
scene.fog = settings.fog ? mainFog : null;
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 250);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(5, 10, 6);
scene.add(sun);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const ssao = new SSAOPass(scene, camera, 320, RES_H);
ssao.kernelRadius = 2.5;
ssao.enabled = settings.ssao;
composer.addPass(ssao);
composer.addPass(new OutputPass());

function setFar(f) {
  camera.far = f; camera.updateProjectionMatrix();
  ssao.minDistance = 0.125 / f; ssao.maxDistance = 3 / f;
}
setFar(250);

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
clouds.setVisible(settings.clouds);

// ── Текстуры ───────────────────────────────────────────────────────────────
const baseTex = drawTex(8, (g) => {
  g.fillStyle = '#fff'; g.fillRect(0, 0, 8, 8);
  g.fillStyle = '#c4c4c4'; g.fillRect(0, 0, 4, 4); g.fillRect(4, 4, 4, 4);
}, true);

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; };
}
function rngFrom(seed) { const n = xmur3(String(seed)); return () => n() / 4294967296; }
const hr = rngFrom('hands');
const dots = (g, s, col, n) => { g.fillStyle = col; for (let i = 0; i < n; i++) g.fillRect((hr() * s) | 0, (hr() * s) | 0, 1, 1); };
const sleeveTex = drawTex(16, (g, s) => {
  g.fillStyle = '#d32f2f'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#a62020'; for (let y = 0; y < s; y += 4) g.fillRect(0, y, s, 1);
  dots(g, s, '#ef6a6a', 20);
});
const skinTex = drawTex(16, (g, s) => {
  g.fillStyle = '#ffcc99'; g.fillRect(0, 0, s, s);
  dots(g, s, '#e3a173', 26); dots(g, s, '#ffe3c4', 12);
});
const gloveTex = drawTex(16, (g, s) => {
  const gr = g.createLinearGradient(0, 0, 0, s);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#bdbdbd');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  g.fillStyle = '#9a9a9a'; [4, 8, 12].forEach((x) => g.fillRect(x, 0, 1, 10));
  dots(g, s, '#d8d8d8', 14);
});

// ── Сохранение ─────────────────────────────────────────────────────────────
const SAVE_KEY = 'n64parkour.v1';
const blankSave = () => ({ coins: 0, jump: 0, speed: 0, best: {}, char: { ...DEF_CHAR } });
let save = blankSave();
try {
  const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
  save.coins = Math.max(0, s.coins | 0);
  save.jump = Math.min(10, Math.max(0, s.jump | 0));
  save.speed = Math.min(10, Math.max(0, s.speed | 0));
  if (s.best && typeof s.best === 'object') save.best = s.best;
  if (s.char && typeof s.char === 'object') {
    save.char = {
      name:  String(s.char.name  || DEF_CHAR.name).slice(0, 16),
      shirt: typeof s.char.shirt === 'number' ? s.char.shirt : DEF_CHAR.shirt,
      pants: typeof s.char.pants === 'number' ? s.char.pants : DEF_CHAR.pants,
      skin:  typeof s.char.skin  === 'number' ? s.char.skin  : DEF_CHAR.skin,
      shoes: typeof s.char.shoes === 'number' ? s.char.shoes : DEF_CHAR.shoes,
      hat:   [0, 1, 2].includes(s.char.hat)  ? s.char.hat   : DEF_CHAR.hat,
    };
  }
} catch { /* без сохранений */ }
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch {} }

// ── Уровни ─────────────────────────────────────────────────────────────────
const r05 = (x) => Math.round(x * 2) / 2;

function classic() {
  const plats = [[0,0,0,8,8],[0,0.5,-8,4,4],[3,1.2,-13,3,3],[-1,2,-18,3,3],
    [-5,2.5,-23,3,3],[-5,3.5,-28,2.5,2.5],[0,4.2,-30,3,3],[5,5,-32,3,3],
    [10,6,-36,2.5,2.5],[10,6.5,-42,1.5,6],[10,7.5,-50,6,6]];
  return { id:'classic', name:'Классика', plats, coins:plats.slice(1,10).map(([x,y,z])=>[x,y+1.3,z]), goal:[10,9.1,-50], start:[0,0,0] };
}

function platGap(A, B) {
  const a = worldParts(normPlat(A)), b = worldParts(normPlat(B)), o = { x:0, z:0, ei:0 };
  let best = Infinity;
  for (const [P,Q] of [[a,b],[b,a]]) for (const p of P) for (const q of Q)
    for (let i = 0; i < p.n; i++) best = Math.min(best, Math.max(0, closest(q, p.px[i], p.pz[i], o)));
  return best;
}

function generate(seed) {
  const R = rngFrom(seed), rr = (a, b) => a + R() * (b - a);
  const plats = [[0, 0, 0, 6, 6]];
  const n = 10 + Math.floor(R() * 9);
  let ang = rr(-0.4, 0.4);
  for (let i = 1; i < n; i++) {
    const prev = plats[plats.length - 1], last = i === n - 1;
    const w = last ? 5 : r05(rr(2.2, 4.4)), d = last ? 5 : r05(rr(2.2, 4.4));
    const y = Math.max(0, r05(prev[1] + (i < 2 ? rr(0, 0.6) : rr(-0.8, 1))));
    let placed = null;
    for (let t = 0; t < 14 && !placed; t++) {
      const a = Math.max(-1.7, Math.min(1.7, ang + rr(-0.9, 0.9) * (1 + t * 0.15)));
      const ux = Math.sin(a), uz = -Math.cos(a);
      const ext = (bw, bd) => (Math.abs(ux) * bw + Math.abs(uz) * bd) / 2;
      const dist = ext(prev[3], prev[4]) + ext(w, d) + rr(1.4, 2.9);
      const x = r05(prev[0] + ux * dist), z = r05(prev[2] + uz * dist);
      if (plats.every((q) => Math.abs(q[0]-x)>(q[3]+w)/2+0.8 || Math.abs(q[2]-z)>(q[4]+d)/2+0.8)) {
        placed = [x, y, z, w, d]; ang = a;
      }
    }
    if (!placed) break;
    plats.push(placed);
  }
  const SR = rngFrom(seed + '#shapes'), pool = [1, 2, 1, 2, 0];
  plats.forEach((pl, i) => {
    if (i === 0 || i === plats.length - 1 || SR() >= 0.5) return;
    const shaped = pl.slice(0, 5); shaped[5] = pool[Math.floor(SR() * pool.length)];
    if (!shaped[5]) return;
    if ([plats[i-1], plats[i+1]].every((nb) => platGap(shaped, nb) <= platGap(pl, nb) + 0.3)) pl[5] = shaped[5];
  });
  const mid = plats.slice(1, -1);
  const coins = mid.filter(() => R() < 0.7).map(([x,y,z]) => [x, y+1.3, z]);
  if (coins.length < 3) mid.slice(0,3).forEach(([x,y,z]) => coins.push([x,y+1.3,z]));
  const [gx,gy,gz] = plats[plats.length-1];
  return { name:'Сид: '+seed, seed:String(seed), plats, coins, goal:[gx,gy+1.6,gz], start:[0,0,0] };
}

const fullP = (a) => [a[0],a[1],a[2],a[3],a[4],a[5]??0,a[6]??0,a[7]??0,a[8]??1];
const trimP = (a) => {
  const b = fullP(a), dflt = [0,0,0,0,0,0,0,0,1];
  while (b.length > 5 && b[b.length-1] === dflt[b.length-1]) b.pop();
  return b;
};

function sanitize(j) {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const ok  = (a, n, lo, hi) => Array.isArray(a) && a.length === n && a.every((v) => num(v) && v >= lo && v <= hi);
  const okP = (a) => Array.isArray(a) && a.length >= 5 && a.length <= 9 && a.every(num)
    && a.slice(0,3).every((v) => Math.abs(v) <= 300)
    && a[3]>=1&&a[3]<=30&&a[4]>=1&&a[4]<=30
    && (a[5]===undefined||(Number.isInteger(a[5])&&a[5]>=0&&a[5]<SHAPES.length))
    && (a[6]===undefined||Math.abs(a[6])<=720)
    && (a[7]===undefined||Math.abs(a[7])<=60)
    && (a[8]===undefined||(a[8]>=0.25&&a[8]<=20));
  if (!j||!Array.isArray(j.p)||!j.p.length||j.p.length>80) return null;
  if (!j.p.every(okP)) return null;
  const c = Array.isArray(j.c) ? j.c.slice(0,100) : [];
  if (!c.every((a)=>ok(a,3,-300,300))||!ok(j.g,3,-300,300)||!ok(j.s,3,-300,300)) return null;
  return { name:String(j.n||'Без названия').slice(0,40), plats:j.p.map(fullP), coins:c, goal:j.g, start:j.s };
}
const enc = (lv) => btoa(unescape(encodeURIComponent(JSON.stringify({n:lv.name,p:lv.plats.map(trimP),c:lv.coins,g:lv.goal,s:lv.start}))))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function dec(code) {
  try { return sanitize(JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g,'+').replace(/_/g,'/')))))); }
  catch { return null; }
}
function lvId(lv) {
  if (lv.id) return lv.id;
  if (lv.seed) return 'S:'+lv.seed;
  const s = JSON.stringify([lv.plats.map(trimP),lv.coins,lv.goal,lv.start]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'H:'+(h>>>0).toString(36);
}

// ── Построение уровня ──────────────────────────────────────────────────────
const COLORS = [0x4caf50, 0xff9800, 0x42a5f5, 0xe91e63, 0xffeb3b];
const coinGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 8).rotateX(Math.PI / 2);
const coinMat = mat(0xffd800, { emissive: 0x665500 });
const goalGeo = new THREE.IcosahedronGeometry(0.7, 0);
const goalMat = mat(0xfff176, { emissive: 0x887700 });
const goalLockedMat = new THREE.MeshBasicMaterial({ color: 0x8a94b0, wireframe: true });
const outlineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 });
const orbit = { cx: 0, cz: 0, rx: 15, rz: 15, top: 0 };
let L, levelGroup = new THREE.Group(), parts = [], platMeshes = [], coins = [], goal, goalOpen = true, voidY = -15;
scene.add(levelGroup);

function platGeometry(lparts, g) {
  const pos = [], nor = [], col = [], uv = [];
  const tri = (A, B, C, want) => {
    const e1x=B[0]-A[0],e1y=B[1]-A[1],e1z=B[2]-A[2];
    const e2x=C[0]-A[0],e2y=C[1]-A[1],e2z=C[2]-A[2];
    let nx=e1y*e2z-e1z*e2y,ny=e1z*e2x-e1x*e2z,nz=e1x*e2y-e1y*e2x;
    const len=Math.hypot(nx,ny,nz); if(len<1e-9)return;
    nx/=len;ny/=len;nz/=len;
    if(nx*want[0]+ny*want[1]+nz*want[2]<0){[B,C]=[C,B];nx=-nx;ny=-ny;nz=-nz;}
    for(const V of [A,B,C]){pos.push(V[0],V[1],V[2]);nor.push(nx,ny,nz);col.push(V[3],V[3],V[3]);uv.push(V[4],V[5]);}
  };
  for (const q of lparts) {
    const P=q.poly,n=P.length;
    let cx=0,cz=0;
    for(const [x,z] of P){cx+=x;cz+=z;} cx/=n;cz/=n;
    const yt=(z)=>q.dy-g*z, yb=(z)=>yt(z)-q.T;
    for(let i=0;i<n;i++){
      const a=P[i],b=P[(i+1)%n];
      tri([cx,yt(cz),cz,1,cx*.5,cz*.5],[a[0],yt(a[1]),a[1],.7,a[0]*.5,a[1]*.5],[b[0],yt(b[1]),b[1],.7,b[0]*.5,b[1]*.5],[0,1,0]);
      tri([cx,yb(cz),cz,.3,cx*.5,cz*.5],[a[0],yb(a[1]),a[1],.3,a[0]*.5,a[1]*.5],[b[0],yb(b[1]),b[1],.3,b[0]*.5,b[1]*.5],[0,-1,0]);
    }
    for(let i=0;i<n;i++){
      const a=P[i],b=P[(i+1)%n];
      const ex=b[0]-a[0],ez=b[1]-a[1],el=Math.hypot(ex,ez)||1;
      const want=[(a[0]+b[0])/2-cx,0,(a[1]+b[1])/2-cz];
      const V=(pt,t)=>{const y=yb(pt[1])+(yt(pt[1])-yb(pt[1]))*t;return[pt[0],y,pt[1],.35+.35*t,((pt[0]*ex+pt[1]*ez)/el)*.5,y*.5];};
      for(const[t0,t1]of[[0,.5],[.5,1]]){tri(V(a,t0),V(b,t0),V(b,t1),want);tri(V(a,t0),V(b,t1),V(a,t1),want);}
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geo.computeBoundingSphere();
  return geo;
}

function setGoalOpen(open) {
  goalOpen = open;
  if (goal) goal.material = open ? goalMat : goalLockedMat;
}

let hoverObj = null;
function buildLevel(lv) {
  scene.remove(levelGroup);
  levelGroup.traverse((o)=>{if(o.userData.own)o.geometry.dispose();if(o.userData.ownMat)o.material.dispose();});
  levelGroup = new THREE.Group(); scene.add(levelGroup);
  parts = []; platMeshes = []; coins = []; outlines = []; hoverObj = null;
  lv.plats.forEach((a, i) => {
    const pl = normPlat(a);
    const geo = platGeometry(localParts(pl), Math.tan(pl.t * DEG));
    const m = new THREE.Mesh(geo, mat(TINT ? COLORS[i % COLORS.length] : 0xffffff, { map: baseTex, vertexColors: true }));
    m.position.set(pl.x, pl.y, pl.z); m.rotation.y = pl.r * DEG;
    m.userData = { k:'p', i, own:true, ownMat:true };
    const ol = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), outlineMat);
    ol.userData = { k:'o', own:true }; ol.visible = mode === 'edit';
    m.add(ol); outlines.push(ol);
    levelGroup.add(m); platMeshes.push(m);
    parts.push(...worldParts(pl));
  });
  lv.coins.forEach(([x,y,z], i) => {
    const c = new THREE.Mesh(coinGeo, coinMat);
    c.position.set(x,y,z); c.userData = { k:'c', i };
    levelGroup.add(c); coins.push(c);
  });
  goal = new THREE.Mesh(goalGeo, goalMat);
  goal.position.set(...lv.goal); goal.userData = { k:'g' };
  levelGroup.add(goal);
  setGoalOpen(true);
  marker.position.set(lv.start[0], lv.start[1]+0.6, lv.start[2]);
  const B = partsBounds(parts);
  orbit.cx=(B.minX+B.maxX)/2; orbit.cz=(B.minZ+B.maxZ)/2;
  orbit.rx=Math.max(15,(B.maxX-B.minX)/2); orbit.rz=Math.max(15,(B.maxZ-B.minZ)/2);
  orbit.top=B.hi;
  voidY = B.lo - 12;
  clouds.setBands({ cx:orbit.cx, cz:orbit.cz, r:Math.max(orbit.rx,orbit.rz)+100, low:B.lo, high:B.hi });
}

// ── Игрок ──────────────────────────────────────────────────────────────────
const player = new THREE.Group();
scene.add(player);

const shadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.5, 8).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 })
);
scene.add(shadow);

// Руки
const hands = new THREE.Group();
camera.add(hands);
const sleeveM = mat(0xffffff, { map: sleeveTex });
const skinM   = mat(0xffffff, { map: skinTex });
const gloveM  = mat(0xffffff, { map: gloveTex });
function makeArm(side) {
  const g = new THREE.Group();
  box(g, 0.16, 0.16, 0.42, sleeveM, 0, 0, -0.21);
  box(g, 0.12, 0.12, 0.2,  skinM,   0, 0, -0.5);
  box(g, 0.2,  0.2,  0.2,  gloveM,  0, 0, -0.68);
  g.position.set(side * 0.36, -0.5, -0.15);
  g.rotation.y = -side * 0.1;
  hands.add(g);
  return g;
}
const armL = makeArm(-1), armR = makeArm(1);

// Строим тело персонажа из save.char
function buildPlayerFromChar() {
  while (player.children.length) {
    const c = player.children[0];
    if (c.geometry) c.geometry.dispose();
    if (c.material && !c.material.map) c.material.dispose();
    player.remove(c);
  }
  const c = save.char;
  box(player, 0.6,  0.4,  0.35, mat(c.pants), 0,     0.2,  0);
  box(player, 0.7,  0.6,  0.4,  mat(c.shirt), 0,     0.7,  0);
  box(player, 0.45, 0.45, 0.45, mat(c.skin),  0,     1.25, 0);
  box(player, 0.26, 0.12, 0.32, mat(c.shoes), -0.16, 0.06, 0.02);
  box(player, 0.26, 0.12, 0.32, mat(c.shoes),  0.16, 0.06, 0.02);
  if (c.hat === 0) {          // Кепка
    box(player, 0.52, 0.18, 0.52, mat(c.shirt), 0, 1.55, 0);
    box(player, 0.52, 0.24, 0.52, mat(c.shirt), 0, 1.69, 0);
    box(player, 0.30, 0.08, 0.24, mat(c.shirt), 0, 1.52, 0.31);
  } else if (c.hat === 1) {   // Нет головного убора
    box(player, 0.5, 0.15, 0.5, mat(c.shirt), 0, 1.55, 0);
  } else if (c.hat === 2) {   // Корона
    box(player, 0.5,  0.15, 0.5,  mat(c.shirt),   0, 1.52, 0);
    box(player, 0.56, 0.18, 0.56, mat(0xffd700),   0, 1.67, 0);
    for (let i = -1; i <= 1; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.28, 4), mat(0xffd700));
      spike.position.set(i * 0.2, 1.9, 0);
      player.add(spike);
    }
  }
  sleeveM.color.setHex(c.shirt);
  skinM.color.setHex(c.skin);
}
buildPlayerFromChar();

// ── Драконы ────────────────────────────────────────────────────────────────
const dragonRoot = new THREE.Group();
dragonRoot.visible = settings.dragons;
scene.add(dragonRoot);
const scaleTex = drawTex(32, (g) => {
  g.fillStyle='#222';g.fillRect(0,0,32,32);
  for(let y=0;y<8;y++)for(let x=-1;x<8;x++){
    const px=x*4+(y%2)*2,py=y*4;
    const gr=g.createLinearGradient(0,py,0,py+3);
    gr.addColorStop(0,'#ffffff');gr.addColorStop(1,'#8a8a8a');
    g.fillStyle=gr;g.fillRect(px,py,3,3);
  }
},true);
scaleTex.repeat.set(3,2);
const glitter = drawTex(32,(g)=>{
  g.fillStyle='#000';g.fillRect(0,0,32,32);g.fillStyle='#fff';
  for(let i=0;i<28;i++)g.fillRect((Math.random()*32)|0,(Math.random()*32)|0,1,1);
},true);
glitter.repeat.set(2,2);
const sparkleMats=[];
const mk=(color,extra={})=>{
  const m=new THREE.MeshPhongMaterial({color,map:scaleTex,specular:0xffffff,shininess:90,flatShading:true,emissive:0xfff2b0,emissiveMap:glitter,emissiveIntensity:.5,...extra});
  sparkleMats.push(m);return m;
};
function wingGeo(pts){
  const s=new THREE.Shape();
  pts.forEach(([x,y],i)=>(i?s.lineTo(x,y):s.moveTo(x,y)));
  const g=new THREE.ShapeGeometry(s).rotateX(-Math.PI/2);
  const uv=g.attributes.uv;
  for(let i=0;i<uv.count;i++)uv.setXY(i,uv.getX(i)*.1,uv.getY(i)*.1);
  return g;
}
const innerG=wingGeo([[0,-1],[9,-2],[9,6],[4,7],[0,5]]);
const outerG=wingGeo([[0,-2],[13,-5],[11,1],[8,4],[4,3],[0,6]]);
const ball=new THREE.SphereGeometry(1,7,5);
const spikeG=new THREE.ConeGeometry(.3,.9,4);
const eyeMat=new THREE.MeshBasicMaterial({color:0xffee00});
const dragons=[];
function makeDragon(color,f,h,spd,ph){
  const body=mk(color),bone=mk(0xe8dcc0);
  const dark=mk(new THREE.Color(color).multiplyScalar(.6),{side:THREE.DoubleSide});
  const d={f,h,spd,a:ph,ph,segs:[],wings:[]};
  for(let i=0;i<20;i++){
    const r=2.4*(1-i/24)+.3,s=new THREE.Mesh(ball,body);
    s.scale.set(r,r*.9,r*1.6);
    const sp=new THREE.Mesh(spikeG,bone);sp.position.y=1.05;s.add(sp);
    dragonRoot.add(s);d.segs.push(s);
  }
  d.head=new THREE.Group();
  box(d.head,2.6,2,3.2,body,0,0,0);
  box(d.head,1.7,1.1,2.4,body,0,-.35,2.5);
  for(const sd of[-1,1]){
    const hn=new THREE.Mesh(new THREE.ConeGeometry(.35,2.6,5),bone);
    hn.position.set(sd,1.3,-.8);hn.rotation.x=-1;d.head.add(hn);
    box(d.head,.3,.4,.6,eyeMat,sd*1.32,.5,.8);
  }
  dragonRoot.add(d.head);
  d.shoulder=new THREE.Group();
  for(const side of[1,-1]){
    const inner=new THREE.Group();inner.position.set(side*2.2,1.2,0);inner.scale.x=side;
    inner.add(new THREE.Mesh(innerG,dark));
    const outer=new THREE.Group();outer.position.x=9;
    outer.add(new THREE.Mesh(outerG,dark));
    inner.add(outer);d.shoulder.add(inner);d.wings.push([inner,outer,side]);
  }
  dragonRoot.add(d.shoulder);dragons.push(d);
}
makeDragon(0x2e9b4a,1.0,4,11,0);
makeDragon(0xc0392b,1.4,8,-14,2);
makeDragon(0x7b3fc9,1.9,12,9,4);

const P1=new THREE.Vector3(),Q1=new THREE.Vector3();
function updateDragons(dt,time){
  if(!dragonRoot.visible)return;
  glitter.offset.x+=dt*.12;glitter.offset.y-=dt*.05;
  const tw=.5+.4*Math.sin(time*5);
  sparkleMats.forEach((m)=>(m.emissiveIntensity=tw));
  for(const d of dragons){
    const rx=orbit.rx*d.f+32,rz=orbit.rz*d.f+32,avg=(rx+rz)/2;
    const s=Math.sign(d.spd),gap=3.4/avg,y0=d.h+orbit.top*.5;
    d.a+=(d.spd/avg)*dt;
    const at=(a,o)=>o.set(orbit.cx+rx*Math.cos(a),y0+3*Math.sin(2*a),orbit.cz+rz*Math.sin(a));
    const place=(o,a)=>{at(a,P1);at(a+s*.02,Q1);o.position.copy(P1);o.lookAt(Q1);};
    place(d.head,d.a);
    d.segs.forEach((seg,i)=>place(seg,d.a-s*(i+1)*gap));
    d.shoulder.position.copy(d.segs[3].position);
    d.shoulder.quaternion.copy(d.segs[3].quaternion);
    d.wings.forEach(([inner,outer,side])=>{
      inner.rotation.z=side*Math.sin(time*4.2+d.ph)*.6;
      outer.rotation.z=Math.sin(time*4.2+d.ph-1)*.5;
    });
  }
}

// ── Магазин ────────────────────────────────────────────────────────────────
const SPEED_BASE=7,JUMP_BASE=11,GRAV=30,MAXL=10,PER_LEVEL=0.4;
let SPEED=SPEED_BASE,JUMP=JUMP_BASE;
function applyUpgrades(){SPEED=SPEED_BASE+PER_LEVEL*save.speed;JUMP=JUMP_BASE+PER_LEVEL*save.jump;}
applyUpgrades();
const upCost=(lvl)=>Math.round(4*Math.pow(1.35,lvl));
const UPS=[
  {key:'jump',name:'Прыжок',   info:(l)=>`высота ${(Math.pow(JUMP_BASE+PER_LEVEL*l,2)/(2*GRAV)).toFixed(1)} м`},
  {key:'speed',name:'Скорость',info:(l)=>`бег ${(SPEED_BASE+PER_LEVEL*l).toFixed(1)} м/с`},
];
function renderStore(){
  $('wallet').textContent=save.coins;
  for(const u of UPS){
    const l=save[u.key],max=l>=MAXL,cost=upCost(l),el=$('up-'+u.key);
    el.querySelector('.lv').textContent=`ур. ${l}/${MAXL}`;
    el.querySelector('.bar i').style.width=(l/MAXL)*100+'%';
    el.querySelector('.upd').textContent=max?`${u.info(l)} (максимум)`:`${u.info(l)} → ${u.info(l+1)}`;
    const b=el.querySelector('button');
    b.textContent=max?'МАКСИМУМ':`КУПИТЬ: ${cost} 🪙`;
    b.disabled=max||save.coins<cost;
    b.className='pb'+(max?'':' y');
  }
}
function buy(key){
  const l=save[key],cost=upCost(l);
  if(l>=MAXL||save.coins<cost)return;
  save.coins-=cost;save[key]=l+1;
  persist();applyUpgrades();renderStore();
  say(`${UPS.find((u)=>u.key===key).name}: уровень ${l+1}`);
}
UPS.forEach((u)=>{
  const el=document.createElement('div');
  el.className='upg';el.id='up-'+u.key;
  el.innerHTML=`<div class="upt"><span class="uname">${u.name}</span><span class="lv ulv"></span></div><div class="bar"><i></i></div><div class="upd"></div><button class="pb y" style="margin-top:4px"></button>`;
  el.querySelector('button').onclick=()=>buy(u.key);
  $('upgrades').append(el);
});

// ── Состояние и управление ─────────────────────────────────────────────────
const keys={};
let mode='play',jumpBuf=0,camA=0,pitch=0,fpv=false,snapCam=false,clockT=0,testRun=false,levelId='';
let goalToastAt=0,currentTab='play';
const hud=$('hud'),msg=$('msg');
const mouse=new THREE.Vector2();

const HELP_PLAY='WASD: бег. Пробел: прыжок. V: первое лицо. Q/E, стрелки, мышь: камера. R: заново. M: меню.';
const HELP_EDIT='ЛКМ клик: поставить. ЛКМ тянуть: вращать. ПКМ тянуть: двигать. ПКМ клик: стереть. Колесо: зум. Shift+колесо / Z/X: высота. R: повернуть. F: вся карта. Ctrl+Z: отмена. M: меню.';

let toastT;
function toast(t,ms=2200){
  const el=$('toast');el.textContent=t;el.classList.add('show');
  clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove('show'),ms);
}

function setView(on){
  fpv=on;camera.fov=on?75:60;camera.updateProjectionMatrix();
  player.visible=!on;hands.visible=on;
  if(!on&&document.pointerLockElement)document.exitPointerLock();
}

function reset(){
  p.set(...L.start);v.set(0,0,0);st.onGround=false;
  got=0;time=0;won=false;jumpBuf=0;coyote=0;
  coins.forEach((c)=>(c.visible=true));
  setGoalOpen(coins.length===0);
  levelId=lvId(L);
  msg.style.display='none';
  snapCam=true;
}

addEventListener('keydown',(e)=>{
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))return;
  keys[e.code]=true;
  if(e.code==='Space'||e.code.startsWith('Arrow'))e.preventDefault();
  if(e.code==='KeyM')$('panel').classList.toggle('hide');
  if(mode==='play'){
    if(e.code==='Space')jumpBuf=0.15;
    if(e.code==='KeyR')reset();
    if(e.code==='KeyV')setView(!fpv);
  }else{
    if(e.code==='KeyZ'&&(e.ctrlKey||e.metaKey)){e.preventDefault();undo();return;}
    if(e.code==='KeyZ'){ed.h-=0.5;syncUI();}
    if(e.code==='KeyX'){ed.h+=0.5;syncUI();}
    if(e.code==='KeyR'){ed.rot=(ed.rot+(e.shiftKey?-15:15)+360)%360;ed.dirty=true;syncUI();}
    if(e.code==='KeyF')fitView();
    const ti=['Digit1','Digit2','Digit3','Digit4','Digit5'].indexOf(e.code);
    if(ti>=0)setTool(TOOLS[ti][0]);
  }
});
addEventListener('keyup',(e)=>{keys[e.code]=false;});
addEventListener('blur',()=>{for(const k in keys)keys[k]=false;});
addEventListener('click',(e)=>{
  if(mode==='play'&&fpv&&e.target===renderer.domElement&&!document.pointerLockElement)renderer.domElement.requestPointerLock();
});
addEventListener('mousemove',(e)=>{
  if(mode==='play'&&(document.pointerLockElement||e.buttons)){
    camA-=e.movementX*.005;
    pitch=Math.max(-1.4,Math.min(1.4,pitch-e.movementY*.005));
  }
});

// ── Физика ─────────────────────────────────────────────────────────────────
const p=new THREE.Vector3(),v=new THREE.Vector3(),tmp=new THREE.Vector3();
const st={onGround:false,landed:false,landVy:0};
let coyote=0,face=0,got=0,time=0,won=false;
let armPhase=0,armLift=0,landKick=0,lastHud='';

function win(){
  won=true;
  const total=coins.length;
  let extra='';
  if(testRun)extra='<br>Тест уровня: награда не начисляется';
  else{
    const prev=save.best[levelId];
    if(prev==null||time<prev){save.best[levelId]=time;extra+='<br>🏆 Новый рекорд!';}
    else extra+=`<br>Рекорд: ${prev.toFixed(1)} с`;
    if(total){save.coins+=total;extra+=`<br>+${total} монет в кошелёк`;}
    persist();
    if(currentTab==='store')renderStore();
  }
  msg.style.display='flex';
  $('msg-inner').innerHTML=`⭐ ЗВЕЗДА! ⭐<br><br>Время: ${time.toFixed(1)} с<br>Монет: ${got}/${total}${extra}<br><br>[ R ] — ИГРАТЬ СНОВА`;
}

function update(dt){
  camA+=((keys.ArrowLeft||keys.KeyQ?1:0)-(keys.ArrowRight||keys.KeyE?1:0))*2*dt;
  if(fpv)pitch=Math.max(-1.4,Math.min(1.4,pitch+((keys.ArrowUp?1:0)-(keys.ArrowDown?1:0))*1.5*dt));
  const f=(keys.KeyW?1:0)-(keys.KeyS?1:0),r=(keys.KeyD?1:0)-(keys.KeyA?1:0);
  let dx=-Math.sin(camA)*f+Math.cos(camA)*r,dz=-Math.cos(camA)*f-Math.sin(camA)*r;
  const len=Math.hypot(dx,dz);
  if(len>0){dx/=len;dz/=len;face=Math.atan2(dx,dz);}
  v.x=dx*SPEED;v.z=dz*SPEED;
  coyote=st.onGround?0.1:coyote-dt;jumpBuf-=dt;
  if(jumpBuf>0&&coyote>0){v.y=JUMP;coyote=0;jumpBuf=0;st.onGround=false;}
  const n=Math.max(1,Math.ceil(dt/.01)),h=dt/n;
  let landV=0;
  for(let i=0;i<n;i++){
    v.y=Math.max(-35,v.y-GRAV*h);
    stepBody(parts,p,v,h,st);
    if(st.landed&&st.landVy<landV)landV=st.landVy;
  }
  if(landV<-6)landKick=Math.min(1,-landV/20);
  if(p.y<voidY){p.set(...L.start);v.set(0,0,0);st.onGround=false;snapCam=true;}
  tmp.set(p.x,p.y+.8,p.z);
  for(const c of coins){
    if(!c.visible)continue;
    c.rotation.y+=dt*4;
    if(c.position.distanceTo(tmp)<1){
      c.visible=false;got++;
      if(got>=coins.length){setGoalOpen(true);toast('✅ Все монеты собраны! Беги к звезде!');}
    }
  }
  goal.rotation.y+=dt*(goalOpen?2:.8);
  goal.scale.setScalar(goalOpen?1+.08*Math.sin(clockT*5):1);
  if(!won&&goal.position.distanceTo(tmp)<1.4){
    if(goalOpen)win();
    else if(clockT>goalToastAt){toast(`Сначала собери все монеты! Осталось: ${coins.length-got}`);goalToastAt=clockT+1.5;}
  }
  if(!won)time+=dt;
  const best=save.best[levelId];
  const txt=`МОНЕТЫ ${got}/${coins.length}${goalOpen&&coins.length&&!won?'  → К ЗВЕЗДЕ!':''}   ВРЕМЯ ${time.toFixed(1)}\nКОШЕЛЁК ${save.coins}${best!=null?'   РЕКОРД '+best.toFixed(1):''}`;
  if(txt!==lastHud){hud.textContent=txt;lastHud=txt;}
  player.position.copy(p);player.rotation.y=face;
  const gy=supportY(parts,p.x,p.z,p.y+.05);
  shadow.visible=gy>-Infinity;shadow.position.set(p.x,gy+.02,p.z);
  const spd=Math.hypot(v.x,v.z)/SPEED;
  armPhase+=dt*11*spd;
  armLift+=((st.onGround?0:Math.max(-1,Math.min(1,v.y/JUMP))*.7)-armLift)*(1-Math.exp(-12*dt));
  landKick=Math.max(0,landKick-dt*4);
  const sw=Math.sin(armPhase)*.55*spd;
  armL.rotation.x=.15+sw+armLift;armR.rotation.x=.15-sw+armLift;
  hands.position.set(Math.sin(armPhase*.5)*.02*spd,-Math.abs(Math.sin(armPhase))*.03*spd-landKick*.1+Math.sin(clockT*1.6)*.006,0);
  if(fpv){
    camera.position.set(p.x,p.y+1.5+Math.abs(Math.sin(armPhase))*.04*spd,p.z);
    camera.rotation.set(pitch,camA,0);
  }else{
    tmp.set(p.x+Math.sin(camA)*8,p.y+4.5,p.z+Math.cos(camA)*8);
    if(snapCam)camera.position.copy(tmp);else camera.position.lerp(tmp,1-Math.exp(-6*dt));
    camera.lookAt(p.x,p.y+1.2,p.z);
  }
  snapCam=false;
}

// ── Редактор ───────────────────────────────────────────────────────────────
const TOOLS=[['plat','Платформа'],['coin','Монета'],['goal','Звезда'],['start','Старт'],['erase','Стереть']];
const ed={
  tool:'plat',shape:0,w:3,d:3,rot:0,tilt:0,k:1,h:0,step:.5,snap:true,
  mx:0,my:0,mz:0,below:null,
  tx:0,ty:0,tz:0,yaw:.5,pitch:.95,dist:22,
  over:false,dirty:true,
};
const ray=new THREE.Raycaster(),ray2=new THREE.Raycaster(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
const hitP=new THREE.Vector3(),rayO=new THREE.Vector3(),DOWN=new THREE.Vector3(0,-1,0);

const ghostShape=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial({color:0x7dff9a,transparent:true,opacity:.5,depthWrite:false}));
const ghostEdges=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xffffff}));
ghostShape.add(ghostEdges);
const ghostBox=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({color:0xffffff,wireframe:true}));
const footMat=new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.4,depthWrite:false});
const footprint=new THREE.Mesh(new THREE.BufferGeometry(),footMat);
const dot=new THREE.Mesh(new THREE.CircleGeometry(.45,12).rotateX(-Math.PI/2),footMat);
const dropGeo=new THREE.BufferGeometry();
dropGeo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(6),3));
const dropLine=new THREE.Line(dropGeo,new THREE.LineBasicMaterial({color:0xffee55}));
dropLine.frustumCulled=false;
const grid1=new THREE.GridHelper(64,64,0xffffff,0xffffff),grid2=new THREE.GridHelper(60,12,0xffffff,0xffffff);
for(const g of[grid1,grid2]){g.material.transparent=true;g.material.depthWrite=false;}
grid1.material.opacity=.12;grid2.material.opacity=.3;
helpers.add(grid1,grid2,ghostShape,ghostBox,footprint,dot,dropLine);

function rebuildGhost(){
  const pl=normPlat([0,0,0,ed.w,ed.d,ed.shape,0,ed.tilt,ed.k]);
  const geo=platGeometry(localParts(pl),Math.tan(ed.tilt*DEG));
  ghostShape.geometry.dispose();ghostShape.geometry=geo;
  ghostEdges.geometry.dispose();ghostEdges.geometry=new THREE.EdgesGeometry(geo,25);
  footprint.geometry=geo;ed.dirty=false;
}

const hist=[];
const snap=()=>JSON.stringify({name:L.name,plats:L.plats,coins:L.coins,goal:L.goal,start:L.start});
function pushHist(){hist.push(snap());if(hist.length>60)hist.shift();}
function undo(){
  const s=hist.pop();
  if(!s)return say('Нечего отменять');
  Object.assign(L,JSON.parse(s));edited();$('ename').value=L.name;
}

function computePlacement(){
  const rd=(x)=>Math.round(x/ed.step)*ed.step,lim=(x)=>Math.max(-290,Math.min(290,x));
  ray.setFromCamera(mouse,camera);
  let x=0,z=0,y=ed.h,got=false;
  if(ed.snap&&ed.tool!=='erase'){
    const hit=ray.intersectObjects(platMeshes,false)[0];
    if(hit&&hit.face&&hit.face.normal.y>.5){x=rd(hit.point.x);z=rd(hit.point.z);y=Math.round(hit.point.y*100)/100;got=true;}
  }
  if(!got){
    plane.constant=-ed.h;
    if(!ray.ray.intersectPlane(plane,hitP))return false;
    x=rd(hitP.x);z=rd(hitP.z);
  }
  ed.mx=lim(x);ed.mz=lim(z);ed.my=y;
  rayO.set(ed.mx,ed.my+.02,ed.mz);
  ray2.set(rayO,DOWN);ray2.far=200;
  const b=ray2.intersectObjects(platMeshes,false)[0];
  ed.below=b?b.point.y:null;
  return true;
}

function setHover(o){
  if(hoverObj===o)return;
  if(hoverObj){if(hoverObj.userData.k==='p')hoverObj.material.emissive.setHex(0);else hoverObj.scale.setScalar(1);}
  hoverObj=o;
  if(o){if(o.userData.k==='p')o.material.emissive.setHex(0xaa2222);else o.scale.setScalar(1.5);}
}

const fmt=(x)=>String(Math.round(x*100)/100);
let lastInfo='';
const GHOST_BOX={coin:[.8,.8,.8,1.3],goal:[1.4,1.4,1.4,1.6],start:[.8,1.2,.8,.6]};

function updateGuides(){
  const t=ed.tool,plat=t==='plat';
  const have=ed.over&&computePlacement();
  ghostShape.visible=have&&plat;
  ghostBox.visible=have&&!!GHOST_BOX[t];
  dropLine.visible=footprint.visible=dot.visible=false;
  const gx=have?ed.mx:ed.tx,gz=have?ed.mz:ed.tz,gy=have?ed.my:ed.h;
  grid1.position.set(Math.round(gx),gy+.03,Math.round(gz));
  grid2.position.set(Math.round(gx/5)*5,gy+.03,Math.round(gz/5)*5);
  let txt='';
  if(have){
    if(t==='erase'){
      ray.setFromCamera(mouse,camera);
      const hit=ray.intersectObjects(levelGroup.children,false)[0];
      setHover(hit&&(hit.object.userData.k==='p'||hit.object.userData.k==='c')?hit.object:null);
    }else{
      setHover(null);
      let startY=ed.my;
      if(plat){
        if(ed.dirty)rebuildGhost();
        ghostShape.position.set(ed.mx,ed.my,ed.mz);ghostShape.rotation.y=ed.rot*DEG;
      }else{
        const S=GHOST_BOX[t];
        ghostBox.scale.set(S[0],S[1],S[2]);ghostBox.position.set(ed.mx,ed.my+S[3],ed.mz);
        startY=ed.my+S[3];
      }
      const bottom=ed.below!=null?ed.below:startY-30;
      const a=dropGeo.attributes.position;
      a.setXYZ(0,ed.mx,startY,ed.mz);a.setXYZ(1,ed.mx,bottom,ed.mz);a.needsUpdate=true;
      dropLine.visible=startY-bottom>.05;
      if(ed.below!=null&&ed.my-ed.below>.05){
        const f=plat?footprint:dot;
        f.visible=true;f.position.set(ed.mx,ed.below+.04,ed.mz);
        if(plat){f.rotation.y=ed.rot*DEG;f.scale.set(1,.02,1);}
      }
    }
    txt=`X ${fmt(ed.mx)}   Z ${fmt(ed.mz)}   ВЫСОТА ${fmt(ed.my)}`+(ed.below!=null?`   (над пл. +${fmt(ed.my-ed.below)})`:'   (под ним пусто)')+'\n';
  }else setHover(null);
  txt+=`Плоскость: ${fmt(ed.h)}${ed.snap?' (прилипание)':''}   Платформ: ${L.plats.length}/80   Монет: ${L.coins.length}/100`;
  if(txt!==lastInfo){$('edinfo').textContent=txt;lastInfo=txt;}
}

function updateEdit(dt){
  ed.yaw+=((keys.KeyQ?1:0)-(keys.KeyE?1:0))*1.8*dt;
  const f=(keys.KeyW?1:0)-(keys.KeyS?1:0),r=(keys.KeyD?1:0)-(keys.KeyA?1:0),sp=ed.dist*.8*dt;
  ed.tx+=(-Math.sin(ed.yaw)*f+Math.cos(ed.yaw)*r)*sp;
  ed.tz+=(-Math.cos(ed.yaw)*f-Math.sin(ed.yaw)*r)*sp;
  ed.ty+=(ed.h-ed.ty)*(1-Math.exp(-8*dt));
  const cp=Math.cos(ed.pitch);
  camera.position.set(ed.tx+Math.sin(ed.yaw)*cp*ed.dist,ed.ty+Math.sin(ed.pitch)*ed.dist,ed.tz+Math.cos(ed.yaw)*cp*ed.dist);
  camera.lookAt(ed.tx,ed.ty,ed.tz);camera.updateMatrixWorld();
  updateGuides();
  coins.forEach((c)=>(c.rotation.y+=dt*4));
  goal.rotation.y+=dt*2;
}

function fitView(){
  const B=partsBounds(parts);
  let x0=B.minX,x1=B.maxX,z0=B.minZ,z1=B.maxZ;
  for(const[x,,z]of[...L.coins,L.goal,L.start]){x0=Math.min(x0,x);x1=Math.max(x1,x);z0=Math.min(z0,z);z1=Math.max(z1,z);}
  ed.tx=(x0+x1)/2;ed.tz=(z0+z1)/2;
  ed.dist=Math.min(180,Math.max(10,Math.hypot(x1-x0,z1-z0)*.9+6));
  ed.pitch=.9;
}

function edited(){L.seed=null;L.id=null;buildLevel(L);if(mode==='edit')setGoalOpen(true);$('lvname').textContent=L.name;}
function erase(){
  ray.setFromCamera(mouse,camera);
  const hit=ray.intersectObjects(levelGroup.children,false)[0];
  const u=hit&&hit.object.userData;
  if(!u)return;
  if(u.k==='p'&&L.plats.length>1){pushHist();L.plats.splice(u.i,1);}
  else if(u.k==='c'){pushHist();L.coins.splice(u.i,1);}
  else return;
  edited();
}
function place(){
  if(!computePlacement())return;
  const{tool:t,mx:x,my:y,mz:z}=ed;
  if(t==='erase')return erase();
  if(t==='plat'&&L.plats.length>=80)return say('Максимум 80 платформ');
  if(t==='coin'&&L.coins.length>=100)return say('Максимум 100 монет');
  pushHist();
  if(t==='plat')L.plats.push([x,y,z,ed.w,ed.d,ed.shape,ed.rot,ed.tilt,ed.k]);
  else if(t==='coin')L.coins.push([x,y+1.3,z]);
  else if(t==='goal')L.goal=[x,y+1.6,z];
  else if(t==='start')L.start=[x,y,z];
  edited();
}

const cv=renderer.domElement;
const drag={on:false,btn:0,x:0,y:0,sx:0,sy:0,moved:false,shift:false};
const setMouse=(e)=>mouse.set((e.clientX/innerWidth)*2-1,-(e.clientY/innerHeight)*2+1);
cv.addEventListener('contextmenu',(e)=>e.preventDefault());
cv.addEventListener('mousedown',(e)=>{if(e.button===1)e.preventDefault();});
cv.addEventListener('pointerdown',(e)=>{
  if(mode!=='edit')return;
  cv.setPointerCapture(e.pointerId);
  Object.assign(drag,{on:true,btn:e.button,x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY,moved:false,shift:e.shiftKey});
  setMouse(e);ed.over=true;
});
cv.addEventListener('pointermove',(e)=>{
  if(mode!=='edit')return;
  setMouse(e);ed.over=true;
  if(!drag.on)return;
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  drag.x=e.clientX;drag.y=e.clientY;
  if(!drag.moved&&Math.hypot(e.clientX-drag.sx,e.clientY-drag.sy)>5)drag.moved=true;
  if(!drag.moved)return;
  if(drag.btn===0&&!drag.shift){
    ed.yaw-=dx*.006;ed.pitch=Math.max(.08,Math.min(1.5,ed.pitch+dy*.005));
  }else{
    const k=ed.dist*.0012,sx=Math.cos(ed.yaw),sz=-Math.sin(ed.yaw),fx=-Math.sin(ed.yaw),fz=-Math.cos(ed.yaw);
    const fk=k/Math.max(.35,Math.sin(ed.pitch));
    ed.tx+=-sx*dx*k+fx*dy*fk;ed.tz+=-sz*dx*k+fz*dy*fk;
  }
});
cv.addEventListener('pointerup',(e)=>{
  if(!drag.on)return;drag.on=false;
  if(mode!=='edit'||drag.moved)return;
  setMouse(e);
  if(drag.btn===0)place();else if(drag.btn===2)erase();
});
cv.addEventListener('pointerleave',()=>{if(!drag.on)ed.over=false;});
cv.addEventListener('wheel',(e)=>{
  if(mode!=='edit')return;e.preventDefault();
  const dlt=e.deltaY||e.deltaX;
  if(e.shiftKey){ed.h+=dlt<0?.5:-.5;syncUI();}
  else ed.dist=Math.max(4,Math.min(180,ed.dist*(1+Math.sign(dlt)*.1)));
},{passive:false});

// ── Меню / Мастерская ──────────────────────────────────────────────────────
let sayT;
function say(t){$('status').textContent=t;clearTimeout(sayT);sayT=setTimeout(()=>($('status').textContent=''),4000);}

function syncUI(){
  $('edw').value=ed.w;$('edd').value=ed.d;$('edrot').value=ed.rot;
  $('edtilt').value=ed.tilt;$('edk').value=ed.k;$('edh').value=ed.h;
}
function setTool(t){
  ed.tool=t;
  document.querySelectorAll('#tools button').forEach((b)=>b.classList.toggle('on',b.dataset.tool===t));
}
function setShape(i){
  ed.shape=i;ed.dirty=true;setTool('plat');
  document.querySelectorAll('#shapes button').forEach((b)=>b.classList.toggle('on',+b.dataset.shape===i));
  $('shapename').textContent=SHAPES[i].name;
}
TOOLS.forEach(([id,name],i)=>{
  const b=document.createElement('button');
  b.dataset.tool=id;b.textContent=`${i+1} ${name}`;b.onclick=()=>setTool(id);
  $('tools').append(b);
});
SHAPES.forEach((s,i)=>{
  const b=document.createElement('button');
  b.dataset.shape=i;b.textContent=s.icon;b.title=s.name;b.onclick=()=>setShape(i);
  $('shapes').append(b);
});

function setTab(t){
  currentTab=t;
  document.querySelectorAll('.pane').forEach((el)=>(el.style.display=el.id==='pane-'+t?'block':'none'));
  document.querySelectorAll('#tabs button').forEach((b)=>b.classList.toggle('on',b.dataset.tab===t));
  const e=t==='edit';
  helpers.visible=marker.visible=e;
  outlines.forEach((o)=>(o.visible=e));
  if(!e){setHover(null);ed.over=false;}
  dragonRoot.visible=!e&&settings.dragons;
  hud.style.display=e?'none':'';
  $('edinfo').style.display=e?'block':'none';
  $('help').textContent=e?HELP_EDIT:HELP_PLAY;
  cv.style.cursor=e?'crosshair':'';
  if(e!==(mode==='edit')){
    mode=e?'edit':'play';
    if(document.pointerLockElement)document.exitPointerLock();
    setView(false);
    if(scene.fog){scene.fog.near=e?80:24;scene.fog.far=e?420:150;}
    setFar(e?600:250);
    if(e){
      player.visible=hands.visible=shadow.visible=false;
      setGoalOpen(true);msg.style.display='none';
      $('ename').value=L.name;
      ed.tx=L.start[0];ed.tz=L.start[2];ed.h=L.start[1];ed.ty=ed.h;
      hist.length=0;syncUI();fitView();
    }else{testRun=true;reset();}
  }
  // Персонаж
  if(t==='char'){
    $('charName').value=save.char.name;
    $('cShirt').value=n2h(save.char.shirt);
    $('cPants').value=n2h(save.char.pants);
    $('cSkin').value=n2h(save.char.skin);
    $('cShoes').value=n2h(save.char.shoes);
    charHatSel=save.char.hat;
    document.querySelectorAll('#hatBtns button').forEach((b,i)=>b.classList.toggle('on',i===charHatSel));
    $('charNameD').textContent=save.char.name;
    initCharPreview();
    rebuildCharPreviewMesh();
  }
  if(t==='work')loadWork();
  if(t==='store')renderStore();
}

function play(lv){
  L=lv;buildLevel(L);hist.length=0;
  $('lvname').textContent=L.name;$('seed').value=L.seed??'';
  const wasEdit=mode==='edit';
  setTab('play');testRun=false;
  if(!wasEdit)reset();
}

async function copyLink(){
  const base=location.href.split('#')[0];
  const link=L.seed?`${base}#S=${encodeURIComponent(L.seed)}`:`${base}#L=${enc(L)}`;
  try{await navigator.clipboard.writeText(link);say('Ссылка скопирована!');}catch{prompt('Скопируйте ссылку:',link);}
}
const ghRepo=()=>({
  owner:location.hostname.endsWith('github.io')?location.hostname.split('.')[0]:'OWNER',
  repo:location.pathname.split('/')[1]||'REPO',
});

async function loadWork(){
  const list=$('worklist'),{owner,repo}=ghRepo();
  list.textContent='Загрузка…';
  try{
    const res=await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?labels=workshop&state=open&per_page=50`);
    if(!res.ok)throw new Error(res.status);
    const items=[];
    for(const it of await res.json()){
      if(it.pull_request)continue;
      const m=/```level\s+([\w-]+)\s+```/.exec(it.body||'');
      const lv=m&&dec(m[1]);
      if(lv)items.push({lv,author:it.user.login,likes:(it.reactions&&it.reactions['+1'])||0,url:it.html_url});
    }
    items.sort((a,b)=>b.likes-a.likes);
    list.textContent=items.length?'':'Пока пусто. Станьте первым!';
    for(const it of items){
      const row=document.createElement('div');row.className='witem';
      const b=document.createElement('button');b.className='pb';
      b.textContent=`${it.lv.name} · ${it.author} · 👍${it.likes}`;
      b.onclick=()=>play(it.lv);
      const a=document.createElement('a');a.href=it.url;a.target='_blank';a.textContent='↗';
      row.append(b,a);list.append(row);
    }
  }catch{list.textContent='Не удалось загрузить Мастерскую (она работает на GitHub Pages).';}
}

// ── Обработчики кнопок ─────────────────────────────────────────────────────
document.querySelectorAll('#tabs button').forEach((b)=>(b.onclick=()=>setTab(b.dataset.tab)));
$('panel').addEventListener('click',(e)=>{if(e.target.tagName==='BUTTON')e.target.blur();});
document.querySelectorAll('.link').forEach((b)=>(b.onclick=copyLink));
$('btnSeed').onclick=()=>play(generate($('seed').value.trim()||'default'));
$('btnRand').onclick=()=>{const s=Math.random().toString(36).slice(2,8);$('seed').value=s;play(generate(s));};
$('btnClassic').onclick=()=>play(classic());
$('btnCode').onclick=()=>{const lv=dec($('code').value.trim());lv?play(lv):say('Код не подходит');};
$('btnTest').onclick=()=>setTab('play');
$('btnNew').onclick=()=>{
  pushHist();
  L={name:'Мой уровень',plats:[[0,0,0,6,6]],coins:[],goal:[0,1.6,-8],start:[0,0,0]};
  buildLevel(L);setGoalOpen(true);$('ename').value=L.name;$('lvname').textContent=L.name;
  hist.length=0;ed.tx=0;ed.tz=0;ed.h=0;syncUI();fitView();
};
$('btnWork').onclick=loadWork;
$('btnUndo').onclick=undo;
$('camTop').onclick=()=>{ed.pitch=1.5;};
$('camSide').onclick=()=>{ed.pitch=0.12;};
$('camFit').onclick=fitView;
$('btnReset').onclick=()=>{
  if(!confirm('Сбросить монеты, улучшения и рекорды?'))return;
  const ch=save.char; // сохраняем персонажа
  save=blankSave();save.char=ch;
  persist();applyUpgrades();renderStore();
};
$('btnSubmit').onclick=()=>{
  const{owner,repo}=ghRepo();
  const body=`Название: ${L.name}\n\n\`\`\`level\n${enc(L)}\n\`\`\`\n`;
  window.open(`https://github.com/${owner}/${repo}/issues/new?title=${encodeURIComponent('[Уровень] '+L.name)}&body=${encodeURIComponent(body)}`,'_blank');
  say('Нажмите Submit new issue на GitHub');
};
const num=(id,lo,hi,fn)=>{
  $(id).oninput=(e)=>{const x=parseFloat(e.target.value);if(Number.isFinite(x)){fn(Math.max(lo,Math.min(hi,x)));ed.dirty=true;}};
};
num('edw',1,30,(x)=>(ed.w=x));num('edd',1,30,(x)=>(ed.d=x));
num('edrot',-720,720,(x)=>(ed.rot=x));num('edtilt',-60,60,(x)=>(ed.tilt=x));
num('edk',.25,20,(x)=>(ed.k=x));num('edh',-300,300,(x)=>(ed.h=x));
$('edstep').onchange=(e)=>{ed.step=+e.target.value;e.target.blur();};
$('edsnap').onchange=(e)=>{ed.snap=e.target.checked;e.target.blur();};
$('ename').oninput=(e)=>{L.name=e.target.value.slice(0,40);$('lvname').textContent=L.name;};

// ── Редактор персонажа ─────────────────────────────────────────────────────
let charPrev=null;
let charHatSel=save.char.hat;

function initCharPreview(){
  if(charPrev)return;
  const canvas=$('charPreview');
  const rend=new THREE.WebGLRenderer({canvas,antialias:false,alpha:false});
  rend.setPixelRatio(1);rend.setSize(180,268,false);rend.setClearColor(0x080012,1);
  const cscene=new THREE.Scene();
  const ccam=new THREE.PerspectiveCamera(46,180/268,.1,50);
  ccam.position.set(0,1.1,4.2);ccam.lookAt(0,.95,0);
  cscene.add(new THREE.AmbientLight(0x9988cc,.6));
  const dl=new THREE.DirectionalLight(0xffffff,1.3);dl.position.set(3,6,3);cscene.add(dl);
  const rl=new THREE.DirectionalLight(0x6633cc,.45);rl.position.set(-3,1,-2);cscene.add(rl);
  // Подставка
  const platM=new THREE.MeshLambertMaterial({color:0x1a0033});
  const plat=new THREE.Mesh(new THREE.CylinderGeometry(1.5,1.5,.22,8),platM);
  plat.position.y=-.11;cscene.add(plat);
  const grid=new THREE.GridHelper(2.6,6,0x440066,0x220044);
  grid.position.y=.02;cscene.add(grid);
  const cgroup=new THREE.Group();cscene.add(cgroup);
  charPrev={rend,scene:cscene,cam:ccam,group:cgroup,plat};
}

function rebuildCharPreviewMesh(){
  if(!charPrev)return;
  const g=charPrev.group;
  while(g.children.length){
    const c=g.children[0];
    if(c.geometry)c.geometry.dispose();
    if(c.material)c.material.dispose();
    g.remove(c);
  }
  const c={
    shirt: h2n($('cShirt').value),
    pants: h2n($('cPants').value),
    skin:  h2n($('cSkin').value),
    shoes: h2n($('cShoes').value),
    hat:   charHatSel,
  };
  box(g,.6,.4,.35,mat(c.pants),0,.2,0);
  box(g,.7,.6,.4, mat(c.shirt),0,.7,0);
  box(g,.45,.45,.45,mat(c.skin),0,1.25,0);
  box(g,.26,.12,.32,mat(c.shoes),-.16,.06,.02);
  box(g,.26,.12,.32,mat(c.shoes), .16,.06,.02);
  if(c.hat===0){
    box(g,.52,.18,.52,mat(c.shirt),0,1.55,0);
    box(g,.52,.24,.52,mat(c.shirt),0,1.69,0);
    box(g,.30,.08,.24,mat(c.shirt),0,1.52,.31);
  }else if(c.hat===2){
    box(g,.5,.15,.5,mat(c.skin),0,1.52,0);
    box(g,.56,.18,.56,mat(0xffd700),0,1.67,0);
    for(let i=-1;i<=1;i++){
      const sp=new THREE.Mesh(new THREE.ConeGeometry(.075,.28,4),mat(0xffd700));
      sp.position.set(i*.2,1.89,0);g.add(sp);
    }
  }
}

function renderCharPreview(t){
  if(!charPrev)return;
  charPrev.group.rotation.y=Math.sin(t*.35)*.7+t*.15;
  charPrev.plat.rotation.y=-t*.4;
  charPrev.rend.render(charPrev.scene,charPrev.cam);
}

// Шапки
const HATS=['🧢 Кепка','❌ Нет','👑 Корона'];
HATS.forEach((label,i)=>{
  const b=document.createElement('button');b.className='pb';
  b.textContent=label;
  if(i===charHatSel)b.classList.add('on');
  b.onclick=()=>{
    charHatSel=i;
    document.querySelectorAll('#hatBtns button').forEach((bb)=>bb.classList.remove('on'));
    b.classList.add('on');
    rebuildCharPreviewMesh();
  };
  $('hatBtns').append(b);
});

// Цвета меняются → обновляем превью
['cShirt','cPants','cSkin','cShoes'].forEach((id)=>{$(id).oninput=()=>rebuildCharPreviewMesh();});

// Имя
$('charName').oninput=(e)=>{$('charNameD').textContent=e.target.value||'ИГРОК';};

$('btnSaveChar').onclick=()=>{
  save.char={
    name:($('charName').value||'ИГРОК').slice(0,16),
    shirt:h2n($('cShirt').value),
    pants:h2n($('cPants').value),
    skin: h2n($('cSkin').value),
    shoes:h2n($('cShoes').value),
    hat:charHatSel,
  };
  persist();
  buildPlayerFromChar();
  $('charNameD').textContent=save.char.name;
  toast('✅ Персонаж сохранён!');
};

$('btnResetChar').onclick=()=>{
  save.char={...DEF_CHAR};persist();
  buildPlayerFromChar();
  $('charName').value=DEF_CHAR.name;
  $('cShirt').value=n2h(DEF_CHAR.shirt);
  $('cPants').value=n2h(DEF_CHAR.pants);
  $('cSkin').value=n2h(DEF_CHAR.skin);
  $('cShoes').value=n2h(DEF_CHAR.shoes);
  charHatSel=DEF_CHAR.hat;
  document.querySelectorAll('#hatBtns button').forEach((b,i)=>b.classList.toggle('on',i===0));
  $('charNameD').textContent=DEF_CHAR.name;
  rebuildCharPreviewMesh();
  toast('🔄 Персонаж сброшен');
};

// ── Настройки ──────────────────────────────────────────────────────────────
$('stSSAO').checked=settings.ssao;
$('stFog').checked=settings.fog;
$('stDragons').checked=settings.dragons;
$('stClouds').checked=settings.clouds;
$('stTint').checked=settings.tint;

$('stSSAO').onchange=(e)=>{settings.ssao=e.target.checked;ssao.enabled=e.target.checked;saveSettings();};
$('stFog').onchange=(e)=>{settings.fog=e.target.checked;scene.fog=e.target.checked?mainFog:null;saveSettings();};
$('stDragons').onchange=(e)=>{settings.dragons=e.target.checked;dragonRoot.visible=mode!=='edit'&&e.target.checked;saveSettings();};
$('stClouds').onchange=(e)=>{settings.clouds=e.target.checked;clouds.setVisible(e.target.checked);saveSettings();};
$('stTint').onchange=(e)=>{settings.tint=e.target.checked;TINT=e.target.checked;buildLevel(L);saveSettings();};

// ── Ссылка из хэша ─────────────────────────────────────────────────────────
function loadHash(){
  const h=location.hash.slice(1);
  if(h.startsWith('S='))play(generate(decodeURIComponent(h.slice(2))));
  else if(h.startsWith('L=')){const lv=dec(h.slice(2));if(lv)play(lv);else say('Ссылка на уровень повреждена');}
}
addEventListener('hashchange',loadHash);

// ── Старт ──────────────────────────────────────────────────────────────────
const clock=new THREE.Clock();
function loop(){
  requestAnimationFrame(loop);
  const dt=Math.min(clock.getDelta(),.05);
  clockT+=dt;
  if(mode==='play')update(dt);else updateEdit(dt);
  updateDragons(dt,clockT);
  if(settings.clouds)clouds.update(dt,clockT,camera.position);
  composer.render();
  if(currentTab==='char')renderCharPreview(clockT);
}

// Инициализация
setShape(0);setTool('plat');syncUI();
$('charNameD').textContent=save.char.name;
play(classic());
loadHash();
loop();

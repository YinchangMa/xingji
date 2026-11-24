/* 行迹 —— GPX 卫星轨迹查看器（纯前端，数据只存本机 IndexedDB） */
'use strict';
const $ = s => document.querySelector(s);

/* ---------------- 图源配置 ----------------
 * maxNative：图源真实提供影像的最大级别，超过后由 Leaflet 放大显示（所以地图始终可以放到 22 级）
 * crs：wgs / gcj —— 高德等国内图源是 GCJ-02，需要对轨迹做偏移才能对齐 */
const BUILTIN_SOURCES = [
  { id: 'g-sat',  name: '谷歌卫星',        url: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&scale=2', sub: '0123', maxNative: 21, crs: 'wgs', attr: 'Imagery © Google' },
  { id: 'g-hyb',  name: '谷歌卫星 + 路网',  url: 'https://mt{s}.google.com/vt/lyrs=y&hl=zh-CN&x={x}&y={y}&z={z}&scale=2', sub: '0123', maxNative: 21, crs: 'wgs', attr: 'Imagery © Google' },
  { id: 'esri',   name: 'Esri 卫星',        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxNative: 19, crs: 'wgs', attr: 'Esri, Maxar, Earthstar Geographics' },
  { id: 'bing',   name: 'Bing 卫星',        url: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=14000', sub: '0123', maxNative: 19, crs: 'wgs', attr: '© Microsoft' },
  { id: 'a-sat',  name: '高德卫星',         url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', sub: '1234', maxNative: 18, crs: 'gcj', attr: '© 高德' },
  { id: 'g-road', name: '谷歌街道',         url: 'https://mt{s}.google.com/vt/lyrs=m&hl=zh-CN&x={x}&y={y}&z={z}&scale=2', sub: '0123', maxNative: 21, crs: 'wgs', attr: '© Google' },
];
const MAX_ZOOM = 22;

/* ---------------- 设置（localStorage，失败时静默用默认值） ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('xj.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('xj.' + k, JSON.stringify(v)); } catch {} },
};
const S = {
  src: store.get('src', 'g-sat'),
  crs: store.get('crs', 'wgs'),
  color: store.get('color', 'speed'),
  width: store.get('width', 4),
  ends: store.get('ends', true),
  mode: store.get('mode', 'latest'),
  picked: new Set(store.get('picked', [])),
  year: store.get('year', ''),
  custom: store.get('customSrc', []),
};
const saveS = () => {
  store.set('src', S.src); store.set('crs', S.crs); store.set('color', S.color); store.set('width', S.width);
  store.set('ends', S.ends); store.set('mode', S.mode); store.set('picked', [...S.picked]); store.set('year', S.year);
  store.set('customSrc', S.custom);
};

/* ---------------- IndexedDB ---------------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('xingji', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('tracks', { keyPath: 'id' }); d.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (name, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(name, mode), req = fn(t.objectStore(name));
      t.oncomplete = () => res(req instanceof IDBRequest ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx('tracks', 'readonly', s => s.getAll()),
    putMany: arr => tx('tracks', 'readwrite', s => arr.forEach(v => s.put(v))),
    del: id => tx('tracks', 'readwrite', s => s.delete(id)),
    clear: () => tx('tracks', 'readwrite', s => s.clear()),
    get: k => tx('kv', 'readonly', s => s.get(k)),
    set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
  };
})();

/* ---------------- 工具函数 ---------------- */
const R = 6371008.8, rad = Math.PI / 180;
function dist(la1, lo1, la2, lo2) {
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const fmtKm = m => m >= 100000 ? (m / 1000).toFixed(0) : (m / 1000).toFixed(1);
function fmtDur(s) {
  if (!(s > 0)) return '—';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}<i>时</i>${m}<i>分</i>` : `${m}<i>分</i>`;
}
const plain = html => html.replace(/<[^>]+>/g, '');
const pad = n => String(n).padStart(2, '0');
const fmtDate = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtTime = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const WEEK = '日一二三四五六';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let toastT;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); if (ms) toastT = setTimeout(() => t.classList.remove('on'), ms);
}

/* ---------------- 坐标系：WGS-84 <-> GCJ-02 ---------------- */
const GCJ = (() => {
  const a = 6378245.0, ee = 0.00669342162296594323;
  const out = (lat, lon) => lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
  function tLat(x, y) { let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)); r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3; r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3; r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3; return r; }
  function tLon(x, y) { let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)); r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3; r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3; r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3; return r; }
  function delta(lat, lon) {
    let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35);
    const radLat = lat / 180 * Math.PI; let m = Math.sin(radLat); m = 1 - ee * m * m; const sm = Math.sqrt(m);
    dLat = (dLat * 180) / ((a * (1 - ee)) / (m * sm) * Math.PI); dLon = (dLon * 180) / (a / sm * Math.cos(radLat) * Math.PI);
    return [dLat, dLon];
  }
  return {
    toGcj(lat, lon) { if (out(lat, lon)) return [lat, lon]; const d = delta(lat, lon); return [lat + d[0], lon + d[1]]; },
    toWgs(lat, lon) { if (out(lat, lon)) return [lat, lon]; let la = lat, lo = lon; for (let i = 0; i < 3; i++) { const g = this.toGcj(la, lo); la += lat - g[0]; lo += lon - g[1]; } return [la, lo]; },
  };
})();

/* ---------------- GPX 解析 ---------------- */
// 也接受被系统改名成「xxx.gpx (1)」的文件
const GPX_RE = /\.gpx(\s*\(\d+\))?$/i;
function parseGPX(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('不是有效的 GPX');
  const lat = [], lon = [], ele = [], t = [], segs = [];
  let hasEle = false, hasT = false;
  const take = list => {
    let first = true;
    for (const p of list) {
      const la = parseFloat(p.getAttribute('lat')), lo = parseFloat(p.getAttribute('lon'));
      if (!isFinite(la) || !isFinite(lo)) continue;
      if (first) { segs.push(lat.length); first = false; }
      lat.push(la); lon.push(lo);
      const e = p.getElementsByTagNameNS('*', 'ele')[0], tm = p.getElementsByTagNameNS('*', 'time')[0];
      const ev = e ? parseFloat(e.textContent) : NaN, tv = tm ? Date.parse(tm.textContent.trim()) : NaN;
      ele.push(ev); t.push(tv); if (isFinite(ev)) hasEle = true; if (isFinite(tv)) hasT = true;
    }
  };
  const trksegs = doc.getElementsByTagNameNS('*', 'trkseg');
  if (trksegs.length) for (const s of trksegs) take(s.getElementsByTagNameNS('*', 'trkpt'));
  else { const rtes = doc.getElementsByTagNameNS('*', 'rte'); for (const r of rtes) take(r.getElementsByTagNameNS('*', 'rtept')); }
  if (lat.length < 2) throw new Error('没有轨迹点');
  const trk = doc.getElementsByTagNameNS('*', 'trk')[0] || doc.getElementsByTagNameNS('*', 'rte')[0];
  let name = '';
  if (trk) for (const c of trk.children) if (c.localName === 'name') { name = c.textContent.trim(); break; }
  if (!name) { const m = doc.getElementsByTagNameNS('*', 'metadata')[0]; const n = m && [...m.children].find(c => c.localName === 'name'); if (n) name = n.textContent.trim(); }
  if (!name) { // 两步路：<gpx><extensions><name><![CDATA[...]]></name>
    const ext = [...doc.documentElement.children].find(c => c.localName === 'extensions');
    const n = ext && [...ext.children].find(c => c.localName === 'name'); if (n) name = n.textContent.trim();
  }
  if (!name) name = fileName.replace(GPX_RE, '');
  return {
    name, lat: Float64Array.from(lat), lon: Float64Array.from(lon),
    ele: hasEle ? Float32Array.from(ele) : null, t: hasT ? Float64Array.from(t) : null, segs,
  };
}

/* 计算统计 + 速度序列（只在内存中，不存库） */
function analyse(tr) {
  const n = tr.lat.length, cum = new Float64Array(n), segStart = new Set(tr.segs);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + (segStart.has(i) ? 0 : dist(tr.lat[i - 1], tr.lon[i - 1], tr.lat[i], tr.lon[i]));
  tr.cum = cum;
  tr.dist = cum[n - 1];
  let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
  for (let i = 0; i < n; i++) { const a = tr.lat[i], o = tr.lon[i]; if (a < minLa) minLa = a; if (a > maxLa) maxLa = a; if (o < minLo) minLo = o; if (o > maxLo) maxLo = o; }
  tr.bbox = [minLa, minLo, maxLa, maxLo];
  // 时间
  const T = tr.t;
  if (T) {
    let s = NaN, e = NaN; for (let i = 0; i < n; i++) if (isFinite(T[i])) { s = T[i]; break; }
    for (let i = n - 1; i >= 0; i--) if (isFinite(T[i])) { e = T[i]; break; }
    tr.start = s; tr.end = e; tr.dur = (e - s) / 1000;
    // 平滑速度：前后各约 3 秒窗口
    const spd = new Float32Array(n); let j = 0, k = 0;
    for (let i = 0; i < n; i++) {
      while (j < i && T[i] - T[j] > 3000) j++;
      if (k < i) k = i;
      while (k < n - 1 && T[k] - T[i] < 3000) k++;
      const dt = (T[k] - T[j]) / 1000;
      spd[i] = dt > 0 && isFinite(dt) ? (cum[k] - cum[j]) / dt * 3.6 : (i ? spd[i - 1] : 0);
    }
    tr.spd = spd;
    let moving = 0, max = 0;
    for (let i = 1; i < n; i++) {
      const dt = (T[i] - T[i - 1]) / 1000; if (!(dt > 0) || segStart.has(i)) continue;
      const v = (cum[i] - cum[i - 1]) / dt * 3.6;
      if (v > 3 && dt < 600) moving += dt;
    }
    // 最高速：取平滑速度的 99.5 分位，剔除 GPS 漂移尖刺
    const sorted = Float32Array.from(spd).sort(); max = sorted[Math.floor((n - 1) * 0.995)] || 0;
    tr.moving = moving; tr.vmax = max;
  } else { tr.start = tr.fileTime || NaN; tr.dur = 0; tr.moving = 0; tr.vmax = 0; tr.spd = null; }
  // 爬升（3 米滞回）
  let gain = 0;
  if (tr.ele) { let ref = NaN; for (let i = 0; i < n; i++) { const e = tr.ele[i]; if (!isFinite(e)) continue; if (!isFinite(ref)) ref = e; else if (e - ref > 3) { gain += e - ref; ref = e; } else if (ref - e > 3) ref = e; } }
  tr.gain = gain;
  if (!isFinite(tr.start)) tr.start = tr.fileTime || Date.now();
  // 精简点：全部/多条模式下用，间隔 ≥ 12 米
  const lite = [0]; let last = 0;
  for (let i = 1; i < n; i++) { if (segStart.has(i) || cum[i] - cum[last] >= 12 || i === n - 1) { lite.push(i); last = i; } }
  tr.lite = lite;
  return tr;
}

/* ---------------- 轨迹库 ---------------- */
let TRACKS = [];            // 按开始时间倒序
const byId = new Map();
// 按几何形状去重：同一条轨迹从不同 App 导出、或重复导出，只保留一份
const sigOf = tr => { const n = tr.lat.length - 1; return `${n + 1}|${tr.lat[0].toFixed(5)},${tr.lon[0].toFixed(5)}|${tr.lat[n].toFixed(5)},${tr.lon[n].toFixed(5)}`; };
let deletedSigs = new Set();

function sortTracks() { TRACKS.sort((a, b) => b.start - a.start); }

async function loadLibrary() {
  const rows = await DB.all();
  deletedSigs = new Set((await DB.get('deleted')) || []);
  TRACKS = rows.map(analyse);
  TRACKS.forEach(t => byId.set(t.id, t));
  sortTracks();
}

/** 导入一组 File 对象（来自文件夹、文件选择、分享或双击打开） */
async function importFiles(files, { quiet = false } = {}) {
  files = [...files].filter(f => GPX_RE.test(f.name) || /gpx/.test(f.type));
  if (!files.length) { if (!quiet) toast('没有找到 .gpx 文件'); return 0; }
  const known = new Set(TRACKS.map(t => t.fileKey)), sigs = new Set(TRACKS.map(t => t.sig));
  const fresh = []; let bad = 0, i = 0;
  // 记住扫描过的文件（包括空轨迹、重复轨迹），下次同步直接跳过
  const seen = new Set((await DB.get('seen')) || []);
  files = files.filter(f => !seen.has(`${f.relPath || f.webkitRelativePath || f.name}|${f.size}|${f.lastModified}`));
  for (const f of files) {
    i++;
    const path = f.relPath || f.webkitRelativePath || f.name;
    const fileKey = `${path}|${f.size}|${f.lastModified}`;
    if (known.has(fileKey)) continue;
    if (files.length > 5) toast(`正在读取 ${i}/${files.length}…`, 0);
    seen.add(fileKey);
    try {
      const p = parseGPX(await f.text(), f.name);
      const rec = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), file: path, fileKey, fileTime: f.lastModified, addedAt: Date.now(), ...p };
      rec.sig = sigOf(rec);
      if (sigs.has(rec.sig) || deletedSigs.has(rec.sig)) continue;
      sigs.add(rec.sig); known.add(fileKey); fresh.push(rec);
    } catch (e) { if (e.message !== '没有轨迹点') bad++; console.warn(f.name, e.message); }
  }
  DB.set('seen', [...seen]).catch(() => {});
  if (fresh.length) {
    await DB.putMany(fresh);
    for (const r of fresh) { analyse(r); TRACKS.push(r); byId.set(r.id, r); }
    sortTracks();
  }
  const msg = fresh.length ? `新增 ${fresh.length} 条轨迹` : '没有新的轨迹';
  if (!quiet || fresh.length) toast(msg + (bad ? `，${bad} 个文件无法解析` : ''));
  return fresh.length;
}

/* ---------------- 文件夹访问 ----------------
 * 电脑 Chrome/Edge：showDirectoryPicker，记住文件夹，以后一键同步（已授权时打开即自动同步）
 * 手机：<input webkitdirectory> 或多选文件；导入后的轨迹存在本机，不需要每次重新选 */
const canDirHandle = 'showDirectoryPicker' in window;
let dirHandle = null;

async function walk(dir, prefix, out) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') { if (!name.startsWith('.')) await walk(h, prefix + name + '/', out); }
    else if (GPX_RE.test(name)) { const f = await h.getFile(); f.relPath = prefix + name; out.push(f); }
  }
  return out;
}
async function syncDir(interactive) {
  if (!dirHandle) return;
  let perm = await dirHandle.queryPermission({ mode: 'read' });
  if (perm !== 'granted' && interactive) perm = await dirHandle.requestPermission({ mode: 'read' });
  if (perm !== 'granted') { updateSyncBtn(true); return; }
  toast('正在扫描文件夹…', 0);
  const files = await walk(dirHandle, dirHandle.name + '/', []);
  const n = await importFiles(files, { quiet: !interactive });
  if (!interactive && !n) $('#toast').classList.remove('on');
  updateSyncBtn(false);
  if (n) { if (S.mode === 'latest') fitNext = true; refresh(); if (S.mode === 'latest') showCard(TRACKS[0]); }
}
async function pickDir() {
  if (canDirHandle) {
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'gpx', mode: 'read' });
      await DB.set('dir', dirHandle);
      await syncDir(true);
    } catch (e) { if (e.name !== 'AbortError') toast('无法打开文件夹：' + e.message); }
  } else $('#inDir').click();
}
function updateSyncBtn(needAuth) {
  const b = $('#btnSync');
  b.hidden = !dirHandle;
  $('#dirLabel').textContent = dirHandle ? '换' : '选择文件夹';
  if (dirHandle) $('#syncName').textContent = (needAuth ? '授权同步 · ' : '同步 · ') + dirHandle.name;
}

/* ---------------- 地图 ---------------- */
const map = L.map('map', { zoomControl: false, maxZoom: MAX_ZOOM, minZoom: 2, worldCopyJump: true, zoomSnap: 0.5, wheelPxPerZoomLevel: 90, attributionControl: true });
map.attributionControl.setPrefix(false);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
const renderer = L.canvas({ padding: 0.5, tolerance: 8 });
const trackLayer = L.layerGroup().addTo(map);
const overLayer = L.layerGroup().addTo(map);

const QuadLayer = L.TileLayer.extend({
  getTileUrl(c) {
    const z = this._getZoomForUrl();
    let q = ''; for (let i = z; i > 0; i--) { let d = 0; const m = 1 << (i - 1); if (c.x & m) d++; if (c.y & m) d += 2; q += d; }
    return L.Util.template(this._url, L.extend({ s: this._getSubdomain(c), x: c.x, y: c.y, z, q, '-y': (1 << z) - 1 - c.y }, this.options));
  },
});
let baseLayer = null, curSrc = null;
const allSources = () => [...BUILTIN_SOURCES, ...S.custom];
function setSource(id) {
  const src = allSources().find(s => s.id === id) || BUILTIN_SOURCES[0];
  const crsChanged = curSrc && curSrc.crs !== src.crs;
  curSrc = src; S.src = src.id; saveS();
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = new QuadLayer(src.url, {
    subdomains: src.sub || 'abc', maxNativeZoom: +src.maxNative || 19, maxZoom: MAX_ZOOM,
    attribution: src.attr || src.name, crossOrigin: false, keepBuffer: 3, updateWhenZooming: false,
  }).addTo(map);
  if (crsChanged) { projCache.clear(); refresh(); }
  renderSources();
}

/* 轨迹坐标 → 当前底图坐标 */
const projCache = new Map();
function project(tr) {
  const key = tr.id;
  if (projCache.has(key)) return projCache.get(key);
  const n = tr.lat.length, out = new Array(n);
  const conv = S.crs === curSrc.crs ? null : (S.crs === 'wgs' ? GCJ.toGcj.bind(GCJ) : GCJ.toWgs.bind(GCJ));
  for (let i = 0; i < n; i++) out[i] = conv ? L.latLng(conv(tr.lat[i], tr.lon[i])) : L.latLng(tr.lat[i], tr.lon[i]);
  projCache.set(key, out);
  return out;
}

/* 速度色带：蓝(慢) → 青 → 绿 → 黄 → 橙 → 红(快)；上限随轨迹自适应（市区 40、高速 140…） */
const SPEED_STOPS = [[0, [64, 120, 255]], [.2, [25, 211, 230]], [.42, [61, 220, 74]], [.64, [255, 210, 31]], [.84, [255, 122, 26]], [1, [255, 45, 85]]];
const speedScale = tr => Math.min(160, Math.max(40, Math.ceil((tr.vmax || 0) / 20) * 20));
function speedColor(v, max = 140) {
  const f0 = Math.max(0, Math.min(1, (v || 0) / max));
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [v1, c1] = SPEED_STOPS[i];
    if (f0 <= v1) { const [v0, c0] = SPEED_STOPS[i - 1], f = (f0 - v0) / (v1 - v0); return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * f)).join(',')})`; }
  }
  return 'rgb(255,45,85)';
}
const PALETTE = ['#ffb020', '#36cfc9', '#ff5a5f', '#9b7bff', '#7ee04d', '#4da3ff', '#ff85c0', '#f5e663'];

/* ---------------- 视图状态 ---------------- */
let focusId = null, fitNext = true;
function yearOk(t) { return !S.year || new Date(t.start).getFullYear() === +S.year; }
function visibleTracks() {
  if (!TRACKS.length) return [];
  if (S.mode === 'latest') return [TRACKS[0]];
  if (S.mode === 'pick') return TRACKS.filter(t => S.picked.has(t.id));
  return TRACKS.filter(yearOk);
}

function drawTracks() {
  stopPlay();
  trackLayer.clearLayers(); overLayer.clearLayers();
  const vis = visibleTracks();
  if (focusId && !vis.some(t => t.id === focusId)) focusId = null;
  if (vis.length === 1) focusId = vis[0].id;
  const W = +S.width;
  const single = vis.length === 1;
  vis.forEach((tr, idx) => {
    const ll = project(tr);
    const isFocus = tr.id === focusId;
    const color = S.mode === 'all' ? '#ffb020' : PALETTE[TRACKS.indexOf(tr) % PALETTE.length];
    const segRanges = tr.segs.map((s, i) => [s, (tr.segs[i + 1] ?? ll.length) - 1]);
    const pts = (a, b, lite) => { const r = []; if (lite) { for (const i of tr.lite) if (i >= a && i <= b) r.push(ll[i]); } else for (let i = a; i <= b; i++) r.push(ll[i]); return r; };
    const lite = !single && !isFocus;
    const lines = segRanges.map(([a, b]) => pts(a, b, lite)).filter(x => x.length > 1);
    // 暗色描边让线在卫星图上更清楚
    L.polyline(lines, { renderer, color: '#000', opacity: isFocus || single ? .55 : .35, weight: (isFocus ? W + 1 : W) + 3, interactive: false }).addTo(trackLayer);
    if ((single || isFocus) && S.color === 'speed' && tr.spd) {
      // 速度渐变：相邻同色点合并为一段
      const mx = speedScale(tr), bucket = v => Math.min(24, Math.round((v || 0) / mx * 24));
      for (const [a, b] of segRanges) {
        let s = a;
        for (let i = a + 1; i <= b; i++) {
          if (i === b || bucket(tr.spd[i]) !== bucket(tr.spd[s])) {
            L.polyline(ll.slice(s, i + 1), { renderer, color: speedColor(bucket(tr.spd[s]) / 24 * mx, mx), weight: W, opacity: 1, interactive: false }).addTo(trackLayer);
            s = i;
          }
        }
      }
    } else {
      L.polyline(lines, { renderer, color: isFocus && !single ? '#fff' : color, weight: isFocus ? W + 1 : W, opacity: S.mode === 'all' && !isFocus ? .85 : 1, interactive: false }).addTo(trackLayer);
    }
    if (!single) {
      // 透明的粗线用来点选
      L.polyline(lines, { renderer, color: '#000', opacity: 0, weight: Math.max(16, W * 3) })
        .on('click', e => { L.DomEvent.stop(e); focusId = tr.id; drawTracks(); showCard(tr); })
        .addTo(trackLayer);
    }
    if ((single || isFocus) && S.ends) {
      overLayer.addLayer(L.marker(ll[0], { icon: L.divIcon({ className: '', html: '<div class="endpt s"></div>', iconSize: [16, 16] }), interactive: false }));
      overLayer.addLayer(L.marker(ll[ll.length - 1], { icon: L.divIcon({ className: '', html: '<div class="endpt e"></div>', iconSize: [16, 16] }), interactive: false }));
    }
  });
  // 推迟一帧再适配视野：等详情卡/面板打开后，按剩余可见区域来缩放
  if (fitNext) { fitNext = false; requestAnimationFrame(() => fitView(false)); }
}

function boundsOf(list) {
  let b = null;
  for (const t of list) { const ll = project(t); const bb = L.latLngBounds(ll[0], ll[0]); for (const i of t.lite) bb.extend(ll[i]); b = b ? b.extend(bb) : bb; }
  return b;
}
function fitView(animate = true) {
  const vis = focusId && S.mode !== 'all' ? [byId.get(focusId)] : visibleTracks();
  const b = boundsOf(vis.filter(Boolean));
  if (!b) return;
  const wide = innerWidth >= 820, panel = document.body.classList.contains('panel-open');
  const cardH = document.body.classList.contains('card-open') ? $('#card').offsetHeight : 0;
  const tl = [24 + (wide && panel ? 380 : 0), 70];
  const br = [60, 30 + (cardH && !(panel && !wide) ? cardH + 10 : 0) + (panel && !wide ? innerHeight * .6 : 0)];
  map.fitBounds(b, { paddingTopLeft: tl, paddingBottomRight: br, maxZoom: 18, animate });
}

/* ---------------- 顶部信息条 ---------------- */
function renderChip() {
  const vis = visibleTracks(), chip = $('#chip');
  chip.hidden = !TRACKS.length;
  if (!TRACKS.length) return;
  if (vis.length === 1 || (focusId && byId.get(focusId))) {
    const t = vis.length === 1 ? vis[0] : byId.get(focusId), d = new Date(t.start);
    $('#chipTitle').textContent = t.name;
    $('#chipSub').textContent = `${fmtDate(t.start)} 周${WEEK[d.getDay()]} · ${fmtKm(t.dist)} km` + (t.dur ? ' · ' + plain(fmtDur(t.dur)) : '') + (S.mode === 'latest' ? ' · 最近一条' : '');
  } else {
    const km = vis.reduce((s, t) => s + t.dist, 0);
    $('#chipTitle').textContent = S.mode === 'all' ? (S.year ? `${S.year} 年的足迹` : '全部足迹') : `已选 ${vis.length} 条`;
    $('#chipSub').textContent = vis.length ? `${vis.length} 条 · ${fmtKm(km)} km · 点轨迹查看详情` : '在轨迹库里勾选要看的轨迹';
  }
}

/* ---------------- 详情卡 + 剖面图 ---------------- */
let cardTrack = null;
function showCard(tr) {
  cardTrack = tr;
  const d = new Date(tr.start);
  $('#cTitle').textContent = tr.name;
  $('#cDate').textContent = `${fmtDate(tr.start)} 周${WEEK[d.getDay()]} ` + (tr.t ? `${fmtTime(tr.start)} – ${fmtTime(tr.end)}` : '') + `  ·  ${tr.file.split('/').pop()}`;
  const avg = tr.moving ? tr.dist / tr.moving * 3.6 : 0;
  const stat = (v, u, l) => `<div class="stat"><b>${v}<i>${u}</i></b><small>${l}</small></div>`;
  $('#cStats').innerHTML = stat(fmtKm(tr.dist), 'km', '里程') + `<div class="stat"><b>${fmtDur(tr.dur)}</b><small>总用时</small></div>`
    + stat(avg ? avg.toFixed(0) : '—', avg ? 'km/h' : '', '行驶均速') + stat(tr.vmax ? tr.vmax.toFixed(0) : '—', tr.vmax ? 'km/h' : '', '最高速');
  const grad = SPEED_STOPS.map(([v, c]) => `rgb(${c}) ${v * 100}%`).join(',');
  $('#legend').innerHTML = (S.color === 'speed' && tr.spd) ? `0<span class="bar" style="background:linear-gradient(90deg,${grad})"></span>${speedScale(tr)} km/h` : (tr.ele ? `累计爬升 ${tr.gain.toFixed(0)} m` : '');
  $('#btnPlay').hidden = !tr.t;
  $('#card').hidden = false;
  document.body.classList.add('card-open');
  requestAnimationFrame(() => { document.body.style.setProperty('--card-h', $('#card').offsetHeight + 'px'); drawProfile(); });
}
function hideCard() { $('#card').hidden = true; document.body.classList.remove('card-open'); stopPlay(); cardTrack = null; }

function drawProfile(cursorIdx = -1) {
  const tr = cardTrack, cv = $('#prof'); if (!tr) return;
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const n = tr.lat.length, D = tr.dist || 1, step = Math.max(1, Math.floor(n / (w * 1.5)));
  const X = i => tr.cum[i] / D * w;
  // 速度面积
  if (tr.spd) {
    let vmax = Math.max(60, tr.vmax * 1.1);
    const Y = v => h - 4 - Math.min(v, vmax) / vmax * (h - 10);
    const lg = g.createLinearGradient(0, 0, w, 0);
    const mx = speedScale(tr);
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 40))) lg.addColorStop(Math.min(1, tr.cum[i] / D), speedColor(tr.spd[i], mx));
    g.beginPath(); g.moveTo(0, h);
    for (let i = 0; i < n; i += step) g.lineTo(X(i), Y(tr.spd[i]));
    g.lineTo(w, h); g.closePath();
    g.globalAlpha = .28; g.fillStyle = lg; g.fill(); g.globalAlpha = 1;
    g.beginPath(); for (let i = 0; i < n; i += step) i ? g.lineTo(X(i), Y(tr.spd[i])) : g.moveTo(X(i), Y(tr.spd[i]));
    g.strokeStyle = lg; g.lineWidth = 1.6; g.stroke();
  }
  // 海拔线
  if (tr.ele) {
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < n; i++) { const e = tr.ele[i]; if (isFinite(e)) { if (e < lo) lo = e; if (e > hi) hi = e; } }
    if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
    const Y = e => h - 4 - (e - lo) / (hi - lo) * (h - 10);
    g.beginPath(); let started = false;
    for (let i = 0; i < n; i += step) { const e = tr.ele[i]; if (!isFinite(e)) continue; started ? g.lineTo(X(i), Y(e)) : g.moveTo(X(i), Y(e)); started = true; }
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.2; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
  }
  if (!tr.spd && !tr.ele) { g.fillStyle = '#9aa4b2'; g.font = '12px system-ui'; g.fillText('这条轨迹没有时间和海拔数据', 8, h / 2); }
  if (cursorIdx >= 0) { const x = X(cursorIdx); g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
}

let cursorMarker = null;
function showCursor(i) {
  const tr = cardTrack; if (!tr) return;
  const ll = project(tr)[i];
  if (!cursorMarker) cursorMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="cursor"></div>', iconSize: [16, 16] }), interactive: false, zIndexOffset: 1000 });
  cursorMarker.setLatLng(ll); if (!map.hasLayer(cursorMarker)) cursorMarker.addTo(map);
  const parts = [`${(tr.cum[i] / 1000).toFixed(1)} km`];
  if (tr.spd) parts.push(`${tr.spd[i].toFixed(0)} km/h`);
  if (tr.ele && isFinite(tr.ele[i])) parts.push(`${tr.ele[i].toFixed(0)} m`);
  if (tr.t && isFinite(tr.t[i])) parts.push(fmtTime(tr.t[i]));
  $('#profRead').textContent = parts.join(' · '); $('#profRead').classList.add('on');
  drawProfile(i);
}
function hideCursor() { if (cursorMarker) cursorMarker.remove(); $('#profRead').classList.remove('on'); drawProfile(); }
function idxAtX(x) {
  const tr = cardTrack, w = $('#prof').clientWidth, target = Math.max(0, Math.min(1, x / w)) * tr.dist;
  let lo = 0, hi = tr.cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; tr.cum[m] < target ? lo = m + 1 : hi = m; } return lo;
}
{
  const cv = $('#prof');
  const mv = e => { if (!cardTrack || playing) return; const r = cv.getBoundingClientRect(); showCursor(idxAtX(e.clientX - r.left)); };
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); mv(e); });
  cv.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons) mv(e); });
  cv.addEventListener('pointerleave', () => { if (!playing) hideCursor(); });
  cv.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse' && !playing) setTimeout(hideCursor, 1200); });
}

/* ---------------- 回放 ---------------- */
let playing = null;
function startPlay() {
  const tr = cardTrack; if (!tr || !tr.t) return;
  stopPlay();
  const ll = project(tr), n = ll.length, T = tr.t;
  const realDur = tr.end - tr.start, playMs = Math.min(40000, Math.max(10000, tr.dist / 3)); // 约每 3 km 1 秒，10–40 秒
  const trail = L.polyline([ll[0]], { renderer, color: '#fff', weight: +S.width + 1, opacity: .95, interactive: false }).addTo(overLayer);
  if (map.getZoom() < 13) map.setView(ll[0], 14, { animate: false });
  const t0 = performance.now(); let idx = 0;
  playing = { trail, raf: 0 };
  $('#btnPlay span').textContent = '停止';
  const tick = now => {
    const f = Math.min(1, (now - t0) / playMs), tgt = tr.start + realDur * f;
    while (idx < n - 1 && !(T[idx + 1] > tgt) ) { idx++; trail.addLatLng(ll[idx]); }
    showCursor(idx);
    const p = map.latLngToContainerPoint(ll[idx]), sz = map.getSize();
    if (p.x < sz.x * .2 || p.x > sz.x * .8 || p.y < sz.y * .15 || p.y > sz.y * .6) map.panTo(ll[idx], { animate: true, duration: .4 });
    if (f < 1) playing.raf = requestAnimationFrame(tick); else { playing.raf = 0; setTimeout(stopPlay, 1500); }
  };
  playing.raf = requestAnimationFrame(tick);
}
function stopPlay() {
  if (!playing) return;
  cancelAnimationFrame(playing.raf); overLayer.removeLayer(playing.trail); playing = null;
  $('#btnPlay span').textContent = '回放'; hideCursor();
}

/* ---------------- 轨迹库面板 ---------------- */
function renderPanel() {
  const total = TRACKS.reduce((s, t) => s + t.dist, 0), hours = TRACKS.reduce((s, t) => s + (t.moving || t.dur || 0), 0) / 3600;
  const days = new Set(TRACKS.map(t => fmtDate(t.start))).size;
  $('#sumLine').textContent = TRACKS.length ? `${TRACKS.length} 条轨迹 · 最早 ${fmtDate(TRACKS[TRACKS.length - 1].start)}` : '还没有轨迹';
  $('#achv').innerHTML = TRACKS.length ? `<div class="stat"><b>${Math.round(total / 1000).toLocaleString()}<i>km</i></b><small>累计里程</small></div><div class="stat"><b>${hours.toFixed(0)}<i>小时</i></b><small>在路上</small></div><div class="stat"><b>${days}<i>天</i></b><small>出行天数</small></div>` : '';
  document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
  $('#pickN').textContent = S.picked.size;
  // 年份
  const years = [...new Set(TRACKS.map(t => new Date(t.start).getFullYear()))].sort((a, b) => b - a);
  $('#yearSel').innerHTML = `<option value="">全部年份</option>` + years.map(y => `<option ${+S.year === y ? 'selected' : ''}>${y}</option>`).join('');
  renderList();
}
function renderList() {
  const q = $('#q').value.trim().toLowerCase();
  const rows = TRACKS.filter(t => yearOk(t) && (!q || t.name.toLowerCase().includes(q) || t.file.toLowerCase().includes(q)));
  if (!rows.length) { $('#list').innerHTML = `<div class="none">${TRACKS.length ? '没有匹配的轨迹' : '导入 GPX 后会出现在这里'}</div>`; return; }
  let html = '', curM = '';
  const monthKm = {};
  for (const t of rows) { const d = new Date(t.start), m = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`; monthKm[m] = (monthKm[m] || 0) + t.dist; }
  for (const t of rows) {
    const d = new Date(t.start), m = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    if (m !== curM) { curM = m; html += `<div class="month"><span>${m}</span><span>${fmtKm(monthKm[m])} km</span></div>`; }
    const picked = S.picked.has(t.id), on = visibleTracks().length === 1 ? visibleTracks()[0].id === t.id : focusId === t.id;
    const c = PALETTE[TRACKS.indexOf(t) % PALETTE.length];
    html += `<div class="item ${picked ? 'picked' : ''} ${on ? 'on' : ''}" data-id="${t.id}" style="--c:${c}">
      <button class="ck" data-act="pick" title="勾选"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></button>
      <div class="body" data-act="show"><b>${esc(t.name)}</b><small>${d.getDate()} 日 周${WEEK[d.getDay()]}${t.t ? ' ' + fmtTime(t.start) : ''} · ${plain(fmtDur(t.dur))}</small></div>
      <div class="km" data-act="show">${fmtKm(t.dist)}<i> km</i></div>
      <button class="del" data-act="del" title="从轨迹库移除"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
    </div>`;
  }
  $('#list').innerHTML = html;
}
$('#list').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act, item = e.target.closest('.item'); if (!act || !item) return;
  const id = item.dataset.id, tr = byId.get(id);
  if (act === 'pick') {
    S.picked.has(id) ? S.picked.delete(id) : S.picked.add(id);
    S.mode = 'pick'; fitNext = true;
  } else if (act === 'show') {
    if (S.mode === 'pick' && S.picked.size > 1 && S.picked.has(id)) { focusId = id; }
    else { S.picked = new Set([id]); S.mode = 'pick'; fitNext = true; }
    if (innerWidth < 820) closePanel();
    showCard(tr);
  } else if (act === 'del') {
    if (!confirm(`从轨迹库移除「${tr.name}」？\n（不会删除手机/电脑里的 GPX 文件，之后同步也不会再导入它）`)) return;
    await DB.del(id); deletedSigs.add(tr.sig); await DB.set('deleted', [...deletedSigs]);
    TRACKS = TRACKS.filter(t => t !== tr); byId.delete(id); S.picked.delete(id); projCache.delete(id);
    if (cardTrack === tr) hideCard();
  }
  saveS(); refresh();
});
function openPanel() { document.body.classList.add('panel-open'); if (innerWidth < 820) hideCard(); }
function closePanel() { document.body.classList.remove('panel-open'); }

/* ---------------- 图源弹层 ---------------- */
function renderSources() {
  $('#srcList').innerHTML = allSources().map(s => `<button class="src ${s.id === S.src ? 'on' : ''}" data-id="${s.id}"><i class="rd"></i><span>${esc(s.name)}</span><small>${s.crs === 'gcj' ? 'GCJ · ' : ''}z${s.maxNative}</small>${s.custom ? '<b class="x" data-x="1" title="删除">×</b>' : ''}</button>`).join('');
}
$('#srcList').addEventListener('click', e => {
  const b = e.target.closest('.src'); if (!b) return;
  if (e.target.dataset.x) { S.custom = S.custom.filter(s => s.id !== b.dataset.id); if (S.src === b.dataset.id) S.src = 'g-sat'; saveS(); setSource(S.src); return; }
  setSource(b.dataset.id);
});
$('#nsAdd').onclick = () => {
  const url = $('#nsUrl').value.trim(), name = $('#nsName').value.trim() || '自定义图源';
  if (!/^https?:\/\/.+\{z\}/.test(url) && !/\{q\}/.test(url)) return toast('URL 需要包含 {z}/{x}/{y} 或 {q}');
  const sub = (url.match(/\{s\}/) ? '0123' : '');
  const s = { id: 'c' + Date.now(), name, url, sub: sub || 'abc', maxNative: Math.min(22, Math.max(1, +$('#nsMax').value || 19)), crs: $('#nsCrs').value, attr: name, custom: true };
  S.custom.push(s); saveS(); setSource(s.id);
  $('#nsUrl').value = $('#nsName').value = ''; toast('已添加：' + name);
};

/* ---------------- 统一刷新 ---------------- */
function refresh() {
  $('#empty').hidden = TRACKS.length > 0;
  drawTracks(); renderChip(); renderPanel();
  if (cardTrack && !byId.has(cardTrack.id)) hideCard();
  // 当前只看一条时，详情卡随之切换
  const vis = visibleTracks();
  if (cardTrack && vis.length === 1 && cardTrack !== vis[0]) showCard(vis[0]);
}

/* ---------------- 事件绑定 ---------------- */
$('#btnLib').onclick = () => document.body.classList.contains('panel-open') ? closePanel() : openPanel();
$('#pClose').onclick = closePanel;
$('#btnLayers').onclick = e => { e.stopPropagation(); $('#layersPop').hidden = !$('#layersPop').hidden; };
$('#btnFit').onclick = () => fitView(true);
$('#chip').onclick = () => {
  const vis = visibleTracks(), t = vis.length === 1 ? vis[0] : byId.get(focusId);
  if (t) { $('#card').hidden || cardTrack !== t ? showCard(t) : hideCard(); } else openPanel();
};
$('#cClose').onclick = hideCard;
$('#btnPlay').onclick = () => playing ? stopPlay() : startPlay();
$('#btnDir').onclick = $('#eDir').onclick = pickDir;
$('#btnFiles').onclick = $('#eFiles').onclick = () => $('#inFiles').click();
$('#btnSync').onclick = () => syncDir(true);
for (const id of ['#inFiles', '#inDir']) $(id).onchange = async e => {
  const n = await importFiles(e.target.files); e.target.value = '';
  if (n) { if (S.mode !== 'all') { S.mode = 'latest'; } fitNext = true; saveS(); refresh(); if (S.mode === 'latest') showCard(TRACKS[0]); }
};
document.querySelectorAll('#seg button').forEach(b => b.onclick = () => {
  S.mode = b.dataset.m; fitNext = true; focusId = null; saveS();
  if (S.mode === 'pick' && !S.picked.size) toast('在下面的列表里勾选轨迹');
  refresh();
  if (visibleTracks().length === 1) showCard(visibleTracks()[0]); else hideCard();
});
$('#yearSel').onchange = e => { S.year = e.target.value; saveS(); if (S.mode === 'all') fitNext = true; refresh(); };
$('#q').oninput = renderList;
$('#setCrs').value = S.crs; $('#setColor').value = S.color; $('#setWidth').value = S.width; $('#setEnds').checked = S.ends;
$('#setCrs').onchange = e => { S.crs = e.target.value; projCache.clear(); saveS(); refresh(); };
$('#setColor').onchange = e => { S.color = e.target.value; saveS(); refresh(); if (cardTrack) showCard(cardTrack); };
$('#setWidth').oninput = e => { S.width = +e.target.value; saveS(); drawTracks(); };
$('#setEnds').onchange = e => { S.ends = e.target.checked; saveS(); drawTracks(); };
$('#btnWipe').onclick = async () => {
  if (!confirm('清空本机轨迹库？（不会删除原始 GPX 文件，可以再次导入）')) return;
  await DB.clear(); await DB.set('deleted', []); await DB.set('seen', []); deletedSigs = new Set();
  TRACKS = []; byId.clear(); projCache.clear(); S.picked.clear(); saveS(); hideCard(); refresh();
};

// 点地图空白处：先关闭弹层/面板，否则切换沉浸模式
map.on('click', () => {
  if (!$('#layersPop').hidden) { $('#layersPop').hidden = true; return; }
  if (document.body.classList.contains('panel-open') && innerWidth < 820) { closePanel(); return; }
  document.body.classList.toggle('immersive');
});
document.addEventListener('keydown', e => {
  if (e.target.matches('input,select')) return;
  if (e.key === 'Escape') { $('#layersPop').hidden = true; closePanel(); hideCard(); }
  if (e.key === 'h') document.body.classList.toggle('immersive');
  if (e.key === 'f') fitView(true);
});
new ResizeObserver(() => { map.invalidateSize(); if (cardTrack) drawProfile(); }).observe($('#map'));

// 手机面板：向下拖动关闭
{
  let y0 = null; const p = $('#panel');
  p.addEventListener('touchstart', e => { if (innerWidth >= 820) return; if (e.target.closest('.list') && $('#list').scrollTop > 0) return; y0 = e.touches[0].clientY; }, { passive: true });
  p.addEventListener('touchmove', e => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy > 0) p.style.transform = `translateY(${dy}px)`; }, { passive: true });
  p.addEventListener('touchend', e => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; p.style.transform = ''; y0 = null; if (dy > 90) closePanel(); });
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  setSource(S.src);
  map.setView([22.30, 39.10], 10);
  try { await loadLibrary(); } catch (e) { console.error(e); toast('读取本机轨迹库失败'); }
  for (const id of [...S.picked]) if (!byId.has(id)) S.picked.delete(id);
  if (S.mode === 'pick' && !S.picked.size) S.mode = 'latest';
  fitNext = true;
  refresh();
  if (visibleTracks().length === 1) showCard(visibleTracks()[0]);

  // 记住的文件夹（电脑 Chrome/Edge）：已授权就自动同步
  if (canDirHandle) {
    try { dirHandle = await DB.get('dir'); } catch {}
    if (dirHandle) { updateSyncBtn(true); syncDir(false).catch(() => {}); }
  }
  // 从「分享到」或系统「打开方式」进来的文件
  if (new URLSearchParams(location.search).has('share') && 'caches' in window) {
    const c = await caches.open('share-inbox'), keys = await c.keys(), files = [];
    for (const k of keys) { const r = await c.match(k); const b = await r.blob(); files.push(new File([b], decodeURIComponent(r.headers.get('x-name') || 'shared.gpx'), { lastModified: Date.now() })); await c.delete(k); }
    history.replaceState(null, '', location.pathname);
    if (await importFiles(files)) { S.mode = 'latest'; fitNext = true; saveS(); refresh(); showCard(TRACKS[0]); }
  }
  if ('launchQueue' in window) launchQueue.setConsumer(async p => {
    if (!p.files?.length) return;
    const files = await Promise.all(p.files.map(h => h.getFile()));
    if (await importFiles(files)) { S.mode = 'latest'; fitNext = true; saveS(); refresh(); showCard(TRACKS[0]); }
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
})();

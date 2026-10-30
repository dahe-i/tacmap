/* =========================================================
   TACMAP · 战术地图板
   无依赖，原生 Canvas 2D 实现
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const uid = p => (p || 'i') + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  const TAU = Math.PI * 2;

  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };

  /* ---------------- 状态 ---------------- */
  const S = {
    maps: [], map: null,
    view: { x: 0, y: 0, k: 0.4 },
    cw: 0, ch: 0, dpr: 1, fitted: false,
    tool: 'select', color: '#ff7a1a',
    routeColor: '#ff7a1a',
    layers: { grid: true, labels: true, markers: true, routes: true, pen: true },
    dim: 0.22,
    sel: null,
    catDefs: {},
    hidden: new Set(),
    hiddenRoutes: new Set(),
    filterMode: 'marker',
    chipGroups: [],
    mergeMode: false,
    mergeSel: new Set(),
    openGroups: new Set(),
    labelHits: [],
    draft: null,
    mouse: { x: 0, y: 0, inside: false },
    pointers: new Map(),
    pinch: null,
    drag: null,
    space: false,
    undo: [], redo: [],
    needDraw: false
  };


  /* ---------------- 存储 ---------------- */
  const K_ITEMS = id => 'tacmap.items.v1.' + id;
  const K_CUSTOM = 'tacmap.custom.v1';

  function loadItems(id) {
    const raw = lsGet(K_ITEMS(id));
    if (!raw) return null;
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch (e) { return null; }
  }
  let saveTimer = 0;
  function saveItems() {
    if (!S.map) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const ok = lsSet(K_ITEMS(S.map.id), JSON.stringify(S.map.items));
      if (!ok) toast('本机存储被拒绝，标注只保留在内存中');
    }, 250);
  }
  const K_CHIPGROUPS = id => 'tacmap.chipGroups.v1.' + id;
  function loadChipGroups(mapId) {
    try {
      const v = JSON.parse(lsGet(K_CHIPGROUPS(mapId)) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function saveChipGroups() {
    if (!S.map) return;
    lsSet(K_CHIPGROUPS(S.map.id), JSON.stringify(S.chipGroups));
  }

  function loadCustomMetas() {
    const raw = lsGet(K_CUSTOM);
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function saveCustomMetas() {
    lsSet(K_CUSTOM, JSON.stringify(S.maps.filter(m => m.isCustom).map(m => ({
      id: m.id, name: m.name, size: m.size, meters: m.meters, grid: m.grid
    }))));
  }

  /* IndexedDB：存自定义底图原图 */
  function idb() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no idb'));
      const r = indexedDB.open('tacmap', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('img'); } catch (e) {} };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function idbPut(key, val) {
    return idb().then(db => new Promise((res, rej) => {
      const tx = db.transaction('img', 'readwrite');
      tx.objectStore('img').put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    }));
  }
  function idbGet(key) {
    return idb().then(db => new Promise((res, rej) => {
      const tx = db.transaction('img', 'readonly');
      const rq = tx.objectStore('img').get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    }));
  }
  function idbDel(key) {
    return idb().then(db => new Promise(res => {
      const tx = db.transaction('img', 'readwrite');
      tx.objectStore('img').delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    })).catch(() => {});
  }

  /* ---------------- 提示 ---------------- */
  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }
  let hintTimer = 0;
  function hint(msg) {
    const el = $('#hint');
    if (!msg) { el.classList.remove('on'); return; }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.remove('on'), 3200);
  }

  /* ---------------- 坐标 / 视图 ---------------- */
  function localPoint(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function toWorld(p) {
    return { x: (p.x - S.view.x) / S.view.k, y: (p.y - S.view.y) / S.view.k };
  }
  function cellOf(p) {
    if (!S.map) return '—';
    const m = S.map, cw = m.size / m.grid.cols, ch = m.size / m.grid.rows;
    const c = clamp(Math.floor(p.x / cw), 0, m.grid.cols - 1);
    const r = clamp(Math.floor(p.y / ch), 0, m.grid.rows - 1);
    return String.fromCharCode(65 + c) + (r + 1);
  }
  function clampView() {
    if (!S.map) return;
    const v = S.view, size = S.map.size, w = size * v.k, h = size * v.k, m = 90;
    v.x = clamp(v.x, -(w - m), S.cw - m);
    v.y = clamp(v.y, -(h - m), S.ch - m);
  }
  function fitView() {
    if (!S.map) return;
    const size = S.map.size;
    const k = Math.min(S.cw / size, S.ch / size) * 0.94;
    S.view.k = clamp(k, 0.05, 8);
    S.view.x = (S.cw - size * S.view.k) / 2;
    S.view.y = (S.ch - size * S.view.k) / 2;
    S.fitted = true;
  }
  function zoomAt(screenP, k2) {
    const w = toWorld(screenP);
    S.view.k = clamp(k2, 0.06, 10);
    S.view.x = screenP.x - w.x * S.view.k;
    S.view.y = screenP.y - w.y * S.view.k;
    clampView();
    requestDraw();
  }
  function centerOn(p) {
    S.view.x = S.cw / 2 - p.x * S.view.k;
    S.view.y = S.ch / 2 - p.y * S.view.k;
    clampView();
    requestDraw();
  }

  /* ---------------- 地图装载 ---------------- */
  function migrateItems(items, cats) {
    const byId = {};
    (cats || []).forEach(c => { byId[c.id] = c; });
    const out = [];
    (items || []).forEach(it => {
      if (it.kind === 'marker' && it.children && it.children.length) {
        it.children.forEach(c => {
          out.push({
            id: c.id || ('m' + Math.random().toString(36).slice(2, 8)),
            kind: 'marker', x: c.x, y: c.y, name: c.name,
            color: c.color, alpha: c.alpha, dotless: !!c.dotless, desc: ''
          });
        });
        return;
      }
      out.push(it);
    });
    items = out;
    (items || []).forEach(it => {
      if (it.kind !== 'marker' || !it.cat) return;
      const c = byId[it.cat];
      if (!c) { delete it.cat; return; }
      if (!it.color) it.color = c.color;
      if (it.cat === 'place') it.dotless = true;   // 地名本来就是纯文字
      delete it.cat;
    });
    return items || [];
  }

  const K_SIZE = id => 'tacmap.size.v1.' + id;

  function scaleItems(items, f) {
    if (!items || f === 1) return items;
    const sc = p => { if (p && typeof p.x === 'number') { p.x *= f; p.y *= f; } };
    items.forEach(it => {
      if (it.kind === 'marker') sc(it);
      if (it.pts) it.pts.forEach(sc);
      if (it.a) sc(it.a);
      if (it.b) sc(it.b);
      if (it.labelPos) sc(it.labelPos);
    });
    return items;
  }

  function prepareMap(src, isCustom) {
    const m = Object.assign({}, src, { isCustom: !!isCustom });
    const stored = loadItems(m.id);
    const prevSize = parseInt(lsGet(K_SIZE(m.id)) || '', 10);
    if (stored && prevSize && prevSize !== m.size) {
      scaleItems(stored, m.size / prevSize);   // 底图换分辨率时按比例换算旧标注
    }
    m.items = migrateItems(stored || JSON.parse(JSON.stringify(src.items || [])), src.categories);
    lsSet(K_SIZE(m.id), String(m.size));
    m.img = null;
    m.loaded = false;
    if (m.src) loadImage(m);
    return m;
  }
  function loadImage(m) {
    const im = new Image();
    im.onload = () => {
      m.img = im;
      m.loaded = true;
      if (!m.size) m.size = im.naturalWidth;
      if (S.map === m) { if (!S.fitted) fitView(); requestDraw(); }
    };
    im.onerror = () => toast('底图加载失败：' + m.name);
    im.src = m.src;
  }

  function buildTabs() {
    const box = $('#mapTabs');
    box.innerHTML = '';
    S.maps.forEach(m => {
      const b = document.createElement('button');
      b.className = 'map-tab' + (S.map && S.map.id === m.id ? ' on' : '');
      b.innerHTML = '<span>' + esc(m.name) + '</span>';
      b.title = m.desc || m.name;
      b.addEventListener('click', () => selectMap(m.id));
      const x = document.createElement('span');
      x.className = 'x'; x.textContent = '×'; x.title = '删除这张地图';
      x.addEventListener('click', ev => { ev.stopPropagation(); removeMap(m.id); });
      b.appendChild(x);
      box.appendChild(b);
    });
  }

  function selectMap(id) {
    const m = S.maps.find(x => x.id === id);
    if (!m) return;
    if (S.map) saveItems();
    S.map = m;
    S.sel = null; S.draft = null;
    S.catDefs = {};
    (m.categories || []).forEach(c => { S.catDefs[c.id] = c; });
    S.hidden = new Set();
    S.hiddenRoutes = new Set();
    const storedGroups = loadChipGroups(m.id);
    S.chipGroups = (storedGroups && storedGroups.length)
      ? storedGroups
      : JSON.parse(JSON.stringify(m.chipGroups || []));
    S.mergeMode = false;
    S.mergeSel = new Set();
    buildTabs();
    buildChips();
    S.fitted = false;
    if (S.cw > 10) fitView();
    $('#hudName').textContent = m.name;
    $('#hudMeta').textContent = m.size + ' × ' + m.size + ' · ' + m.grid.cols + '×' + m.grid.rows + ' 网格 · 1 格 ≈ ' +
      Math.round(m.meters / m.grid.cols) + ' m';
    syncPanel();
    updateList();
    updateCounts();
    requestDraw();
    try {
      if (location.hash.slice(1) !== m.id) history.replaceState(null, '', '#' + m.id);
    } catch (e) {}
  }

  const K_HIDDEN = 'tacmap.hiddenMaps.v1';
  function hiddenMapIds() {
    try { const v = JSON.parse(lsGet(K_HIDDEN) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function saveHiddenMapIds(ids) { lsSet(K_HIDDEN, JSON.stringify(ids)); }

  function builtinMaps() {
    return (window.HAJIN ? [window.HAJIN] : []).concat(window.MAPS);
  }

  function removeMap(id) {
    const m = S.maps.find(x => x.id === id);
    if (!m) return;
    if (S.maps.length <= 1) { toast('至少留一张地图'); return; }
    if (!confirm('删除地图「' + m.name + '」？它的标注也会一起删掉。')) return;
    lsDel(K_ITEMS(id));
    if (m.isCustom) {
      idbDel('img:' + id);
      S.maps = S.maps.filter(x => x.id !== id);
      saveCustomMetas();
    } else {
      const ids = hiddenMapIds();
      if (ids.indexOf(id) < 0) ids.push(id);
      saveHiddenMapIds(ids);
      S.maps = S.maps.filter(x => x.id !== id);
    }
    if (S.map === m) selectMap(S.maps[0].id);
    else buildTabs();
    toast('已删除「' + m.name + '」，在「方案 → 恢复已删除的地图」里能找回');
  }

  function restoreMaps() {
    const ids = hiddenMapIds();
    if (!ids.length) { toast('没有删除过地图'); return; }
    saveHiddenMapIds([]);
    const have = new Set(S.maps.map(m => m.id));
    const restored = [];
    builtinMaps().forEach(src => {
      if (ids.indexOf(src.id) >= 0 && !have.has(src.id)) {
        const m = prepareMap(src, false);
        S.maps.push(m);
        restored.push(m);
      }
    });
    // 按内建顺序重排，自定义地图放后面
    const order = builtinMaps().map(m => m.id);
    S.maps.sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    buildTabs();
    if (!S.map || !S.maps.some(m => m.id === S.map.id)) selectMap(S.maps[0].id);
    toast('已恢复 ' + restored.length + ' 张地图');
  }

  /* ---------------- 绘制 ---------------- */
  const cv = $('#cv');
  const ctx = cv.getContext('2d');
  const stage = $('#stage');

  function requestDraw() {
    if (S.needDraw) return;
    S.needDraw = true;
    requestAnimationFrame(() => { S.needDraw = false; draw(); });
  }

  function draw() {
    if (!S.map) return;
    const v = S.view, dpr = S.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);
    render(ctx, v.k);
    $('#zVal').textContent = Math.round(v.k * 100) + '%';
  }

  function render(g, k) {
    const m = S.map, size = m.size;
    S.labelHits = [];
    if (m.img) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(m.img, 0, 0, size, size);
    } else {
      g.fillStyle = '#0e1216';
      g.fillRect(0, 0, size, size);
    }
    if (S.dim > 0) {
      g.fillStyle = 'rgba(5,7,10,' + S.dim + ')';
      g.fillRect(0, 0, size, size);
    }
    if (S.layers.grid) drawGrid(g, k);
    if (S.layers.pen) m.items.forEach(it => { if (it.kind === 'pen') drawPen(g, it, k); });
    if (S.layers.routes) m.items.forEach(it => { if (it.kind === 'measure') drawMeasure(g, it, k); });
    if (S.layers.routes) m.items.forEach(it => { if (it.kind === 'route' && !S.hiddenRoutes.has(it.id)) drawRoute(g, it, k); });
    if (S.layers.markers) {
      const ms = m.items.filter(it => it.kind === 'marker' && isVisible(it));
      const isSel = it => S.sel && S.sel.id === it.id;
      const official = ms.filter(it => !isSel(it) && S.catDefs[it.cat]);
      const custom = ms.filter(it => !isSel(it) && !S.catDefs[it.cat]);
      const selMs = ms.filter(isSel);
      official.forEach(it => drawMarkerBase(g, it, k));
      custom.forEach(it => drawMarkerBase(g, it, k));
      selMs.forEach(it => drawMarkerBase(g, it, k));
      custom.forEach(it => drawMarkerLabel(g, it, k));
      official.forEach(it => drawMarkerLabel(g, it, k));
      selMs.forEach(it => drawMarkerLabel(g, it, k));
    }
    drawDraft(g, k);
  }

  function drawGrid(g, k) {
    const m = S.map, size = m.size, cols = m.grid.cols, rows = m.grid.rows;
    const cw = size / cols, ch = size / rows;
    g.save();
    g.strokeStyle = 'rgba(170,200,235,0.13)';
    g.lineWidth = 1 / k;
    g.beginPath();
    for (let i = 1; i < cols; i++) { g.moveTo(i * cw, 0); g.lineTo(i * cw, size); }
    for (let j = 1; j < rows; j++) { g.moveTo(0, j * ch); g.lineTo(size, j * ch); }
    g.stroke();
    g.strokeStyle = 'rgba(255,122,26,0.55)';
    g.lineWidth = 2 / k;
    g.strokeRect(0, 0, size, size);

    if (S.layers.labels) {
      const fs = 11 / k;
      g.font = '700 ' + fs + 'px ui-monospace,Menlo,Consolas,monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(210,226,245,0.55)';
      for (let i = 0; i < cols; i++) g.fillText(String.fromCharCode(65 + i), (i + 0.5) * cw, 12 / k + fs * 0.1);
      for (let j = 0; j < rows; j++) {
        g.textAlign = 'left';
        g.fillText(String(j + 1), 10 / k, (j + 0.5) * ch);
      }
    }
    g.restore();
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  function drawLabel(g, text, x, yTop, k, color) {
    if (!text) return;
    const fs = 12 / k;
    g.save();
    g.font = '600 ' + fs + 'px "Inter","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const w = g.measureText(text).width;
    const pad = 5 / k, bh = fs * 1.5;
    g.fillStyle = 'rgba(6,9,13,0.74)';
    roundRect(g, x - w / 2 - pad, yTop, w + pad * 2, bh, 3 / k);
    g.fill();
    g.strokeStyle = color ? color + '55' : 'rgba(255,255,255,0.12)';
    g.lineWidth = 1 / k;
    g.stroke();
    g.fillStyle = '#eaf1fa';
    g.fillText(text, x, yTop + bh / 2);
    g.restore();
  }

  /* 统一标点样式：虚线环 + 实心点 + 黑色文字胶囊（照参考图）
     官方点位用分类色，自建标注用自选色；自建标注一直显示文字 */
  function drawMarkerBase(g, it, k) {
    if (it.kind !== 'marker') return;
    if (it.dotless) return;                  // 纯文字模式，不画圆点
    const color = it.color || '#ff7a1a';
    const sel = S.sel && S.sel.id === it.id;
    const zoomed = k >= 0.4;
    const R = (zoomed ? 13 : 9) / k;
    const r = (zoomed ? 6.5 : 4.8) / k;

    g.save();
    if (zoomed || sel) {
      g.strokeStyle = sel ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)';
      g.lineWidth = (sel ? 2.4 : 1.7) / k;
      g.setLineDash([5.5 / k, 4.5 / k]);
      g.beginPath();
      g.arc(it.x, it.y, R, 0, TAU);
      g.stroke();
      g.setLineDash([]);
    }

    g.beginPath();
    g.arc(it.x, it.y, r, 0, TAU);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 2.4 / k;
    g.strokeStyle = 'rgba(8,11,15,0.92)';
    g.stroke();

    g.beginPath();
    g.arc(it.x - r * 0.28, it.y - r * 0.32, r * 0.34, 0, TAU);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fill();

    g.restore();
  }

  function drawMarkerLabel(g, it, k) {
    const sel = S.sel && S.sel.id === it.id;
    if (it.hideLabel && !sel) return;
    const text = (it.name || '').trim() || '点位';
    const a = typeof it.alpha === 'number' ? it.alpha : 1;
    if (it.dotless) {
      drawPlaceLabel(g, text, it.x, it.y, k, sel, a, it.color);
      return;
    }
    const R = (k >= 0.4 ? 13 : 9) / k;
    drawPinLabel(g, text, it.x + R + 3 / k, it.y, k, sel, a);
  }

  function hexA(hex, a) {
    if (!hex || hex[0] !== '#' || (hex.length !== 7 && hex.length !== 4)) return '';
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* 纯文字标注：只有一条淡底文字，居中在坐标上（不画圆点） */
  function drawPlaceLabel(g, text, cx, cy, k, sel, alpha, color) {
    const a = typeof alpha === 'number' ? alpha : 1;
    const fs = 12 / k;
    g.save();
    g.font = '700 ' + fs + 'px "Inter","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const maxW = 190 / k;
    let t = text;
    if (g.measureText(t).width > maxW) {
      while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      t += '…';
    }
    const w = g.measureText(t).width;
    const padX = 8 / k;
    const h = 20 / k;
    const x = cx - (w + padX * 2) / 2;
    const y = cy - h / 2;
    g.fillStyle = 'rgba(8,12,16,' + (0.62 * a).toFixed(3) + ')';
    roundRect(g, x, y, w + padX * 2, h, 5 / k);
    g.fill();
    g.strokeStyle = sel ? 'rgba(255,255,255,0.9)' : (hexA(color, 0.55) || 'rgba(255,255,255,0.14)');
    g.lineWidth = 1.1 / k;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
    g.fillText(t, cx, cy + 0.5 / k);
    g.restore();
  }

  function drawMarker(g, it, k) {
    drawMarkerBase(g, it, k);
    drawMarkerLabel(g, it, k);
  }

  function drawPinLabel(g, text, x, y, k, sel, alpha, maxW) {
    const a = typeof alpha === 'number' ? alpha : 1;
    const fs = 12 / k;
    g.save();
    g.font = '700 ' + fs + 'px "Inter","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const limit = (maxW || 190) / k;
    let t = text;
    if (g.measureText(t).width > limit) {
      while (t.length > 1 && g.measureText(t + '…').width > limit) t = t.slice(0, -1);
      t += '…';
    }
    const w = g.measureText(t).width;
    const padX = 9 / k;
    const h = 21 / k;
    g.fillStyle = 'rgba(4,6,10,' + (0.92 * a).toFixed(3) + ')';
    roundRect(g, x, y - h / 2, w + padX * 2, h, h / 2);
    g.fill();
    g.strokeStyle = sel ? 'rgba(255,255,255,' + (0.85 * a).toFixed(3) + ')' : 'rgba(255,255,255,' + (0.22 * a).toFixed(3) + ')';
    g.lineWidth = 1.1 / k;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
    g.fillText(t, x + padX, y + 0.5 / k);
    g.restore();
  }

  function strokePath(g, pts) {
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  }

  function arrowHead(g, a, b, k, col, width) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const s = (12 + (width || 4) * 0.9) / k;
    g.beginPath();
    g.moveTo(b.x, b.y);
    g.lineTo(b.x - Math.cos(ang - 0.42) * s, b.y - Math.sin(ang - 0.42) * s);
    g.lineTo(b.x - Math.cos(ang + 0.42) * s, b.y - Math.sin(ang + 0.42) * s);
    g.closePath();
    g.fillStyle = col;
    g.fill();
  }

  function routeLabelPoint(it) {
    if (it.labelPos) return it.labelPos;
    const pts = it.pts || [];
    const mid = pts[Math.floor(pts.length / 2)] || { x: 0, y: 0 };
    return { x: mid.x, y: mid.y - 22 / (S.view.k || 1) };
  }

  function drawRoute(g, it, k) {
    const pts = it.pts || [];
    if (pts.length < 2) return;
    const col = it.color || '#ff7a1a';
    const sel = S.sel && S.sel.id === it.id;
    const wScreen = it.width || 4;

    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    if (sel) {
      g.globalAlpha = 0.2;
      g.strokeStyle = col;
      g.lineWidth = (wScreen + 8) / k;
      strokePath(g, pts);
      g.stroke();
      g.globalAlpha = 1;
    }
    g.strokeStyle = col;
    g.lineWidth = wScreen / k;
    g.setLineDash([(wScreen * 2.6) / k, (wScreen * 1.7) / k]);
    strokePath(g, pts);
    g.stroke();
    g.setLineDash([]);

    g.beginPath();
    g.arc(pts[0].x, pts[0].y, (wScreen * 0.7 + 1.5) / k, 0, TAU);
    g.fillStyle = col;
    g.fill();
    g.strokeStyle = 'rgba(4,6,9,0.85)';
    g.lineWidth = 1.4 / k;
    g.stroke();

    arrowHead(g, pts[pts.length - 2], pts[pts.length - 1], k, col, wScreen);

    // 拐点小圆点 + 名字
    pts.forEach((pt, i) => {
      if (i > 0 && i < pts.length - 1) {
        g.beginPath();
        g.arc(pt.x, pt.y, (wScreen * 0.55 + 1) / k, 0, TAU);
        g.fillStyle = 'rgba(8,11,15,0.9)';
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = 1.6 / k;
        g.stroke();
      }
      if (pt.name) drawVertexName(g, pt, k, col);
    });
    g.restore();

    if (it.name) {
      const lp = routeLabelPoint(it);
      const box = drawRouteLabel(g, it.name, lp.x, lp.y, k, col, sel, it.labelSize, it.labelAlpha);
      if (box) S.labelHits.push({ id: it.id, x: box.x, y: box.y, w: box.w, h: box.h });
    }
  }

  function drawRouteLabel(g, text, x, y, k, col, sel, scale, alpha) {
    const sc = scale || 1;
    const a = typeof alpha === 'number' ? alpha : 1;
    const fs = (13 * sc) / k;
    g.save();
    g.font = '700 ' + fs + 'px "Inter","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const w = g.measureText(text).width;
    const padX = (9 * sc) / k;
    const h = (24 * sc) / k;
    const bx = x - w / 2 - padX;
    const by = y - h / 2;
    g.fillStyle = 'rgba(6,9,13,' + (0.88 * a).toFixed(3) + ')';
    roundRect(g, bx, by, w + padX * 2, h, h / 2);
    g.fill();
    g.strokeStyle = col;
    g.globalAlpha = a;
    g.lineWidth = ((sel ? 2 : 1.2) * sc) / k;
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
    g.fillText(text, x, y + 0.5 / k);
    g.restore();
    return { x: bx, y: by, w: w + padX * 2, h: h };
  }

  function drawVertexName(g, pt, k, col) {
    const fs = 10 / k;
    g.save();
    g.font = '600 ' + fs + 'px "Inter","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const w = g.measureText(pt.name).width;
    const pad = 5 / k;
    const h = fs * 1.7;
    const bx = pt.x + 8 / k;
    const by = pt.y - h / 2;
    g.fillStyle = 'rgba(6,9,13,0.75)';
    roundRect(g, bx, by, w + pad * 2, h, 4 / k);
    g.fill();
    g.strokeStyle = col + '66';
    g.lineWidth = 1 / k;
    g.stroke();
    g.fillStyle = '#e8eef7';
    g.fillText(pt.name, bx + pad, pt.y + 0.5 / k);
    g.restore();
  }

  function drawMeasure(g, it, k) {
    const a = it.a, b = it.b;
    if (!a || !b) return;
    const sel = S.sel && S.sel.id === it.id;
    const col = sel ? '#ffffff' : '#c9d6ea';
    g.save();
    g.strokeStyle = col;
    g.lineWidth = (sel ? 2.6 : 1.8) / k;
    g.setLineDash([7 / k, 6 / k]);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    g.setLineDash([]);
    [a, b].forEach(p => {
      g.beginPath();
      g.arc(p.x, p.y, 3.6 / k, 0, TAU);
      g.fillStyle = col;
      g.fill();
    });
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const meters = dist / S.map.size * S.map.meters;
    drawLabel(g, Math.round(meters) + ' m', (a.x + b.x) / 2, (a.y + b.y) / 2 - 16 / k, k, '#8fb6ff');
    g.restore();
  }

  function drawPen(g, it, k) {
    const pts = it.pts || [];
    if (pts.length < 2) return;
    const sel = S.sel && S.sel.id === it.id;
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    if (sel) {
      g.strokeStyle = it.color;
      g.globalAlpha = 0.25;
      g.lineWidth = (it.w || 9) + 8;
      strokePath(g, pts);
      g.stroke();
      g.globalAlpha = 1;
    }
    g.strokeStyle = it.color || '#ff7a1a';
    g.lineWidth = it.w || 9;
    strokePath(g, pts);
    g.stroke();
    g.restore();
  }

  function drawDraft(g, k) {
    const d = S.draft;
    if (!d) return;
    if (d.kind === 'route') {
      const pts = d.pts.slice();
      if (S.mouse.inside) pts.push(toWorld(S.mouse));
      if (pts.length > 1) {
        g.save();
        g.strokeStyle = d.color;
        g.globalAlpha = 0.75;
        g.lineWidth = 3 / k;
        g.setLineDash([10 / k, 8 / k]);
        strokePath(g, pts);
        g.stroke();
        g.setLineDash([]);
        d.pts.forEach(p => {
          g.beginPath();
          g.arc(p.x, p.y, 4 / k, 0, TAU);
          g.fillStyle = d.color;
          g.fill();
        });
        g.restore();
      }
    } else if (d.kind === 'pen') {
      g.save();
      g.strokeStyle = d.color;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.lineWidth = d.w;
      strokePath(g, d.pts);
      g.stroke();
      g.restore();
    } else if (d.kind === 'measure') {
      const b = S.mouse.inside ? toWorld(S.mouse) : d.a;
      g.save();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.6 / k;
      g.setLineDash([6 / k, 5 / k]);
      g.beginPath();
      g.moveTo(d.a.x, d.a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.setLineDash([]);
      const meters = Math.hypot(b.x - d.a.x, b.y - d.a.y) / S.map.size * S.map.meters;
      drawLabel(g, Math.round(meters) + ' m', (d.a.x + b.x) / 2, (d.a.y + b.y) / 2 - 16 / k, k, '#8fb6ff');
      g.restore();
    }
  }

  /* ---------------- 选择 / 命中 ---------------- */
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function pickAt(w) {
    const tol = 18 / S.view.k;
    let best = null, bestD = tol;
    const items = S.map.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'marker') {
        if (!S.layers.markers || !isVisible(it)) continue;
        const d = Math.hypot(it.x - w.x, it.y - w.y);
        if (d < bestD) { bestD = d; best = it; }
      } else if (it.kind === 'route') {
        if (!S.layers.routes) continue;
        for (let j = 0; j < it.pts.length - 1; j++) {
          const d = distToSeg(w, it.pts[j], it.pts[j + 1]);
          if (d < bestD) { bestD = d; best = it; }
        }
      } else if (it.kind === 'pen') {
        if (!S.layers.pen) continue;
        for (let j = 0; j < it.pts.length - 1; j++) {
          const d = distToSeg(w, it.pts[j], it.pts[j + 1]);
          if (d < bestD) { bestD = d; best = it; }
        }
      } else if (it.kind === 'measure') {
        const d = distToSeg(w, it.a, it.b);
        if (d < bestD) { bestD = d; best = it; }
      }
    }
    return best;
  }

  /* ---------------- 历史 ---------------- */
  function snapshot() { return JSON.stringify(S.map.items); }
  function pushHistory() {
    S.undo.push(snapshot());
    if (S.undo.length > 80) S.undo.shift();
    S.redo.length = 0;
  }
  function undo() {
    if (!S.undo.length) return toast('没有可撤销的操作');
    S.redo.push(snapshot());
    S.map.items = JSON.parse(S.undo.pop());
    afterMutate();
  }
  function redo() {
    if (!S.redo.length) return toast('没有可重做的操作');
    S.undo.push(snapshot());
    S.map.items = JSON.parse(S.redo.pop());
    afterMutate();
  }
  function afterMutate() {
    if (S.sel && !S.map.items.some(i => i.id === S.sel.id)) S.sel = null;
    saveItems();
    buildChips();
    updateList();
    updateCounts();
    syncPanel();
    requestDraw();
  }

  /* ---------------- 选择与面板 ---------------- */
  function select(it) {
    S.sel = it || null;
    syncPanel();
    updateList();
    requestDraw();
  }

  function syncPanel() {
    const box = $('#selBox'), empty = $('#selEmpty');
    const it = S.sel;
    if (!it) {
      box.hidden = true; empty.hidden = false;
      return;
    }
    box.hidden = false; empty.hidden = true;
    const nameInput = $('#selName'), descInput = $('#selDesc');
    nameInput.value = it.name || '';
    descInput.value = it.desc || '';
    descInput.disabled = it.kind === 'measure';
    let meta = '';
    if (it.kind === 'marker') {
      meta = (it.dotless ? '纯文字标注' : '标点') + ' · 网格 ' + cellOf(it) +
        ' · ' + Math.round(it.x) + ', ' + Math.round(it.y);
    } else if (it.kind === 'route') {
      let len = 0;
      for (let i = 0; i < it.pts.length - 1; i++) len += Math.hypot(it.pts[i + 1].x - it.pts[i].x, it.pts[i + 1].y - it.pts[i].y);
      meta = '路线 · ' + it.pts.length + ' 节点 · 约 ' + Math.round(len / S.map.size * S.map.meters) + ' m';
    } else if (it.kind === 'pen') {
      meta = '涂鸦 · ' + it.pts.length + ' 点';
    } else if (it.kind === 'measure') {
      const len = Math.hypot(it.b.x - it.a.x, it.b.y - it.a.y);
      meta = '测距 · ' + Math.round(len / S.map.size * S.map.meters) + ' m';
    }
    $('#selMeta').textContent = meta;
    const colorInput = $('#selColor');
    if (colorInput) {
      colorInput.hidden = it.kind !== 'marker';
      colorInput.value = it.color || '#ff7a1a';
    }
    const rt = $('#routeTools');
    if (rt) {
      rt.hidden = it.kind !== 'route';
      if (it.kind === 'route') {
        const wInp = $('#routeWidth');
        if (wInp) {
          const w = it.width || 4;
          wInp.value = w;
          const lbl = $('#routeWidthVal');
          if (lbl) lbl.textContent = w;
        }
        const szInp = $('#routeLabelSize');
        if (szInp) {
          const v = Math.round((it.labelSize || 1) * 100);
          szInp.value = v;
          const lbl = $('#routeLabelSizeVal');
          if (lbl) lbl.textContent = v + '%';
        }
        const laInp = $('#routeLabelAlpha');
        if (laInp) {
          const v = Math.round((typeof it.labelAlpha === 'number' ? it.labelAlpha : 1) * 100);
          laInp.value = v;
          const lbl = $('#routeLabelAlphaVal');
          if (lbl) lbl.textContent = v + '%';
        }
        buildVertexList(it);
      }
    }

    const pickRow = $('#groupPickRow');
    if (pickRow) {
      const isMarker = it.kind === 'marker';
      pickRow.hidden = !isMarker || !S.chipGroups.length;
      if (isMarker && S.chipGroups.length) {
        const sel = $('#selGroupPick');
        const key = markerTextKey(it.name);
        const cur = S.chipGroups.find(cg => (cg.keys || []).indexOf(key) >= 0);
        sel.innerHTML = '';
        const opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = cur ? '（移出分类）' : '（不归类）';
        sel.appendChild(opt0);
        S.chipGroups.forEach(cg => {
          const o = document.createElement('option');
          o.value = cg.id;
          o.textContent = cg.name;
          if (cur && cur.id === cg.id) o.selected = true;
          sel.appendChild(o);
        });
      }
    }

    const hideRow = $('#selHideLabel');
    if (hideRow) {
      const row = hideRow.closest('label');
      if (row) row.hidden = it.kind !== 'marker';
      hideRow.checked = !!it.hideLabel;
    }

    const dotlessRow = $('#selDotless');
    if (dotlessRow) {
      const row = dotlessRow.closest('label') || dotlessRow.parentElement;
      if (row) row.hidden = it.kind !== 'marker';
      dotlessRow.checked = !!it.dotless;
    }

    const alphaRow = $('#selAlpha');
    if (alphaRow) {
      const a = Math.round((typeof it.alpha === 'number' ? it.alpha : 1) * 100);
      alphaRow.value = a;
      const row = alphaRow.closest('.slider-row');
      if (row) row.hidden = it.kind !== 'marker';
      const lbl = $('#selAlphaVal');
      if (lbl) lbl.textContent = a + '%';
    }
  }

  /* 点位分组：官方分类 + 自建标注按文字同名合并 */
  function markerKey(it) {
    const label = (it.name || '').trim() || '（未命名）';
    return 't:' + label;
  }

  function markerGroups() {
    const groups = new Map();
    (S.map ? S.map.items : []).forEach(it => {
      if (it.kind !== 'marker') return;
      const key = markerKey(it);
      if (!groups.has(key)) {
        groups.set(key, {
          key: key,
          name: (it.name || '').trim() || '（未命名）',
          color: it.color || '#ff7a1a',
          count: 0,
          kind: 'text'
        });
      }
      groups.get(key).count++;
    });
    return Array.from(groups.values()).filter(g => g.count > 0);
  }

  function buildVertexList(it) {
    const box = $('#vertexList');
    if (!box) return;
    box.innerHTML = '';
    (it.pts || []).forEach((pt, i) => {
      const row = document.createElement('div');
      row.className = 'vrow';
      const idx = document.createElement('span');
      idx.className = 'vidx';
      idx.textContent = i + 1;
      const inp = document.createElement('input');
      inp.className = 'inp';
      inp.value = pt.name || '';
      inp.placeholder = '拐点 ' + (i + 1);
      inp.addEventListener('input', () => {
        pt.name = inp.value;
        saveItems();
        requestDraw();
      });
      row.appendChild(idx);
      row.appendChild(inp);
      box.appendChild(row);
    });
  }

  function isVisible(it) {
    if (it.kind === 'route') return !S.hiddenRoutes.has(it.id);
    if (it.kind !== 'marker') return true;
    return !S.hidden.has(markerKey(it));
  }

  function buildChips() {
    const box = $('#chips');
    if (!box || !S.map) return;
    box.hidden = false;
    box.innerHTML = '';

    const modeBox = document.createElement('div');
    modeBox.className = 'chipmode';
    [['marker', '点位'], ['route', '路线']].forEach(([mode, label]) => {
      const b = document.createElement('button');
      b.className = S.filterMode === mode ? 'on' : '';
      b.textContent = label;
      b.addEventListener('click', () => {
        S.filterMode = mode;
        buildChips();
        requestDraw();
      });
      modeBox.appendChild(b);
    });
    box.appendChild(modeBox);

    const lab = document.createElement('span');
    lab.className = 'label';
    lab.textContent = S.filterMode === 'route' ? '路线筛选' : '点位筛选';
    box.appendChild(lab);

    // 合并按钮（只在点位模式显示）
    if (S.filterMode !== 'route') {
      // 合并按钮
      if (!S.mergeMode) {
        const mb = document.createElement('button');
        mb.className = 'chip merge-btn';
        mb.textContent = '合并…';
        mb.title = '把几个分类并成一个';
        mb.addEventListener('click', () => {
          S.mergeMode = true;
          S.mergeSel = new Set();
          buildChips();
        });
        box.appendChild(mb);
      } else {
        const ok = document.createElement('button');
        ok.className = 'chip merge-btn' + (S.mergeSel.size >= 2 ? ' ready' : '');
        ok.textContent = S.mergeSel.size >= 2 ? '合并这 ' + S.mergeSel.size + ' 类' : '至少选 2 个';
        ok.addEventListener('click', () => {
          if (S.mergeSel.size < 2) return;
          const name = prompt('合并后的分类名（比如「地点」）', '地点');
          if (!name) return;
          addChipGroup(name, Array.from(S.mergeSel));
        });
        box.appendChild(ok);

        const cancel = document.createElement('button');
        cancel.className = 'chip merge-btn';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => {
          S.mergeMode = false; S.mergeSel = new Set(); buildChips();
        });
        box.appendChild(cancel);
      }
    }



    if (S.filterMode === 'route') {
      const routes = S.map.items.filter(i => i.kind === 'route');
      const allShown = routes.length > 0 && S.hiddenRoutes.size === 0;
      const all = document.createElement('button');
      all.className = 'chip all' + (allShown ? ' on' : '');
      all.innerHTML = '全部 <b>' + routes.length + '</b>';
      all.title = allShown ? '再点一下全部隐藏' : '点一下全部显示';
      all.addEventListener('click', () => {
        if (allShown) routes.forEach(r => S.hiddenRoutes.add(r.id));
        else S.hiddenRoutes.clear();
        buildChips(); requestDraw();
      });
      box.appendChild(all);
      if (!routes.length) {
        const empty = document.createElement('span');
        empty.className = 'label';
        empty.textContent = '还没有路线';
        box.appendChild(empty);
      }
      routes.forEach(rt => {
        const on = !S.hiddenRoutes.has(rt.id);
        const b = document.createElement('button');
        b.className = 'chip' + (on ? ' on' : '');
        b.innerHTML = '<i style="background:' + (rt.color || '#ff7a1a') + '"></i><span>' + esc(rt.name || '路线') + '</span>';
        b.addEventListener('click', () => {
          if (S.hiddenRoutes.has(rt.id)) S.hiddenRoutes.delete(rt.id);
          else S.hiddenRoutes.add(rt.id);
          buildChips(); requestDraw();
        });
        box.appendChild(b);
      });
      return;
    }

    const groups = markerGroups();
    if (!groups.length) {
      const empty = document.createElement('span');
      empty.className = 'label';
      empty.textContent = '还没有点位';
      box.appendChild(empty);
      return;
    }

    const byKey = new Map(groups.map(g => [g.key, g]));
    // 只保留至少 2 个成员还在的合并组；只剩 1 个的按普通分类显示
    const validGroups = S.chipGroups.filter(cg =>
      (cg.keys || []).filter(k => byKey.has(k)).length >= 2);
    const used = new Set();
    validGroups.forEach(cg => (cg.keys || []).forEach(k => used.add(k)));
    const loose = groups.filter(g => !used.has(g.key));

    function chipEl(label, color, count, cls) {
      const b = document.createElement('button');
      b.className = 'chip' + (cls ? ' ' + cls : '');
      b.innerHTML = (color ? '<i style="background:' + color + '"></i>' : '') +
        '<span>' + esc(label) + '</span>' + (count != null ? ' <b>' + count + '</b>' : '');
      return b;
    }

    const total = S.map.items.filter(i => i.kind === 'marker').length;
    const allShown = S.hidden.size === 0;
    const all = chipEl('全部', null, total, 'all' + (allShown ? ' on' : ''));
    all.title = allShown ? '再点一下全部隐藏' : '点一下全部显示';
    all.addEventListener('click', () => {
      if (allShown) groups.forEach(g => S.hidden.add(g.key));
      else S.hidden.clear();
      buildChips(); updateList(); updateCounts(); requestDraw();
    });
    box.appendChild(all);

    // 已合并的分类
    validGroups.forEach(cg => {
      const members = (cg.keys || []).map(k => byKey.get(k)).filter(Boolean);
      if (!members.length) return;
      const shownAll = members.every(mm => !S.hidden.has(mm.key));
      const b = chipEl(cg.name, members[0].color, members.length, 'group' + (shownAll ? ' on' : ''));
      b.title = '点击显隐 · 双击改名 · 右键解散';
      b.addEventListener('click', () => {
        if (S.mergeMode) return;
        if (shownAll) members.forEach(mm => S.hidden.add(mm.key));
        else members.forEach(mm => S.hidden.delete(mm.key));
        buildChips(); updateList(); updateCounts(); requestDraw();
      });
      b.addEventListener('dblclick', () => {
        const name = prompt('这个分类叫什么？', cg.name);
        if (name) { cg.name = name.trim(); saveChipGroups(); buildChips(); }
      });
      b.addEventListener('contextmenu', ev => {
        ev.preventDefault();
        if (!confirm('解散分类「' + cg.name + '」？点位不会删，只是拆回单个分类。')) return;
        S.chipGroups = S.chipGroups.filter(x => x !== cg);
        saveChipGroups(); buildChips();
      });

      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = S.openGroups.has(cg.id) ? '▾' : '▸';
      caret.addEventListener('click', ev => {
        ev.stopPropagation();
        if (S.openGroups.has(cg.id)) S.openGroups.delete(cg.id);
        else S.openGroups.add(cg.id);
        buildChips();
      });
      b.appendChild(caret);
      b.title = '点击显隐 · ▸ 展开成员 · 双击改名 · 右键解散';
      box.appendChild(b);

      if (S.openGroups.has(cg.id)) {
        members.forEach(mm => {
          const shown = !S.hidden.has(mm.key);
          const m = document.createElement('button');
          m.className = 'chip sub' + (shown ? ' on' : '');
          m.innerHTML = '<i style="background:' + mm.color + '"></i><span>' + esc(mm.name) + '</span> <b>' + mm.count + '</b><span class="rm" title="从分类中移出">✕</span>';
          m.title = '点击显隐；点 ✕ 从分类里移出';
          m.addEventListener('click', ev => {
            if (ev.target.classList.contains('rm')) {
              ev.stopPropagation();
              cg.keys = (cg.keys || []).filter(k => k !== mm.key);
              if ((cg.keys || []).length < 2) {
                S.chipGroups = S.chipGroups.filter(x => x !== cg);
                toast('分类只剩 1 个成员，已自动拆开');
              } else {
                toast('已把「' + mm.name + '」移出分类');
              }
              saveChipGroups();
              buildChips();
              return;
            }
            if (shown) S.hidden.add(mm.key); else S.hidden.delete(mm.key);
            buildChips(); updateList(); updateCounts(); requestDraw();
          });
          box.appendChild(m);
        });
      }
    });

    // 未合并的分类
    loose.forEach(gr => {
      const on = !S.hidden.has(gr.key);
      const selected = S.mergeSel.has(gr.key);
      const b = chipEl(gr.name, gr.color, gr.count,
        (S.mergeMode ? (selected ? 'sel' : '') : (on ? 'on' : '')));
      b.dataset.key = gr.key;
      b.title = S.mergeMode ? '点一下选中 / 取消' : (gr.kind === 'cat' ? '官方点位分类' : '自己标的同名标注');
      b.addEventListener('click', () => {
        if (S.mergeMode) {
          if (S.mergeSel.has(gr.key)) S.mergeSel.delete(gr.key);
          else S.mergeSel.add(gr.key);
          buildChips();
          return;
        }
        if (S.hidden.has(gr.key)) S.hidden.delete(gr.key);
        else S.hidden.add(gr.key);
        buildChips(); updateList(); updateCounts(); requestDraw();
      });
      box.appendChild(b);
    });


  }

  function markerTextKey(name) {
    return 't:' + ((name || '').trim() || '（未命名）');
  }

  function removeKeyFromGroups(key) {
    let changed = false;
    S.chipGroups.forEach(cg => {
      if (!cg.keys) return;
      const i = cg.keys.indexOf(key);
      if (i >= 0) { cg.keys.splice(i, 1); changed = true; }
    });
    if (changed) {
      S.chipGroups = S.chipGroups.filter(cg => (cg.keys || []).length >= 2);
      saveChipGroups();
    }
    return changed;
  }

  function addKeyToGroup(groupId, key) {
    S.chipGroups.forEach(cg => { if (cg.id !== groupId && cg.keys) {
      const i = cg.keys.indexOf(key);
      if (i >= 0) cg.keys.splice(i, 1);
    } });
    const g = S.chipGroups.find(cg => cg.id === groupId);
    if (g) {
      g.keys = g.keys || [];
      if (g.keys.indexOf(key) < 0) g.keys.push(key);
    }
    S.chipGroups = S.chipGroups.filter(cg => (cg.keys || []).length >= 2);
    saveChipGroups();
    buildChips();
  }

  function addChipGroup(name, keys) {
    S.chipGroups.push({ id: uid('g'), name: (name || '').trim() || '合并分类', keys: keys || [] });
    saveChipGroups();
    S.mergeMode = false;
    S.mergeSel = new Set();
    buildChips(); updateList(); updateCounts(); requestDraw();
    toast('已合并，双击分类可改名，右键解散');
  }

  function updateCounts() {
    if (!S.map) return;
    const nm = S.map.items.filter(i => i.kind === 'marker').length;
    const nr = S.map.items.filter(i => i.kind === 'route').length;
    const shown = S.map.items.filter(i => i.kind === 'marker' && isVisible(i)).length;
    $('#stCount').textContent = '标记 ' + (shown === nm ? nm : shown + '/' + nm) + ' · 路线 ' + nr;
  }

  function updateList() {
    const box = $('#list');
    if (!box || !S.map) return;
    box.innerHTML = '';
    const rows = S.map.items.filter(i => (i.kind === 'marker' && isVisible(i)) || i.kind === 'route').slice(0, 400);
    rows.forEach(it => {
      const cat = it.kind === 'marker'
        ? { color: it.color || '#ff7a1a', name: '标注' }
        : { color: it.color || '#ff7a1a', name: '路线' };
      const el = document.createElement('div');
      el.className = 'item' + (it.kind === 'route' ? ' route' : '') + (S.sel && S.sel.id === it.id ? ' on' : '');
      el.innerHTML = '<i style="background:' + cat.color + '"></i><span class="nm">' + esc(it.name || cat.name) + '</span><span class="rm">×</span>';
      el.addEventListener('click', ev => {
        if (ev.target.classList.contains('rm')) { deleteItem(it.id); return; }
        select(it);
        const p = it.kind === 'marker' ? it : it.pts[0];
        centerOn(p);
      });
      box.appendChild(el);
    });
    $('#listCount').textContent = rows.length;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function deleteItem(id) {
    const i = S.map.items.findIndex(x => x.id === id);
    if (i < 0) return;
    pushHistory();
    S.map.items.splice(i, 1);
    if (S.sel && S.sel.id === id) S.sel = null;
    afterMutate();
    toast('已删除');
  }

  function removeItem(id) { deleteItem(id); }

  /* ---------------- 工具动作 ---------------- */

  function placeMarker(w) {
    pushHistory();
    const n = S.map.items.filter(i => i.kind === 'marker' && !S.catDefs[i.cat]).length + 1;
    const it = {
      id: uid('m'), kind: 'marker', color: S.color,
      x: clamp(w.x, 0, S.map.size), y: clamp(w.y, 0, S.map.size),
      name: '点位 ' + n, desc: '', alpha: 1
    };
    S.map.items.push(it);
    S.sel = it;
    afterMutate();
    const inp = $('#selName');
    if (inp) { try { inp.focus(); inp.select(); } catch (e) {} }
    hint('在右边输入文字，标注就会显示在地图上');
  }

  let clipItem = null;

  function copySelected() {
    const it = S.sel;
    if (!it || it.kind !== 'marker') { toast('先选中一个标点'); return; }
    const def = S.catDefs[it.cat];
    clipItem = {
      name: it.name || (def ? def.name : '点位'),
      color: def ? def.color : (it.color || S.color),
      desc: it.desc || '',
      alpha: typeof it.alpha === 'number' ? it.alpha : 1,
      dotless: !!it.dotless,
      hideLabel: !!it.hideLabel
    };
    toast('已复制「' + clipItem.name + '」，Ctrl+V 或右键粘贴');
  }

  function pasteMarker(w) {
    if (!clipItem) { toast('剪贴板里还没有标点'); return; }
    const p = w || (S.mouse.inside ? toWorld(S.mouse) : { x: S.map.size / 2, y: S.map.size / 2 });
    pushHistory();
    const it = {
      id: uid('m'), kind: 'marker', color: clipItem.color,
      x: clamp(p.x, 0, S.map.size), y: clamp(p.y, 0, S.map.size),
      name: clipItem.name, desc: clipItem.desc, alpha: clipItem.alpha,
      dotless: !!clipItem.dotless, hideLabel: !!clipItem.hideLabel
    };
    S.map.items.push(it);
    S.sel = it;
    afterMutate();
    toast('已粘贴「' + it.name + '」');
  }

  function addRoutePoint(w) {
    if (!S.draft || S.draft.kind !== 'route') {
      S.draft = { kind: 'route', color: S.routeColor, pts: [w] };
      hint('连续点击落点，双击或 Enter 结束，Esc 取消');
    } else {
      const last = S.draft.pts[S.draft.pts.length - 1];
      if (Math.hypot(w.x - last.x, w.y - last.y) > 6 / S.view.k) S.draft.pts.push(w);
    }
    requestDraw();
  }

  function finishRoute() {
    const d = S.draft;
    S.draft = null;
    if (!d || d.kind !== 'route') { requestDraw(); return; }
    if (d.pts.length < 2) { toast('至少两个点才能成为路线'); requestDraw(); return; }
    pushHistory();
    const n = S.map.items.filter(i => i.kind === 'route').length + 1;
    const it = { id: uid('r'), kind: 'route', color: d.color, name: '路线 ' + n, pts: d.pts, width: 4 };
    S.map.items.push(it);
    S.sel = it;
    afterMutate();
  }

  function startPen(w) {
    S.draft = { kind: 'pen', color: S.color, w: 9, pts: [w] };
  }

  function addMeasurePoint(w) {
    if (!S.draft || S.draft.kind !== 'measure') {
      S.draft = { kind: 'measure', a: w };
      hint('再点一个点完成测距');
      requestDraw();
      return;
    }
    const a = S.draft.a;
    S.draft = null;
    if (Math.hypot(w.x - a.x, w.y - a.y) < 6 / S.view.k) { requestDraw(); return; }
    pushHistory();
    const it = { id: uid('d'), kind: 'measure', a: a, b: w, color: '#c9d6ea', name: '测距' };
    S.map.items.push(it);
    S.sel = it;
    afterMutate();
  }

  function cancelDraft() {
    if (!S.draft) return false;
    S.draft = null;
    requestDraw();
    hint('');
    return true;
  }

  function setTool(t) {
    if (S.tool === 'route' && t !== 'route') finishRoute();
    if (S.draft && S.draft.kind !== 'route') S.draft = null;
    S.tool = t;
    $$('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    const label = { view: '观察（只浏览）', select: '选择 / 移动', marker: '放置标记', route: '画路线', erase: '点击擦除' }[t] || t;
    $('#stTool').textContent = '工具：' + label;
    cv.style.cursor = t === 'view' ? 'grab' : t === 'select' ? 'default' : t === 'erase' ? 'not-allowed' : 'crosshair';
    const tips = {
      view: '只浏览：拖拽平移，点一下看信息，东西挪不动',
      marker: '点地图放一个点，然后在右边输入文字',
      route: '连续点击落点，双击或 Enter 结束',
      erase: '点一下要删除的标记 / 路线'
    };
    hint(tips[t] || '');
    requestDraw();
  }

  function setColor(c) {
    if (!/^#[0-9a-f]{6}$/i.test(c)) return;
    S.color = c;
    S.routeColor = c;
    $$('.swatch').forEach(b => b.classList.toggle('on', b.dataset.color.toLowerCase() === c.toLowerCase()));
    const ci = $('#colorInput');
    if (ci) ci.value = c;
    if (S.sel && S.sel.kind === 'marker' && !S.catDefs[S.sel.cat]) {
      S.sel.color = c;
      saveItems();
      updateList();
      requestDraw();
    }
    requestDraw();
  }

  /* ---------------- 指针事件 ---------------- */
  function onDown(e) {
    const p = localPoint(e);
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    S.pointers.set(e.pointerId, p);

    if (e.button === 2) {
      S.drag = { type: 'pan', sx: p.x, sy: p.y, ox: S.view.x, oy: S.view.y };
      stage.classList.add('pan');
      return;
    }

    if (S.pointers.size === 2) {
      const pts = Array.from(S.pointers.values());
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      S.pinch = {
        d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        k: S.view.k,
        world: toWorld(mid)
      };
      S.drag = null;
      return;
    }
    if (S.pointers.size > 2) return;

    const w = toWorld(p);
    const hit = pickAt(w);

    if (S.tool === 'view') {
      S.drag = { type: 'pan', sx: p.x, sy: p.y, ox: S.view.x, oy: S.view.y, moved: false, hitId: hit ? hit.id : null };
      stage.classList.add('pan');
      return;
    }

    const wantPan = S.space || e.button === 1 || (S.tool === 'select' && !hit);

    if (wantPan) {
      S.drag = { type: 'pan', sx: p.x, sy: p.y, ox: S.view.x, oy: S.view.y };
      stage.classList.add('pan');
      return;
    }

    // 先看是不是点在路线文字上（可以拖着走）
    if (S.tool === 'select') {
      const pad = 6 / S.view.k;
      const hitLabel = S.labelHits.find(b =>
        w.x > b.x - pad && w.x < b.x + b.w + pad && w.y > b.y - pad && w.y < b.y + b.h + pad);
      if (hitLabel) {
        const rt = S.map.items.find(i => i.id === hitLabel.id);
        if (rt) {
          select(rt);
          S.drag = { type: 'label', id: rt.id };
          return;
        }
      }
    }

    switch (S.tool) {
      case 'select':
        select(hit);
        if (hit) {
          S.drag = { type: 'item', id: hit.id, w: w, moved: false };
        }
        break;
      case 'marker':
        placeMarker(w);
        break;
      case 'route':
        addRoutePoint(w);
        break;
      case 'erase':
        if (hit) deleteItem(hit.id);
        break;
    }
  }

  function onMove(e) {
    const p = localPoint(e);
    if (S.pointers.has(e.pointerId)) S.pointers.set(e.pointerId, p);
    S.mouse = { x: p.x, y: p.y, inside: true };
    const w = toWorld(p);

    if (S.pinch && S.pointers.size === 2) {
      const pts = Array.from(S.pointers.values());
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const k2 = clamp(S.pinch.k * d / S.pinch.d, 0.06, 10);
      S.view.k = k2;
      S.view.x = mid.x - S.pinch.world.x * k2;
      S.view.y = mid.y - S.pinch.world.y * k2;
      clampView();
      requestDraw();
      return;
    }

    if (S.drag && S.drag.type === 'pan') {
      if (Math.hypot(p.x - S.drag.sx, p.y - S.drag.sy) > 4) S.drag.moved = true;
      S.view.x = S.drag.ox + (p.x - S.drag.sx);
      S.view.y = S.drag.oy + (p.y - S.drag.sy);
      clampView();
      requestDraw();
      return;
    }

    if (S.drag && S.drag.type === 'label') {
      const rt = S.map.items.find(x => x.id === S.drag.id);
      if (rt) {
        rt.labelPos = { x: w.x, y: w.y };
        requestDraw();
      }
      return;
    }

    if (S.drag && S.drag.type === 'item') {
      const it = S.map.items.find(x => x.id === S.drag.id);
      if (it && it.kind === 'marker') {
        if (!S.drag.moved && Math.hypot(w.x - S.drag.w.x, w.y - S.drag.w.y) > 3 / S.view.k) {
          pushHistory();
          S.drag.moved = true;
        }
        if (S.drag.moved) {
          it.x = clamp(w.x, 0, S.map.size);
          it.y = clamp(w.y, 0, S.map.size);
        }
      }
    }

    if (S.draft && S.draft.kind === 'pen') {
      const last = S.draft.pts[S.draft.pts.length - 1];
      if (Math.hypot(w.x - last.x, w.y - last.y) > 3 / S.view.k) S.draft.pts.push(w);
    }

    $('#stCoord').textContent = '网格 ' + cellOf(w) + ' · ' + Math.round(w.x) + ', ' + Math.round(w.y);
    requestDraw();
  }

  function onUp(e) {
    const wasView = S.tool === 'view' && S.drag && S.drag.type === 'pan' && !S.drag.moved;
    S.pointers.delete(e.pointerId);
    if (S.pointers.size < 2) S.pinch = null;
    stage.classList.remove('pan');

    if (S.drag && S.drag.type === 'label') {
      const rt = S.map.items.find(x => x.id === S.drag.id);
      if (rt) {
        rt.labelPos = { x: w.x, y: w.y };
        requestDraw();
      }
      return;
    }

    if (S.drag && S.drag.type === 'item') {
      const it = S.map.items.find(x => x.id === S.drag.id);
      if (it && S.drag.moved) { saveItems(); syncPanel(); updateList(); }
    }
    if (S.drag && S.drag.type === 'label') { saveItems(); }
    if (wasView && S.drag && S.drag.hitId) {
      const it = S.map.items.find(x => x.id === S.drag.hitId);
      if (it) select(it);
    }
    if (S.draft && S.draft.kind === 'pen') {
      if (S.draft.pts.length > 1) {
        pushHistory();
        const it = S.draft;
        S.draft = null;
        const n = S.map.items.filter(x => x.kind === 'pen').length + 1;
        const item = { id: uid('p'), kind: 'pen', color: it.color, w: it.w, pts: it.pts, name: '涂鸦 ' + n };
        S.map.items.push(item);
        afterMutate();
      } else {
        S.draft = null;
        requestDraw();
      }
    }
    S.drag = null;
  }

  function onLeave() {
    S.mouse.inside = false;
    requestDraw();
  }

  /* ---------------- 缩放 / 快捷键 ---------------- */
  function onWheel(e) {
    e.preventDefault();
    const p = localPoint(e);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    zoomAt(p, S.view.k * factor);
  }

  function onKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.code === 'Space') { S.space = true; stage.classList.add('pan'); return; }

    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
      if (k === 's') { e.preventDefault(); exportPng(); return; }
      if (k === 'c') { e.preventDefault(); copySelected(); return; }
      if (k === 'v') { e.preventDefault(); pasteMarker(); return; }
      return;
    }
    if (k >= '1' && k <= '5') {
      const tools = ['view', 'select', 'marker', 'route', 'erase'];
      setTool(tools[+k - 1]);
      return;
    }
    if (k === 'f') { fitView(); requestDraw(); toast('已适应窗口'); return; }
    if (k === 'g') {
      S.layers.grid = !S.layers.grid;
      $('#panel [data-layer="grid"]').checked = S.layers.grid;
      requestDraw();
      return;
    }
    if (k === 'escape') {
      if (!cancelDraft()) select(null);
      return;
    }
    if (k === 'delete' || k === 'backspace') {
      if (S.sel) { e.preventDefault(); deleteItem(S.sel.id); }
      return;
    }
    if (k === 'enter' && S.draft && S.draft.kind === 'route') { finishRoute(); return; }
    if (k === 'v') { setTool('select'); return; }
  }

  /* ---------------- 导出 / 导入 ---------------- */
  function download(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); if (url.startsWith('blob:')) URL.revokeObjectURL(url); }, 1500);
  }

  function exportPng() {
    if (!S.map) return;
    const m = S.map, size = m.size;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    const k = Math.max(0.3, 900 / size);
    render(g, k);
    g.save();
    const fs = 20 / k;
    g.font = '700 ' + fs + 'px "Inter","Noto Sans SC",system-ui,sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText('TACMAP · ' + m.name, size - 24 / k, size - 22 / k);
    g.restore();
    c.toBlob(b => {
      if (!b) return toast('导出失败');
      download(URL.createObjectURL(b), 'tacmap-' + m.id + '.png');
      toast('已导出 PNG');
    }, 'image/png');
  }

  function planData() {
    return {
      app: 'tacmap', version: 2,
      map: { id: S.map.id, name: S.map.name, size: S.map.size, meters: S.map.meters, grid: S.map.grid },
      items: S.map.items,
      chipGroups: S.chipGroups
    };
  }

  function exportPlan() {
    const blob = new Blob([JSON.stringify(planData(), null, 2)], { type: 'application/json' });
    download(URL.createObjectURL(blob), 'tacmap-' + S.map.id + '.json');
    toast('已导出方案 JSON');
  }

  function importPlan(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(String(fr.result));
        if (!d || !Array.isArray(d.items)) throw new Error('格式不对');
        if (!confirm('用方案里的 ' + d.items.length + ' 个对象覆盖当前地图的标注？')) return;
        pushHistory();
        S.map.items = d.items;
        if (Array.isArray(d.chipGroups)) {
          S.chipGroups = d.chipGroups;
          saveChipGroups();
        }
        S.sel = null;
        afterMutate();
        toast('已导入 ' + d.items.length + ' 个对象');
      } catch (err) {
        toast('导入失败：' + err.message);
      }
    };
    fr.readAsText(file);
  }

  /* ---------------- 自定义地图 ---------------- */
  function handleUpload(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast('请选择图片文件');
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const id = 'custom-' + uid('');
      const m = {
        id: id,
        name: (file.name || '自定义地图').replace(/\.[^.]+$/, '').slice(0, 14) || '自定义地图',
        desc: '自定义底图',
        src: url,
        size: im.naturalWidth || 2048,
        grid: { cols: 10, rows: 10 },
        meters: 300,
        items: [],
        isCustom: true,
        img: im,
        loaded: true
      };
      S.maps.push(m);
      saveCustomMetas();
      idbPut('img:' + id, file).catch(() => toast('底图较大，刷新后可能读不回来'));
      buildTabs();
      selectMap(id);
      toast('已添加「' + m.name + '」，标注会自动保存');
    };
    im.onerror = () => toast('图片读取失败');
    im.src = url;
  }

  async function hydrateCustom(m) {
    try {
      const blob = await idbGet('img:' + m.id);
      if (blob) {
        m.src = URL.createObjectURL(blob);
        loadImage(m);
      }
    } catch (e) { /* file:// 下 IndexedDB 可能不可用 */ }
  }

  /* ---------------- UI 绑定 ---------------- */
  const SWATCHES = [
    '#ff7a1a', '#ffb020', '#ffd166', '#ff5470',
    '#f472b6', '#c084fc', '#8b5cf6', '#4da3ff',
    '#22d3ee', '#3ddc97', '#a3e635', '#e6e9ee'
  ];

  function buildSwatches() {
    const box = $('#swatches');
    if (!box) return;
    box.innerHTML = '';
    SWATCHES.forEach(c => {
      const b = document.createElement('button');
      b.className = 'swatch' + (c.toLowerCase() === S.color.toLowerCase() ? ' on' : '');
      b.dataset.color = c;
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        setColor(c);
        if (S.tool !== 'marker' && S.tool !== 'pen') setTool('marker');
      });
      box.appendChild(b);
    });
  }

  function bindUI() {
    $$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

    $$('#panel [data-layer]').forEach(chk => {
      chk.addEventListener('change', () => {
        S.layers[chk.dataset.layer] = chk.checked;
        requestDraw();
      });
    });

    const dim = $('#dim');
    dim.addEventListener('input', () => {
      S.dim = +dim.value / 100;
      $('#dimVal').textContent = dim.value + '%';

      requestDraw();
    });
    $('#dimVal').textContent = dim.value + '%';


    $('#zIn').addEventListener('click', () => zoomAt({ x: S.cw / 2, y: S.ch / 2 }, S.view.k * 1.35));
    $('#zOut').addEventListener('click', () => zoomAt({ x: S.cw / 2, y: S.ch / 2 }, S.view.k / 1.35));
    $('#zFit').addEventListener('click', () => { fitView(); requestDraw(); });

    $('#btnUpload').addEventListener('click', () => $('#fileMap').click());
    $('#fileMap').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      handleUpload(f);
      e.target.value = '';
    });
    $('#btnPng').addEventListener('click', exportPng);
    $('#filePlan').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) importPlan(f);
      e.target.value = '';
    });

    $('#btnPlan').addEventListener('click', ev => {
      const r = ev.currentTarget.getBoundingClientRect();
      openMenu(r.left, r.bottom + 6, [
        { label: '导出方案 JSON', fn: exportPlan },
        { label: '导入方案 JSON', fn: () => $('#filePlan').click() },
        { label: '恢复已删除的地图', fn: restoreMaps }
      ]);
    });

    $('#btnHelp').addEventListener('click', () => { $('#helpModal').hidden = false; });    $('#helpClose').addEventListener('click', () => { $('#helpModal').hidden = true; });
    $('#helpModal').addEventListener('click', e => { if (e.target.id === 'helpModal') $('#helpModal').hidden = true; });

    $('#selName').addEventListener('input', e => {
      if (!S.sel) return;
      S.sel.name = e.target.value;
      updateList();
      if (S.sel.kind === 'marker' && !S.catDefs[S.sel.cat]) buildChips();
      requestDraw();
      saveItems();
    });
    $('#selDesc').addEventListener('input', e => {
      if (!S.sel) return;
      S.sel.desc = e.target.value;
      saveItems();
    });
    $('#selDel').addEventListener('click', () => { if (S.sel) deleteItem(S.sel.id); });
    const copyBtn = $('#selCopy');
    if (copyBtn) copyBtn.addEventListener('click', copySelected);

    const colorInput = $('#colorInput');
    if (colorInput) colorInput.addEventListener('input', e => setColor(e.target.value));
    const selColor = $('#selColor');
    if (selColor) selColor.addEventListener('input', e => setColor(e.target.value));
    const rw = $('#routeWidth');
    if (rw) {
      rw.addEventListener('input', () => {
        if (!S.sel || S.sel.kind !== 'route') return;
        S.sel.width = +rw.value;
        const lbl = $('#routeWidthVal');
        if (lbl) lbl.textContent = rw.value;
        saveItems();
        requestDraw();
      });
    }

    const rls = $('#routeLabelSize');
    if (rls) {
      rls.addEventListener('input', () => {
        if (!S.sel || S.sel.kind !== 'route') return;
        S.sel.labelSize = +rls.value / 100;
        const lbl = $('#routeLabelSizeVal');
        if (lbl) lbl.textContent = rls.value + '%';
        saveItems();
        requestDraw();
      });
    }
    const rla = $('#routeLabelAlpha');
    if (rla) {
      rla.addEventListener('input', () => {
        if (!S.sel || S.sel.kind !== 'route') return;
        S.sel.labelAlpha = +rla.value / 100;
        const lbl = $('#routeLabelAlphaVal');
        if (lbl) lbl.textContent = rla.value + '%';
        saveItems();
        requestDraw();
      });
    }

    const gp = $('#selGroupPick');
    if (gp) {
      gp.addEventListener('change', () => {
        if (!S.sel || S.sel.kind !== 'marker') return;
        const key = markerTextKey(S.sel.name);
        if (gp.value) addKeyToGroup(gp.value, key);
        else { removeKeyFromGroups(key); buildChips(); syncPanel(); }
      });
    }

    const hideBox = $('#selHideLabel');
    if (hideBox) {
      hideBox.addEventListener('change', () => {
        if (!S.sel || S.sel.kind !== 'marker') return;
        S.sel.hideLabel = hideBox.checked;
        saveItems();
        syncPanel();
        requestDraw();
      });
    }

    const dotlessBox = $('#selDotless');
    if (dotlessBox) {
      dotlessBox.addEventListener('change', () => {
        if (!S.sel || S.sel.kind !== 'marker') return;
        S.sel.dotless = dotlessBox.checked;
        saveItems();
        syncPanel();
        requestDraw();
      });
    }

    const selAlpha = $('#selAlpha');
    if (selAlpha) {
      selAlpha.addEventListener('input', () => {
        if (!S.sel || S.sel.kind !== 'marker') return;
        S.sel.alpha = +selAlpha.value / 100;
        const lbl = $('#selAlphaVal');
        if (lbl) lbl.textContent = selAlpha.value + '%';
        saveItems();
        requestDraw();
      });
    }

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', e => {
      e.preventDefault();
      const p = localPoint(e);
      const w = toWorld(p);
      const hit = pickAt(w);
      const items = [];
      if (hit && hit.kind === 'marker') {
        items.push({ label: '复制「' + (hit.name || '点位') + '」', fn: () => { S.sel = hit; copySelected(); } });
      } else if (S.sel && S.sel.kind === 'marker') {
        items.push({ label: '复制「' + (S.sel.name || '点位') + '」', fn: copySelected });
      }
      if (clipItem) {
        items.push({ label: '粘贴「' + clipItem.name + '」到这里', fn: () => pasteMarker(w) });
      }
      if (hit) items.push({ label: '删除', fn: () => deleteItem(hit.id) });
      if (!items.length) items.push({ label: '（剪贴板为空）', fn: () => toast('先复制一个标点') });
      const r = cv.getBoundingClientRect();
      openMenu(r.left + p.x, r.top + p.y, items);
    });

    // 直接把截图粘 / 拖进来
    document.addEventListener('paste', e => {
      const d = e.clipboardData;
      if (!d) return;
      const items = d.items || [];
      for (let i = 0; i < items.length; i++) {
        if (/^image\//.test(items[i].type)) {
          const f = items[i].getAsFile();
          if (f) { handleUpload(f); e.preventDefault(); }
          return;
        }
      }
    });
    ['dragover', 'dragenter'].forEach(t => stage.addEventListener(t, e => {
      e.preventDefault();
      stage.classList.add('dropping');
    }));
    ['dragleave', 'dragend'].forEach(t => stage.addEventListener(t, e => {
      if (e.target === stage) stage.classList.remove('dropping');
    }));
    stage.addEventListener('drop', e => {
      e.preventDefault();
      stage.classList.remove('dropping');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleUpload(f);
    });
    cv.addEventListener('dblclick', e => {
      if (S.tool === 'route') { finishRoute(); return; }
      const p = localPoint(e);
      zoomAt(p, S.view.k * 1.6);
    });

    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', e => {
      if (e.code === 'Space') { S.space = false; if (!S.drag) stage.classList.remove('pan'); }
    });
    window.addEventListener('blur', () => { S.space = false; });

    if (window.ResizeObserver) {
      new ResizeObserver(() => resize()).observe(stage);
    } else {
      window.addEventListener('resize', resize);
    }
  }

  let menuEl = null;
  function onDocDown(ev) {
    if (menuEl && menuEl.contains(ev.target)) return;
    closeMenu();
  }
  function openMenu(x, y, items) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctxmenu';
    items.forEach(it => {
      const b = document.createElement('button');
      b.textContent = it.label;
      b.addEventListener('click', () => { closeMenu(); it.fn(); });
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    const w = menuEl.offsetWidth || 160;
    menuEl.style.left = Math.min(x, window.innerWidth - w - 10) + 'px';
    menuEl.style.top = y + 'px';
    setTimeout(() => document.addEventListener('pointerdown', onDocDown), 0);
  }
  function closeMenu() {
    document.removeEventListener('pointerdown', onDocDown);
    if (menuEl) {
      const m = menuEl;
      menuEl = null;
      m.remove();
    }
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    const cw = stage.clientWidth || 1;
    const ch = stage.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.cw = cw; S.ch = ch; S.dpr = dpr;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    if (S.map && !S.fitted) fitView();
    requestDraw();
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    buildSwatches();
    const customs = loadCustomMetas();
    if (lsGet(K_HIDDEN) === null && Array.isArray(window.TACMAP_DEFAULT_HIDDEN_MAPS)) {
      saveHiddenMapIds(window.TACMAP_DEFAULT_HIDDEN_MAPS.slice());
    }
    const hidden = hiddenMapIds();
    const builtin = builtinMaps().filter(m => hidden.indexOf(m.id) < 0);
    S.maps = builtin.map(m => prepareMap(m, false));
    customs.forEach(c => {
      const m = prepareMap(c, true);
      m.img = null;
      S.maps.push(m);
      hydrateCustom(m);
    });
    buildTabs();
    bindUI();
    setTool('view');
    let startId = S.maps[0].id;
    try {
      const h = decodeURIComponent(location.hash.slice(1));
      if (h && S.maps.some(m => m.id === h)) startId = h;
    } catch (e) {}
    selectMap(startId);
    window.addEventListener('hashchange', () => {
      const h = decodeURIComponent(location.hash.slice(1));
      if (h && S.maps.some(m => m.id === h) && S.map.id !== h) selectMap(h);
    });
    resize();
    requestDraw();
    // 首次访问的引导
    if (!lsGet('tacmap.seen.v1')) {
      lsSet('tacmap.seen.v1', '1');
      setTimeout(() => hint('滚轮缩放 · 拖拽平移 · 按 2 开始放标记'), 600);
    }
  }

  /* ---------------- 调试接口（供自检脚本使用） ---------------- */
  window.TACMAP = {
    state: S,
    get map() { return S.map; },
    setTool: setTool, setColor: setColor, select: select, addChipGroup: addChipGroup, buildChips: buildChips,
    copySelected: copySelected, pasteMarker: pasteMarker, restoreMaps: restoreMaps,
    placeMarker: placeMarker, pickAt: pickAt, toWorld: toWorld,
    fitView: fitView, requestDraw: requestDraw, finishRoute: finishRoute,
    undo: undo, redo: redo, exportPng: exportPng, deleteItem: deleteItem
  };

  window.addEventListener('error', e => {
    const el = $('#err');
    el.textContent = 'JS 错误：' + e.message + '\n' + (e.filename || '').split('/').pop() + ':' + e.lineno;
    el.classList.add('on');
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();






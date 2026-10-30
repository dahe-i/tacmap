/* 自检脚本：只在 URL 带 ?selftest=1 时运行，结果写进页面 DOM，方便无头浏览器核对 */
(function () {
  if (location.search.indexOf('selftest') < 0) return;

  const out = [];
  function ok(name, cond, extra) { out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : '')); }

  function fire(type, x, y, extra) {
    const cv = document.getElementById('cv');
    const r = cv.getBoundingClientRect();
    const ev = new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: r.left + x, clientY: r.top + y
    }, extra || {}));
    cv.dispatchEvent(ev);
  }

  function click(x, y) { fire('pointerdown', x, y); fire('pointerup', x, y); }
  function buildChipsSafe() {
    const T = window.TACMAP;
    if (T && T.state && T.state.map) { T.state.mergeMode = false; T.state.mergeSel = new Set(); }
    if (T && T.buildChips) T.buildChips();
  }

  function run() {
    const T = window.TACMAP;
    if (!T) { document.title = 'FAIL no-api'; return; }
    const S = T.state;

    const cv = document.getElementById('cv');

    ok('maps-loaded', S.maps.length >= 1, S.maps.map(m => m.id).join(','));
    ok('default-hidden-maps', S.maps.every(m => m.id === 'hajin'), S.maps.map(m => m.id).join(','));
    ok('current-map', S.map && S.map.id === 'hajin', S.map && S.map.id);
    ok('image-loaded', !!S.map.img && S.map.img.naturalWidth > 0, S.map.img && S.map.img.naturalWidth);
    ok('canvas-sized', cv.width > 100 && cv.height > 100, cv.width + 'x' + cv.height);
    ok('view-fitted', S.view.k > 0.1 && S.view.k < 2, 'k=' + S.view.k.toFixed(3));

    // 屏幕中心对应的世界点
    const cx = S.cw / 2, cy = S.ch / 2;

    // 1. 放标记
    const before = S.map.items.length;
    T.setColor('#c084fc');
    T.setTool('marker');
    click(cx + 40, cy + 40);
    ok('place-marker', S.map.items.length === before + 1, 'items=' + S.map.items.length);
    const newItem = S.map.items[S.map.items.length - 1];
    ok('marker-color', newItem && newItem.color === '#c084fc', newItem && newItem.color);
    ok('marker-selected', S.sel && S.sel.id === newItem.id);

    // 2. 选择工具点中它
    T.setTool('select');
    const w = T.toWorld({ x: cx + 40, y: cy + 40 });
    const hit = T.pickAt(w);
    ok('hit-test', !!hit && hit.id === newItem.id, hit && hit.kind);

    // 3. 拖动
    const oldX = newItem.x, oldY = newItem.y;
    fire('pointerdown', cx + 40, cy + 40);
    fire('pointermove', cx + 90, cy + 70);
    fire('pointerup', cx + 90, cy + 70);
    ok('drag-marker', Math.abs(newItem.x - oldX) > 5 || Math.abs(newItem.y - oldY) > 5,
      oldX.toFixed(0) + '->' + newItem.x.toFixed(0));

    // 4. 路线
    const routesBefore = S.map.items.filter(i => i.kind === 'route').length;
    T.setTool('route');
    click(cx - 100, cy + 60);
    click(cx - 40, cy + 20);
    T.finishRoute();
    const routesAfter = S.map.items.filter(i => i.kind === 'route').length;
    ok('create-route', routesAfter === routesBefore + 1, routesBefore + '->' + routesAfter);

    // 5. 撤销 / 重做
    const n1 = S.map.items.length;
    T.undo();
    const n2 = S.map.items.length;
    T.redo();
    const n3 = S.map.items.length;
    ok('undo-redo', n2 === n1 - 1 && n3 === n1, n1 + '/' + n2 + '/' + n3);

    // 6. 观察模式：拖动不移动点位
    T.setTool('view');
    const beforeView = S.map.items.find(i => i.id === newItem.id);
    const vx = beforeView.x, vy = beforeView.y;
    fire('pointerdown', cx + 40, cy + 40);
    fire('pointermove', cx + 120, cy + 90);
    fire('pointerup', cx + 120, cy + 90);
    ok('view-no-drag', beforeView.x === vx && beforeView.y === vy, 'x=' + beforeView.x.toFixed(0));

    // 7. 观察模式下点一下能选中
    T.setTool('view');
    T.select(null);
    const hitScreen = { x: (beforeView.x * S.view.k + S.view.x), y: (beforeView.y * S.view.k + S.view.y) };
    click(hitScreen.x, hitScreen.y);
    ok('view-select', !!S.sel && S.sel.id === newItem.id, S.sel && S.sel.kind);

    // 8. 删除
    T.setTool('select');
    T.select(newItem);
    const n4 = S.map.items.length;
    T.deleteItem(newItem.id);
    ok('delete-item', S.map.items.length === n4 - 1 && !S.map.items.some(i => i.id === newItem.id));

    // 9. 缩放
    const k1 = S.view.k;
    document.getElementById('zIn').click();
    ok('zoom-in', S.view.k > k1, k1.toFixed(2) + '->' + S.view.k.toFixed(2));
    T.fitView();
    ok('refit', S.view.k > 0.1, S.view.k.toFixed(3));

    // 9.2 复制 / 粘贴
    const beforeCopy = S.map.items.length;
    const srcItem = S.map.items.find(i => i.name && i.name.indexOf('点位') === 0) || S.map.items[0];
    T.select(srcItem);
    T.copySelected();
    T.pasteMarker({ x: 900, y: 900 });
    ok('copy-paste', S.map.items.length === beforeCopy + 1, beforeCopy + '->' + S.map.items.length);
    const pasted = S.map.items[S.map.items.length - 1];
    ok('paste-name', pasted.name === srcItem.name && pasted.color === (srcItem.color || pasted.color), pasted.name);
    T.deleteItem(pasted.id);

    // 9.5 自建文字标注进入筛选条
    T.setTool('marker');
    T.setColor('#22d3ee');
    click(cx + 120, cy - 100);
    const custom = S.map.items[S.map.items.length - 1];
    T.select(custom);
    document.getElementById('selName').value = '测试标注';
    document.getElementById('selName').dispatchEvent(new Event('input', { bubbles: true }));
    const chipTexts = Array.from(document.querySelectorAll('#chips .chip')).map(b => b.textContent);
    ok('custom-chip', chipTexts.some(t => t.indexOf('测试标注') >= 0), chipTexts.join('|'));
    T.hideChipForText = null;
    T.deleteItem(custom.id);

    // 9.8 分类合并（在筛选条里合并，不动地图）
    const keysForMerge = Array.from(new Set(S.map.items
      .filter(i => i.kind === 'marker' && i.name).map(i => 't:' + i.name))).slice(0, 2);
    T.addChipGroup('测试分类', keysForMerge);
    const chipNames = Array.from(document.querySelectorAll('#chips .chip')).map(c => c.textContent);
    ok('chip-merge', chipNames.some(n => n.indexOf('测试分类') >= 0), chipNames.join('|').slice(0, 80));
    const groupChip = Array.from(document.querySelectorAll('#chips .chip')).find(c => c.textContent.indexOf('测试分类') >= 0);
    groupChip.click();
    ok('group-toggle', S.hidden.size >= 2, 'hidden=' + S.hidden.size);
    S.chipGroups = [];
    S.hidden.clear();
    buildChipsSafe();
    ok('group-clear', document.querySelectorAll('#chips .chip.group').length === 0, 'ok');

    // 10. 切图（码头/训练场默认被隐藏，先恢复再测）
    if (T.restoreMaps) T.restoreMaps();
    const tabs = document.querySelectorAll('.map-tab');
    ok('tabs', tabs.length >= 3, String(tabs.length));
    ok('default-hajin', S.map.id === 'hajin', S.map.id);
    ok('hajin-points', S.map.items.length >= 50, String(S.map.items.length));
    ok('hajin-cats', !!(S.map.categories && S.map.categories.length === 8), String(S.map.categories && S.map.categories.length));
    ok('chips-rendered', document.querySelectorAll('#chips .chip').length >= 9, String(document.querySelectorAll('#chips .chip').length));
    tabs[2].click();
    ok('switch-map', S.map.id === 'range', S.map.id);
    ok('switch-items', S.map.items.length > 0, String(S.map.items.length));
    ok('chips-for-labels', !document.getElementById('chips').hidden, 'visible');
    tabs[0].click();
    ok('switch-back', S.map.id === 'hajin', S.map.id);

    // 11. 网格坐标
    const c = T.state.map && T.toWorld({ x: cx, y: cy });
    ok('world-point', !!c && isFinite(c.x) && isFinite(c.y));

    // 调试用：?selftest=1&hold=1 保留一个选中状态，方便截图核对面板
    if (location.search.indexOf('hold') >= 0) {
      T.setTool('select');
      const pick = S.map.items.filter(i => i.kind === 'marker')[2] || S.map.items[0];
      T.select(pick);
      T.requestDraw();
    }

    const fails = out.filter(l => l.indexOf('FAIL') === 0).length;    const box = document.createElement('pre');
    box.id = 'selftest-result';
    box.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#000;color:#0f0;font:11px/1.4 monospace;padding:8px;max-height:100%;overflow:auto;white-space:pre-wrap';
    box.textContent = 'SELFTEST ' + (fails ? 'FAILED ' + fails : 'ALL PASS') + ' (' + out.length + ')\n' + out.join('\n');
    document.body.appendChild(box);
    document.title = 'SELFTEST ' + (fails ? 'FAILED ' + fails : 'ALL PASS');
    box.style.display = 'none';
  }

  window.addEventListener('load', () => setTimeout(run, 400));
})();









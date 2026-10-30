/* 地图与默认标注数据（示意图为程序绘制的原创底图） */
(function () {
  window.MAPS = [
    {
      id: 'dock',
      name: '码头',
      desc: '集装箱堆场 · 近距离缠斗',
      src: 'assets/maps/dock.jpg',
      size: 2048,
      grid: { cols: 10, rows: 10 },
      meters: 300,
      items: [
        { id: 'd1', kind: 'marker', color: '#4da3ff', x: 320, y: 1830, name: '红方出生', desc: '南侧通道，出门先看东侧箱缝' },
        { id: 'd2', kind: 'marker', color: '#4da3ff', x: 1760, y: 230, name: '蓝方出生', desc: '' },
        { id: 'd3', kind: 'marker', color: '#ffb020', x: 1030, y: 1140, name: '中央油罐', desc: '全场最快碰头点，绕罐走别正面进' },
        { id: 'd4', kind: 'marker', color: '#3ddc97', x: 700, y: 760, name: '北排箱区', desc: '箱间夹道，卡住南北向过点' },
        { id: 'd5', kind: 'marker', color: '#c084fc', x: 1520, y: 250, name: '龙门吊', desc: '能看整条中央通道，但只有一个出口' },
        { id: 'd6', kind: 'marker', color: '#ff5470', x: 1030, y: 1690, name: '南侧开阔地', desc: '无掩体，过点前先排掉 A 区高处' },
        {
          id: 'd7', kind: 'route', color: '#ff7a1a', name: '红方快速推进',
          pts: [{ x: 320, y: 1830 }, { x: 620, y: 1560 }, { x: 700, y: 1240 }, { x: 900, y: 1180 }, { x: 1030, y: 1140 }]
        }
      ]
    },
    {
      id: 'range',
      name: '训练场',
      desc: '室内外混合 · 长枪线',
      src: 'assets/maps/range.jpg',
      size: 2048,
      grid: { cols: 10, rows: 10 },
      meters: 320,
      items: [
        { id: 'r1', kind: 'marker', color: '#4da3ff', x: 300, y: 1760, name: '南侧出生', desc: '' },
        { id: 'r2', kind: 'marker', color: '#ffb020', x: 950, y: 950, name: '主楼中庭', desc: '三条入口，注意二层窗' },
        { id: 'r3', kind: 'marker', color: '#c084fc', x: 1620, y: 300, name: '北侧塔楼', desc: '覆盖东西主路，怕绕后' },
        { id: 'r4', kind: 'marker', color: '#3ddc97', x: 1560, y: 620, name: '沙袋阵', desc: '低姿态射击位，右侧有硬掩体' },
        { id: 'r5', kind: 'marker', color: '#22d3ee', x: 1750, y: 1310, name: '东侧补给', desc: '' },
        { id: 'r6', kind: 'marker', color: '#ff5470', x: 1120, y: 480, name: '主路横切', desc: '横穿主路是这片最危险的一步' },
        {
          id: 'r7', kind: 'route', color: '#3ddc97', name: '绕后路线',
          pts: [{ x: 300, y: 1760 }, { x: 420, y: 1400 }, { x: 700, y: 1280 }, { x: 1180, y: 1300 }, { x: 1420, y: 1100 }, { x: 1620, y: 700 }]
        }
      ]
    }
  ];
})();



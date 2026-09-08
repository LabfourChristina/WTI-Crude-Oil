/* ============================================================
 * chart.js — Canvas 蜡烛图渲染
 * 依赖：window.OIL_DATA（data.js）; 配合 game/ui 模块调用 render(dayIdx)
 * 功能：红涨绿跌、网格/时间轴、最新价虚线、十字光标与 OHLC 提示、
 *      随进度逐根向右增长；滚轮/捏合缩放、拖动与触控板横向手势平移，
 *      全部手动控制——可把最新部分一路拖到最左（右侧留白），
 *      拖到任意位置/缩放后均不会自动回弹或复位。
 * ============================================================ */
(function () {
  "use strict";

  const CANDLES = (window.OIL_DATA && window.OIL_DATA.candles) || [];
  const UP = "#ff4d4f";
  const DOWN = "#00c48c";
  const GRID = "rgba(148,163,184,0.09)";
  const TEXT = "rgba(154,167,189,0.85)";
  const CROSS = "rgba(255,255,255,0.5)";

  let canvas, ctx, dpr, W = 0, H = 0;
  let spacing = 7;        // 每根蜡烛槽宽 px
  let leftIdx = 0;        // 当前可视最左蜡烛
  let hoverIdx = -1;      // 十字光标所在蜡烛
  let mouseX = -1, mouseY = -1;
  let dragging = false, lastDragX = 0, followRight = true;
  let dayIdx = 0;

  const PAD = { top: 12, right: 8, bottom: 24, left: 60 };

  const el = {
    open: null, high: null, low: null, close: null,
    pct: null, date: null
  };

  /* ---------- 工具 ---------- */
  function fmt(d, short) {
    const [y, m, day] = d.split("-");
    return short ? `${m}-${day}` : `${y}-${m}-${day}`;
  }
  function niceTicks(lo, hi, n) {
    const span = hi - lo;
    if (span <= 0) return [lo, hi, 1];
    const rawStep = span / Math.max(1, n - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const t0 = Math.ceil(lo / step) * step;
    const out = [];
    for (let v = t0; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  function resize() {
    if (!canvas) return;
    const box = canvas.parentElement;
    if (!box) return;
    dpr = window.devicePixelRatio || 1;
    W = box.clientWidth;
    H = box.clientHeight;
    if (W < 20 || H < 20) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* 可视范围（当前进度 dayIdx，最右为准） */
  function plotW() { return W - PAD.left - PAD.right; }
  function visibleCount() {
    const n = Math.max(1, Math.floor(plotW() / spacing));
    return Math.min(dayIdx + 1, n);
  }
  /* 自由平移边界：左界为 0；右界放宽到「最新蜡烛贴住视口最左」，
     即允许把最新部分一路拖到最左边，最新蜡烛右侧的槽位留空 */
  function clampView() {
    const total = dayIdx + 1;
    leftIdx = Math.max(0, Math.min(leftIdx, Math.max(0, total - 1)));
  }
  function keepView() {
    const total = dayIdx + 1;
    const vc = visibleCount();
    if (followRight) {
      leftIdx = Math.max(0, total - vc);   // 跟随模式：最新蜡烛位于右缘
      return;
    }
    clampView();
  }
  /* 最新蜡烛恰好贴住右缘时对应的 leftIdx */
  function rightEdge() {
    return Math.max(0, dayIdx + 1 - visibleCount());
  }

  function xOf(i) {
    return PAD.left + (i - leftIdx + 0.5) * spacing;
  }
  function idxOfX(x) {
    const i = Math.floor((x - PAD.left) / spacing) + leftIdx;
    if (i > dayIdx) {
      const total = dayIdx + 1;
      const vc = visibleCount();
      // 最新蜡烛右侧确实留白 → 无蜡烛；仅在右缘贴边（无留白）时收拢到最新一根
      return leftIdx > total - vc ? -1 : dayIdx;
    }
    return Math.max(0, i);
  }

  /* ---------- 绘制 ---------- */
  function draw() {
    if (!ctx || !W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const total = dayIdx + 1;
    if (!total) return;

    // 收集可见蜡烛
    keepView();
    const start = leftIdx;
    const end = Math.min(dayIdx, leftIdx + Math.floor(plotW() / spacing));

    // 价格区间
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i <= end; i++) {
      const c = CANDLES[i];
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    if (!isFinite(lo) || !isFinite(hi)) { lo = 50; hi = 80; }
    const padPct = Math.max((hi - lo) * 0.08, 0.6);
    lo -= padPct; hi += padPct;
    const priceH = H - PAD.top - PAD.bottom;

    const yOf = (p) => PAD.top + priceH * (1 - (p - lo) / (hi - lo));

    // 网格与价格轴
    ctx.font = "10px Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const ticks = niceTicks(lo, hi, Math.max(3, Math.floor(priceH / 52)));
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (const t of ticks) {
      const y = yOf(t);
      if (y < PAD.top - 4 || y > H - PAD.bottom + 4) continue;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.stroke();
      ctx.fillStyle = TEXT;
      ctx.fillText(t.toFixed(2), 4, y);
    }

    // 蜡烛
    const bodyW = Math.max(1.2, spacing * 0.7);
    for (let i = start; i <= end; i++) {
      const c = CANDLES[i];
      const x = xOf(i);
      const up = c.c >= c.o;
      const col = up ? UP : DOWN;
      const yO = yOf(c.o);
      const yC = yOf(c.c);
      const yH = yOf(c.h);
      const yL = yOf(c.l);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      // 影线
      ctx.beginPath();
      ctx.moveTo(x, yH);
      ctx.lineTo(x, yL);
      ctx.stroke();
      // 实体
      const top = Math.min(yO, yC);
      const hgt = Math.max(1.2, Math.abs(yC - yO));
      ctx.fillRect(x - bodyW / 2, top, bodyW, hgt);
    }

    // 最新价虚线 + 右侧标签
    const last = CANDLES[dayIdx];
    const yLast = yOf(last.c);
    const lastUp = last.c >= (CANDLES[dayIdx - 1] ? CANDLES[dayIdx - 1].c : last.c);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = lastUp ? UP : DOWN;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(PAD.left, yLast);
    ctx.lineTo(W - PAD.right, yLast);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lastUp ? UP : DOWN;
    const label = last.c.toFixed(2);
    const lw = ctx.measureText(label).width + 8;
    ctx.fillStyle = lastUp ? UP : DOWN;
    ctx.fillRect(W - PAD.right - lw, yLast - 8, lw, 16);
    ctx.fillStyle = "#0b0f1a";
    ctx.textAlign = "right";
    ctx.fillText(label, W - PAD.right - 4, yLast + 0.5);
    ctx.restore();

    // 时间轴
    ctx.textAlign = "center";
    ctx.fillStyle = TEXT;
    const tickStep = Math.max(1, Math.ceil((spacing < 4 ? 28 : 44) / spacing));
    for (let i = start; i <= end; i += tickStep) {
      if ((i - start) % tickStep !== 0) continue;
      const x = xOf(i);
      const c = CANDLES[i];
      ctx.fillText(fmt(c.d, true), x, H - 8);
    }

    // 边框
    ctx.strokeStyle = GRID;
    ctx.strokeRect(PAD.left + 0.5, PAD.top + 0.5, plotW() - 1, priceH - 1);

    // 十字光标
    if (hoverIdx >= start && hoverIdx <= end && mouseX > PAD.left && mouseX < W - PAD.right && !dragging) {
      const x = xOf(hoverIdx);
      ctx.save();
      ctx.strokeStyle = CROSS;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top); ctx.lineTo(x, H - PAD.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(PAD.left, mouseY); ctx.lineTo(W - PAD.right, mouseY);
      ctx.stroke();
      ctx.restore();
      setLegend(hoverIdx);
    } else {
      setLegend(dayIdx);
    }

  }

  /* 更新 OHLC 图例文字（颜色跟随蜡烛涨跌：红涨绿跌），
     并在收价右侧追加当日涨跌幅与该日日期 */
  function setLegend(i) {
    if (!el.open || !el.high || !el.low || !el.close) return;
    const c = CANDLES[i];
    if (!c) return;
    const up = c.c >= c.o;
    const cls = up ? "up-c" : "down-c";
    el.open.textContent = c.o.toFixed(2);
    el.high.textContent = c.h.toFixed(2);
    el.low.textContent = c.l.toFixed(2);
    el.close.textContent = c.c.toFixed(2);
    el.open.className = cls;
    el.high.className = cls;
    el.low.className = cls;
    el.close.className = cls;

    // 涨跌幅：相对前一根收盘价（首根无前值时按当日开盘计）
    const prev = i > 0 ? CANDLES[i - 1].c : c.o;
    const pct = prev > 0 ? ((c.c - prev) / prev) * 100 : 0;
    const pctUp = pct >= 0;
    if (el.pct) {
      el.pct.textContent = (pctUp ? "+" : "") + pct.toFixed(2) + "%";
      el.pct.className = pctUp ? "up-c" : "down-c";
    }
    if (el.date) {
      el.date.textContent = fmt(c.d);
    }
  }

  /* ---------- 交互 ---------- */
  /* 滚轮/捏合：纯手动。
   *  - 触控板双指左右滑、Shift+滚轮 → 水平平移（不再触发缩放，杜绝"拖动时自动放大"）
   *  - 纵向滚轮、Ctrl/Cmd+滚轮、捏合 → 以光标为圆心缩放
   * 缩放后视图完全保持手动结果：已在自由平移状态时绝不再吸附回右缘、不复位。 */
  function onWheel(e) {
    e.preventDefault();
    const pxY = e.deltaY || 0;
    const pxX = e.deltaX || 0;
    let panPx = 0;
    if (e.shiftKey) panPx = pxY || pxX;
    else if (Math.abs(pxX) > Math.abs(pxY)) panPx = pxX;
    if (panPx) {                            // 平移手势
      followRight = false;                  // 手动平移：解除右缘跟随
      leftIdx -= Math.round(panPx / spacing);
      clampView();
      if (leftIdx === rightEdge()) followRight = true; // 恰好贴回右缘才恢复（不产生位移）
      draw();
      return;
    }
    if (!pxY) return;                       // 空滚轮事件忽略，避免误缩放
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const wasFollow = followRight;
    const mxL = mx - PAD.left;
    const ns = Math.max(3, Math.min(26, spacing * (pxY < 0 ? 1.12 : 0.89)));
    if (ns === spacing) return;             // 已达缩放边界
    if (wasFollow) {
      spacing = ns;
      leftIdx = rightEdge();                // 原本就在跟随态：缩放后最新蜡烛继续贴右缘
    } else {
      // 手动平移态缩放：光标下的时间坐标保持原位（落在最新右侧留白时以最新为上限）
      const anchorTime = Math.min(dayIdx, leftIdx + mxL / spacing);
      spacing = ns;
      leftIdx = Math.max(0, Math.round(anchorTime - mxL / spacing));
      clampView();                          // 只做边界修正，绝不吸附/复位
    }
    draw();
  }
  function onDown(e) {
    dragging = true;
    lastDragX = e.clientX;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    const rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
    if (dragging) {
      followRight = false;                 // 一旦拖动即解除右缘跟随，进入自由平移
      const dx = mouseX - lastDragX;
      lastDragX = mouseX;
      leftIdx -= Math.round(dx / spacing); // 向左拖 → leftIdx 增大 → 最新蜡烛向左移
      clampView();                         // 最新蜡烛可一路拖到视口最左（右端留白）
    } else {
      hoverIdx = idxOfX(mouseX);
      if (hoverIdx < leftIdx || hoverIdx > leftIdx + Math.floor(plotW() / spacing)) hoverIdx = -1;
    }
    draw();
  }
  function onUp() {
    dragging = false;
    // 松手不做任何吸附/回弹；仅在最新蜡烛恰好贴住右缘（用户手动拖回）时恢复跟随
    if (leftIdx === rightEdge()) followRight = true;
    draw();
  }
  function onLeave() { hoverIdx = -1; mouseX = -1; mouseY = -1; dragging = false; draw(); }

  /* ---------- API ---------- */
  const Chart = {
    init(opts) {
      canvas = document.getElementById("chart");
      ctx = canvas.getContext("2d");
      // 声明手势全部由本图接管：触屏拖动只平移、双指捏合才缩放，禁止页面自动缩放
      canvas.style.touchAction = "none";
      if (opts) {
        el.open = opts.open; el.high = opts.high;
        el.low = opts.low; el.close = opts.close;
        el.pct = opts.pct || null; el.date = opts.date || null;
      }
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointerleave", onLeave);
      window.addEventListener("resize", () => { resize(); draw(); });
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => { resize(); draw(); });
        ro.observe(canvas.parentElement);
      }
      resize();
      return Chart;
    },
    render(i) {
      if (typeof i === "number" && i !== dayIdx) {
        // 常规逐日推进(i=+1)：尊重当前视图——跟随态则新蜡烛自动贴右缘，
        // 手动平移态则留在原地，只让新蜡烛在数据末端长出来；
        // 非逐日跳转（开局/重置/随机锚点）才重新贴右缘跟随
        if (i !== dayIdx + 1) followRight = true;
        dayIdx = i;
      }
      resize();
      draw();
      return Chart;
    },
    getLast() { return CANDLES[dayIdx]; },
    get candleCount() { return CANDLES.length; },
    getCandle(i) { return CANDLES[i]; }
  };
  window.Chart = Chart;
})();

/* ============================================================
 * ui.js — DOM 联动与流程编排
 * 依赖：data.js → game.js → chart.js 依次加载后运行本文件
 * 职责：HUD/持仓/现金渲染、交易与低利贷弹窗、新闻列表与红点、
 *       下一天事件播报（强平/重大新闻/结局）、重新开始。
 * ============================================================ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const G = window.Game;
  const Chart = window.Chart;
  if (!G || !Chart) return;

  /* ---------- DOM 引用 ---------- */
  const el = {
    date: $("chartDate"),
    price: $("chartPrice"),
    change: $("chartChange"),
    cash: $("cashAmt"),
    net: $("netWorth"),
    newsDot: $("newsDot"),
    // 持仓
    long: { card: $("posLongCard"), amt: $("longAmt"), lev: $("longLev"), pnl: $("longPnl"), sub: $("longSub") },
    short: { card: $("posShortCard"), amt: $("shortAmt"), lev: $("shortLev"), pnl: $("shortPnl"), sub: $("shortSub") },
    // 弹窗
    trade: $("modalTrade"),
    loan: $("modalLoan"),
    news: $("modalNews"),
    flash: $("modalNewsFlash"),
    liq: $("modalLiquidation"),
    gameover: $("modalGameOver")
  };

  /* ---------- 通用 ---------- */
  function money(x) {
    const s = Math.abs(x).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (x < 0 ? "-" : "") + "¥" + s;
  }
  function fmtDate(d) {
    const [y, m, dd] = d.split("-");
    return Number(y) + "年" + Number(m) + "月" + Number(dd) + "日";
  }
  function show(id) { id.hidden = false; }
  function hide(id) { id.hidden = true; }
  function toast(msg, isErr, target) {
    const w = target || $("toastWrap");
    if (target === $("loanToastWrap")) w.replaceChildren();
    const t = document.createElement("div");
    t.className = "toast" + (isErr ? " err" : " ok");
    t.textContent = msg;
    w.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = ".4s"; }, 2600);
    setTimeout(() => t.remove(), 3200);
  }

  /* ---------- 主渲染 ---------- */
  function renderAll() {
    const idx = G.dayIdx();
    const c = G.candles[idx];
    if (!c) return;

    // 日期与价格
    el.date.textContent = fmtDate(c.d);
    const prev = idx > 0 ? G.candles[idx - 1].c : c.o;
    const chg = c.c - prev;
    const pct = prev > 0 ? (chg / prev) * 100 : 0;
    const up = chg >= 0;
    el.price.textContent = c.c.toFixed(2);
    el.price.className = "hud-price " + (up ? "up-c" : "down-c");
    el.change.textContent = (up ? "+" : "") + chg.toFixed(2) + " (" + (up ? "+" : "") + pct.toFixed(2) + "%)";
    el.change.className = "hud-change " + (up ? "up-c" : "down-c");

    // 持仓两方向
    renderDir("long", el.long, "买多");
    renderDir("short", el.short, "买空");

    // 现金与净值
    const cash = G.cash();
    el.cash.textContent = money(cash);
    el.cash.classList.toggle("danger", cash <= 0.005);
    const net = G.netWorth();
    el.net.textContent = money(net);
    el.net.classList.toggle("danger", net < 0);

    // 新闻红点
    el.newsDot.hidden = G.unreadImportantCount() <= 0;

    // 图表
    Chart.render(idx);
  }

  function renderDir(dir, box, label) {
    const info = dir === "long" ? G.long() : G.short();
    const hasPos = info.M > 0.005;
    // 大字 = 方向现值（权益 E）
    box.amt.textContent = money(info.E);
    box.amt.classList.toggle("up-c", hasPos && info.pnl >= 0);
    box.amt.classList.toggle("down-c", hasPos && info.pnl < 0);
    box.lev.textContent = hasPos ? info.L + " 倍杠杆" : "-- 倍杠杆";
    if (hasPos) {
      box.pnl.textContent =
        (info.pnl >= 0 ? "浮盈 " : "浮亏 ") + money(Math.abs(info.pnl)) + "（" + info.pnlPct.toFixed(2) + "%）";
      box.pnl.className = "pos-pnl " + (info.pnl >= 0 ? "up-c" : "down-c");
      box.sub.textContent = "保证金 " + money(info.M) + " · 入场参考 " + info.entry.toFixed(2);
    } else {
      box.pnl.textContent = "浮盈亏 --";
      box.pnl.className = "pos-pnl muted";
      box.sub.textContent = "保证金 ¥0.00 · 入场参考 --";
    }
    // 接近强平危险态（浮亏 ≥ 85% 保证金）
    const danger = hasPos && info.pnl < 0 && (info.M > 0 && (-info.pnl) / info.M >= 0.85);
    box.card.classList.toggle("pos-danger", danger);
    // 无持仓时卡片淡显
    box.card.classList.toggle("pos-empty", !hasPos);
  }

  /* ---------- 交易弹窗 ---------- */
  let trade = { dir: "long", sell: false, lever: 1 };

  function openTrade(dir, sell) {
    if (G.isOver()) return toast("游戏已结束，请重新开始", true);
    const info = dir === "long" ? G.long() : G.short();
    if (sell && info.M <= 0.005) return toast("该方向没有持仓，无需平仓", true);

    trade.dir = dir;
    trade.sell = sell;
    const isLong = dir === "long";
    const verb = sell ? (isLong ? "卖多" : "卖空") : (isLong ? "买多" : "买空");
    $("tradeTitle").textContent = verb;
    $("btnTradeOk").textContent = sell ? "确认平仓" : "确认下单";
    $("tradeAmountLabel").textContent = sell ? "平仓金额（元）" : "买入金额（元）";
    $("tradeAmount").value = "";
    $("tradeAmount").max = sell ? Math.max(0, info.E) : Math.max(0, G.cash());
    $("tradeAmount").placeholder = sell ? "最多 " + Math.floor(Math.max(0, info.E)) : "请输入金额";
    $("tradePrice").textContent = G.price().toFixed(2);
    $("tradeLeverField").hidden = sell;
    $("tradeRiskNote").hidden = sell;
    $("tradeLeverTip").textContent = info.M > 0.005 ? "（当前 " + info.L + " 倍，调档即生效于该方向全部持仓）" : "";

    trade.lever = info.L;
    syncLeverChips();
    updateTradeSummary();
    show(el.trade);
    setTimeout(() => $("tradeAmount").focus(), 60);
  }

  function syncLeverChips() {
    document.querySelectorAll("#leverChips button").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.l) === trade.lever);
    });
  }

  /* 杠杆胶囊：点击即时应用（可仅调杠杆不下单） */
  function onLeverPick(e) {
    const l = Number(e.currentTarget.dataset.l);
    trade.lever = l;
    syncLeverChips();
    const res = G.setLever(trade.dir, l);
    if (res.events && res.events.length) settleEvents(res.events);
    renderAll();
    // 若强平后已无仓且为卖模式，提示
    const info = trade.dir === "long" ? G.long() : G.short();
    if (trade.sell && info.M <= 0.005) {
      $("btnTradeOk").disabled = true;
    } else {
      $("btnTradeOk").disabled = false;
    }
    updateTradeSummary();
  }

  function updateTradeSummary() {
    const info = trade.dir === "long" ? G.long() : G.short();
    const amt = Number($("tradeAmount").value) || 0;
    const s = $("tradeSummary");
    const isLong = trade.dir === "long";
    if (trade.sell) {
      const E = info.E;
      if (!info.M) {
        s.innerHTML = "该方向已无可平仓位。";
      } else {
        const over = amt > E + 0.005;
        const f = E > 0 ? Math.min(1, amt / E) : 0;
        const realPnl = (E - info.M) * f;
        s.innerHTML =
          "当前可平价值 <b>" + money(E) + "</b><br>" +
          (amt > 0
            ? "本次回收约 <b>" + money(Math.min(amt, E)) + "</b>" +
              "　实现盈亏 <b class=\"" + (realPnl >= 0 ? "up-c" : "down-c") + "\">" + money(realPnl) + "</b>"
            : "输入金额后按比例平仓，未输入则代表本次平仓 " + money(E)) +
          (over ? "<br><span style='color:#ff4d4f'>已超过可平价值，请勿超额。</span>" : "");
      }
    } else {
      const cash = G.cash();
      if (amt <= 0) {
        s.innerHTML = "最新价 <b>" + G.price().toFixed(2) + "</b>　杠杆 <b>" + trade.lever + " 倍</b>，输入金额开仓。";
      } else if (amt > cash + 0.005) {
        s.innerHTML = "<span style='color:#ff4d4f'>金额超过存款余额，请勿超额。</span>";
      } else {
        const qty = amt / G.price();
        s.innerHTML =
          "保证金 <b>" + money(amt) + "</b> × 杠杆 <b>" + trade.lever + " 倍</b>" +
          " → 名义仓位约 <b>" + money(amt * trade.lever) + "</b><br>" +
          "约 <b>" + (isLong ? "做多" : "做空") + "</b> " + qty.toFixed(1) + " 桶 @" + G.price().toFixed(2) +
          "，价格每波动 1% 盈亏约 <b>" + money(amt * trade.lever * 0.01) + "</b>";
      }
    }
  }

  function confirmTrade() {
    const amt = $("tradeAmount").value;
    const info = trade.dir === "long" ? G.long() : G.short();
    if (trade.sell) {
      if (info.M <= 0.005) return toast("该方向没有持仓", true);
      const res = G.close(trade.dir, amt);
      if (!res.ok) return toast(res.msg, true);
      hide(el.trade);
      toast(res.msg, false);
    } else {
      const res = G.open(trade.dir, amt, trade.lever);
      if (!res.ok) return toast(res.msg, true);
      hide(el.trade);
      toast(res.msg, false);
    }
    renderAll();
  }

  /* ---------- 低利贷 ---------- */
  function openLoan() {
    if (G.isOver()) return toast("游戏已结束，请重新开始", true);
    refreshLoan();
    $("loanBorrowAmt").value = "";
    $("loanRepayAmt").value = "";
    show(el.loan);
  }
  function refreshLoan() {
    $("loanAvailable").textContent = money(G.loanAvailable());
    $("loanOwed").textContent = money(G.owed());
    $("btnLoanRepayAll").disabled = G.owed() <= 0.005;
  }
  function doBorrow() {
    const res = G.borrow($("loanBorrowAmt").value);
    if (!res.ok) return toast(res.msg, true);
    $("loanBorrowAmt").value = "";
    refreshLoan();
    renderAll();
    toast(res.msg);
  }
  function doRepay() {
    const res = G.repay($("loanRepayAmt").value);
    if (!res.ok) return toast(res.msg, true);
    $("loanRepayAmt").value = "";
    refreshLoan();
    renderAll();
    toast(res.msg);
  }
  function doRepayAll() {
    if (G.owed() <= 0.005) return toast("暂无应还金额", true);
    $("loanRepayAmt").value = G.owed();
    doRepay();
  }

  /* ---------- 新闻 ---------- */
  function openNews() {
    if (G.isOver()) return toast("游戏已结束，请重新开始", true);
    const list = G.newsUpToNow();
    const box = $("newsList");
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="news-empty">还没有新闻，点击“下一天”推进时间线吧。</div>';
    } else {
      list.forEach((n, i) => {
        const row = document.createElement("div");
        row.className = "news-item" + (n.important ? " important" : "");
        row.innerHTML =
          '<span class="nd">' + n.d + "</span>" +
          '<span class="nt">' + n.title + "</span>" +
          (n.important ? '<span class="tag-imp">重要</span>' : "");
        box.appendChild(row);
      });
    }
    $("newsCountLabel").textContent = "共 " + list.length + " 条";
    show(el.news);
    // 查看即视为已读，红点熄灭
    G.markNewsSeen();
    el.newsDot.hidden = true;
  }

  /* ---------- 事件播报（强平 / 计息 / 重大新闻 / 结局） ---------- */
  function showLiquidation(dir, next) {
    const label = dir === "long" ? "多头（买多）" : "空头（买空）";
    $("liqText").textContent =
      label + "方向浮动亏损已耗尽全部保证金" +
      (dir === "long" ? "，价格跌幅" : "，价格涨幅") + "超过安全边际，" +
      "系统已按当日收盘价强制平仓。若亏损超出保证金，差额已从你的现金中扣除。";
    show(el.liq);
    $("btnLiqOk").onclick = () => { hide(el.liq); next && next(); };
  }

  function showFlash(titles, next) {
    if (!titles.length) return next && next();
    const first = titles[0];
    const more = titles.length - 1;
    $("flashText").innerHTML =
      "<b>" + escapeHtml(first) + "</b>" +
      (more > 0 ? "<br>（另有 " + more + " 条同日新闻，可在列表查看）" : "");
    show(el.flash);
    $("btnFlashClose").onclick = () => {
      hide(el.flash);
      next && next();
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  }

  function showGameOver(reason) {
    const isLoan = reason === "loan";
    $("goTitle").textContent = isLoan ? "你还不起低利贷了，天台见！" : "你没有钱了，天台见！";
    $("goText").innerHTML = isLoan
      ? "低利贷的利息日复一日滚动，最终欠款超出了存款余额与持仓净值之和。<br>资金链彻底断裂——天台的风很冷，请节哀。"
      : "存款余额与持仓净值之和归零，市场没有给你留下任何机会。<br>天台的风很冷，请节哀。";
    show(el.gameover);
    renderAll();
  }

  function onRestart() {
    G.reset();
    [el.trade, el.loan, el.news, el.flash, el.liq, el.gameover].forEach(hide);
    renderAll();
    toast("重新开始，初始资金 ¥200,000", false);
  }

  /* 下一天 → 结算事件排队播报 */
  function onNextDay() {
    if (G.isOver()) return toast("游戏已结束，请重新开始", true);
    const res = G.nextDay();
    renderAll();
    if (!res.ok) return toast(res.msg, true);
    settleEvents(res.events);
  }

  function settleEvents(events) {
    const overE = events.find((e) => e.type === "over");
    if (overE) {
      showGameOver(overE.reason);
      return;
    }
    const loanE = events.find((e) => e.type === "loan");
    if (loanE && loanE.interest > 0) {
      toast(
        "低利贷已自动计息 +" + money(loanE.interest) + "，利息并入欠款继续滚息",
        false,
        $("loanToastWrap")
      );
    }
    const liqs = events.filter((e) => e.type === "liq");

    const stepLiq = () => {
      if (!liqs.length) return stepNews();
      const dir = liqs.shift().dir;
      showLiquidation(dir, () => { renderAll(); stepLiq(); });
    };
    const stepNews = () => {
      const titles = G.flashTitles();
      if (!titles.length) return stepEnd();
      showFlash(titles, () => {
        G.markNewsSeen();
        stepEnd();
      });
    };
    const stepEnd = () => {
      renderAll();
    };
    stepLiq();
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    // 下一天
    $("btnNextDay").addEventListener("click", onNextDay);

    // 新闻
    $("btnNews").addEventListener("click", openNews);

    // 交易入口（大按钮 + 矩阵 + 卡片卖单）
    $("btnBuyLong").addEventListener("click", () => openTrade("long", false));
    $("btnSellLong").addEventListener("click", () => openTrade("long", true));
    $("btnBuyShort").addEventListener("click", () => openTrade("short", false));
    $("btnSellShort").addEventListener("click", () => openTrade("short", true));
    $("btnSellLongMini").addEventListener("click", () => openTrade("long", true));
    $("btnSellShortMini").addEventListener("click", () => openTrade("short", true));

    // 交易弹窗
    document.querySelectorAll("#quickAmt button").forEach((b) => {
      b.addEventListener("click", () => {
        const info = trade.dir === "long" ? G.long() : G.short();
        const base = trade.sell ? Math.max(0, info.E) : Math.max(0, G.cash());
        const v = Math.floor(base * Number(b.dataset.v) * 100) / 100;
        $("tradeAmount").value = v > 0 ? String(v) : "";
        updateTradeSummary();
      });
    });
    document.querySelectorAll("#leverChips button").forEach((b) => {
      b.addEventListener("click", onLeverPick);
    });
    $("tradeAmount").addEventListener("input", updateTradeSummary);
    $("btnTradeOk").addEventListener("click", confirmTrade);

    // 低利贷
    $("btnLoan").addEventListener("click", openLoan);
    $("btnLoanBorrow").addEventListener("click", doBorrow);
    $("btnLoanRepay").addEventListener("click", doRepay);
    $("btnLoanRepayAll").addEventListener("click", doRepayAll);

    // 重新开始
    $("btnRestart").addEventListener("click", onRestart);

    // 通用关闭按钮
    document.querySelectorAll("[data-close]").forEach((b) => {
      b.addEventListener("click", () => { hide($(b.dataset.close)); renderAll(); });
    });
  }

  /* ---------- 启动 ---------- */
  bind();
  Chart.init({ open: $("lblOpen"), high: $("lblHigh"), low: $("lblLow"), close: $("lblClose") });
  renderAll();
})();

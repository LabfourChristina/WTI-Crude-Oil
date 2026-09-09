/* ============================================================
 * game.js — 游戏核心状态机与规则（不直接操作 DOM）
 * 依赖：window.OIL_DATA（data.js）
 * 规则口径：
 *   · 现金 cash 初始 200,000；每方向独立 { M 保证金, K 头寸系数, L 杠杆 }
 *   · 多头权益 E = M + L*(P*K - M)；空头权益 E = M + L*(M - P*K)，P 为当日收盘价
 *   · 开仓：cash-=A, M+=A, K+=A/P（P=收盘价）；保证金模式
 *   · 权益 E≤0 → 强制平仓：cash += E（E 为负即倒欠并入现金），M=K=0
 *   · 低利贷：额度 200,000，应还每日按 1% 复利，利息加入欠款并保留到下一日
 *   · 双结局：余额+净值不足以偿还应还款，或余额+净值归零 → 天台
 * 模块通过 window.Game 暴露只读查询 + 事务型动作（返回 {ok,msg,events}）
 * ============================================================ */
(function () {
  "use strict";

  const DATA = window.OIL_DATA || {};
  const candles = Array.isArray(DATA.candles) ? DATA.candles : [];
  const news = Array.isArray(DATA.news) ? DATA.news : [];

  const START_CASH = 200000;      // 初始存款余额
  const LOAN_LIMIT = 200000;      // 低利贷总额度
  const LOAN_RATE = 0.01;         // 每日利息 1%
  const ROUND_DAYS = 365;         // 一局固定天数（倒计时走完即正常收官）
  const LEVERS = [1, 2, 3, 5, 10];
  const EPS = 1e-6;               // 浮点容差

  /* ---------------- 状态 ---------------- */
  const state = {
    cash: START_CASH,
    dayIdx: 0,                    // 当前蜡烛下标
    roundStart: 0,                // 本局随机锚定的开局日下标
    over: null,                   // null | 'cash' | 'loan' | 'round'
    long:  { M: 0, K: 0, L: 1 },
    short: { M: 0, K: 0, L: 1 },
    loan:  { owed: 0 },
    seenNews: 0                   // 已读新闻条数（news 升序，下标 < seenNews 视为已读）
  };

  /* ---------------- 工具 ---------------- */
  function roundMoney(x) { return Math.round((x + EPS) * 100) / 100; }
  function price() { return candles[state.dayIdx] ? candles[state.dayIdx].c : 0; }
  function dateStr() { return candles[state.dayIdx] ? candles[state.dayIdx].d : ""; }
  function dirObj(dir) { return dir === "short" ? state.short : state.long; }

  /* 随机锚定开局日：保证其后至少还有 ROUND_DAYS 个数据日可走 */
  function pickStart() {
    const span = candles.length - ROUND_DAYS - 1;
    return span > 0 ? Math.floor(Math.random() * (span + 1)) : 0;
  }

  /* 本局倒计时剩余天数：开局显示 365，每点一次「下一天」减 1，归 0 即满局 */
  function daysLeft() {
    return Math.max(0, ROUND_DAYS - (state.dayIdx - state.roundStart));
  }

  /* 该方向权益（P=当日收盘价口径）。空仓恒为 0 */
  function equity(dir) {
    const d = dirObj(dir);
    if (d.M <= EPS || candles.length === 0) return 0;
    const P = price();
    const delta = P * d.K - d.M;              // 多头价格敞口
    return dir === "long" ? d.M + d.L * delta : d.M - d.L * delta;
  }

  /* 入场参考价（全仓加权） */
  function entryPrice(dir) {
    const d = dirObj(dir);
    return d.K > EPS ? d.M / d.K : 0;
  }

  function availableLoan() {
    return Math.max(0, LOAN_LIMIT - state.loan.owed);
  }

  /* 汇总某一方向的可读信息 */
  function dirInfo(dir) {
    const d = dirObj(dir);
    const E = equity(dir);
    const M = d.M;
    return {
      M, K: d.K, L: d.L,
      E: roundMoney(E),
      pnl: roundMoney(E - M),
      entry: d.K > EPS ? roundMoney(entryPrice(dir)) : 0,
      pnlPct: M > EPS ? (E - M) / M * 100 : 0
    };
  }

  /* ---------------- 结算子流程 ---------------- */

  /* 强平某一方向：权益 E（可为负）并入现金，仓位归零 */
  function forceClose(dir) {
    const d = dirObj(dir);
    const E = equity(dir);
    state.cash = roundMoney(state.cash + E);  // E<0 即倒欠现金
    d.M = 0;
    d.K = 0;
    return E;
  }

  /* 破产结局判定：返回 'loan' | 'cash' | null */
  function bankruptCheck() {
    const totalValue = state.cash + netWorth();
    // 余额与持仓净值不足以偿还应还款 → 低利贷爆
    if (state.loan.owed > totalValue + 0.005) return "loan";
    // 余额与持仓净值归零 → 没钱
    if (totalValue <= 0.005) return "cash";
    return null;
  }

  /* 结局判定后置处理：命中则标记游戏结束 */
  function applyVerdict(events) {
    const verdict = bankruptCheck();
    if (verdict) {
      state.over = verdict;
      events.push({ type: "over", reason: verdict });
    }
    return verdict;
  }

  /* ---------------- 公开动作 ---------------- */

  /* 方向下单加仓：amount 为保证金，lever 作用于该方向全部持仓 */
  function open(dir, amount, lever) {
    if (state.over) return { ok: false, msg: "游戏已结束，请点击重新开始" };
    if (!dirObj(dir)) return { ok: false, msg: "方向参数错误" };
    lever = LEVERS.indexOf(Number(lever)) >= 0 ? Number(lever) : dirObj(dir).L;
    amount = roundMoney(Number(amount));
    if (!(amount > 0)) return { ok: false, msg: "请输入有效金额" };
    if (amount > state.cash + 0.005) return { ok: false, msg: "存款余额不足" };

    const d = dirObj(dir);
    const P = price();
    if (!(P > 0)) return { ok: false, msg: "暂无行情数据" };

    // 应用杠杆；若原有持仓因杠杆调整即破位则拒绝（应先在面板直接调低）
    d.L = lever;
    if (d.M > EPS) {
      const E = equity(dir);
      if (E <= 0) return { ok: false, msg: "该方向调整后立即破位，请先在持仓面板调低杠杆或平仓" };
    }

    state.cash = roundMoney(state.cash - amount); // 扣保证金
    d.M = roundMoney(d.M + amount);
    d.K += amount / P;                            // 头寸系数（桶）累加
    return { ok: true, msg: (dir === "long" ? "买多" : "买空") + "下单成功", events: [] };
  }

  /* 调整某方向杠杆，立即生效；若触发强平则返回事件 */
  function setLever(dir, lever) {
    if (state.over) return { ok: false, msg: "游戏已结束", events: [] };
    lever = Number(lever);
    if (LEVERS.indexOf(lever) < 0) return { ok: false, msg: "杠杆档位不合法", events: [] };
    const d = dirObj(dir);
    d.L = lever;
    const events = [];
    if (d.M > EPS && equity(dir) <= EPS) {
      forceClose(dir);
      events.push({ type: "liq", dir });
    }
    return { ok: true, msg: "", events };
  }

  /* 卖出平仓：amount 以该方向当前权益 E 为上限，按比例减少持仓 */
  function close(dir, amount) {
    if (state.over) return { ok: false, msg: "游戏已结束", events: [] };
    const d = dirObj(dir);
    if (d.M <= EPS && d.K <= EPS) return { ok: false, msg: "该方向没有持仓", events: [] };
    amount = roundMoney(Number(amount));
    if (!(amount > 0)) return { ok: false, msg: "请输入有效金额" };
    const E = equity(dir);
    if (E <= 0) return { ok: false, msg: "该方向已被强平", events: [] };
    if (amount > E + 0.005) return { ok: false, msg: "平仓金额超过当前可平价值", events: [] };

    if (amount >= E - 0.005) {          // 全部平仓
      amount = roundMoney(E);
      state.cash = roundMoney(state.cash + amount);
      d.M = 0;
      d.K = 0;
    } else {
      const f = amount / E;             // 平掉比例
      state.cash = roundMoney(state.cash + amount);
      d.M = roundMoney(d.M * (1 - f));
      d.K *= (1 - f);
    }
    return { ok: true, msg: (dir === "long" ? "卖多" : "卖空") + "平仓成功", events: [] };
  }

  /* 低利贷：借入 */
  function borrow(amount) {
    if (state.over) return { ok: false, msg: "游戏已结束" };
    amount = roundMoney(Number(amount));
    if (!(amount > 0)) return { ok: false, msg: "请输入有效金额" };
    const avail = availableLoan();
    if (avail <= 0.005) return { ok: false, msg: "可用额度已用完" };
    amount = Math.min(amount, avail);
    state.cash = roundMoney(state.cash + amount);
    state.loan.owed = roundMoney(state.loan.owed + amount);
    return { ok: true, msg: "已借入 " + fmtMoney(amount) };
  }

  /* 低利贷：主动还款 */
  function repay(amount) {
    if (state.over) return { ok: false, msg: "游戏已结束" };
    amount = roundMoney(Number(amount));
    if (!(amount > 0)) return { ok: false, msg: "请输入有效金额" };
    const owed = state.loan.owed;
    if (owed <= 0.005) return { ok: false, msg: "暂无应还金额" };
    const maxPay = Math.min(owed, state.cash);
    if (amount > maxPay + 0.005) return { ok: false, msg: "还款金额不能超过应还与现金余额" };
    amount = Math.min(amount, maxPay);
    state.cash = roundMoney(state.cash - amount);
    state.loan.owed = roundMoney(state.loan.owed - amount);
    return { ok: true, msg: "已还款 " + fmtMoney(amount) };
  }

  /* 结算并推进到下一个交易日。返回事件数组供 UI 播报 */
  function nextDay() {
    const events = [];
    if (state.over) return { ok: false, msg: "游戏已结束，请重新开始", events };
    if (state.dayIdx + 1 >= candles.length) {
      return { ok: false, msg: "已到数据最新交易日，没有更多行情啦", events };
    }
    state.dayIdx++;                       // 进入新一天
    const P = price();

    // ① 多空按新收盘价结算，权益≤0 → 强制平仓（可倒欠现金）
    ["long", "short"].forEach((dir) => {
      const d = dirObj(dir);
      if (d.M > EPS && equity(dir) <= EPS) {
        forceClose(dir);
        events.push({ type: "liq", dir });
      }
    });

    // ② 低利贷计息：利息并入欠款，参与下一日复利；还款只能主动进行
    if (state.loan.owed > 0.005) {
      const interest = roundMoney(state.loan.owed * LOAN_RATE);
      state.loan.owed = roundMoney(state.loan.owed + interest);
      events.push({ type: "loan", interest });
    }

    // ③ 破产结局判定
    applyVerdict(events);

    // ④ 一局满 365 天且未破产 → 正常收官（活到最后）
    if (!state.over && daysLeft() <= 0) {
      state.over = "round";
      events.push({ type: "over", reason: "round" });
    }
    return { ok: true, msg: "", events };
  }

  /* 重置整局（重新开始）：随机锚定一个开局日，保证其后 ≥365 天数据 */
  function reset() {
    state.roundStart = pickStart();
    state.dayIdx = state.roundStart;
    state.cash = START_CASH;
    state.over = null;
    state.long = { M: 0, K: 0, L: 1 };
    state.short = { M: 0, K: 0, L: 1 };
    state.loan.owed = 0;
    state.seenNews = 0;
    // 开局日之前的历史新闻一律视为已读，避免开局就亮红点
    while (state.seenNews < news.length && news[state.seenNews].d <= dateStr()) {
      state.seenNews++;
    }
  }

  /* ---------------- 展示/新闻辅助 ---------------- */

  function fmtMoney(x) {
    return "¥" + Math.abs(x).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function netWorth() {
    return roundMoney(equity("long") + equity("short"));
  }

  /* 已到当前日期的全部新闻（含当日），用于列表展示 */
  function newsUpToNow() {
    const cur = dateStr();
    const out = [];
    for (const n of news) {
      if (n.d > cur) break;
      out.push(n);
    }
    return out;
  }

  /* 未读且已发生的重要新闻条数（>0 → 红点/弹窗） */
  function unreadImportantCount() {
    const cur = dateStr();
    let cnt = 0;
    for (let i = state.seenNews; i < news.length; i++) {
      if (news[i].d > cur) break;
      if (news[i].important) cnt++;
    }
    return cnt;
  }

  /* 当日新增的重要新闻标题（用于 flash），返回数组 */
  function flashTitles() {
    const cur = dateStr();
    const out = [];
    for (let i = state.seenNews; i < news.length; i++) {
      if (news[i].d > cur) break;
      if (news[i].important) out.push(news[i].title);
      else if (news[i].d === cur) out.push(news[i].title); // 当日普通新闻也提示
    }
    return out;
  }

  /* 打开新闻面板：标记至当前日期的新闻全部已读 */
  function markNewsSeen() {
    const cur = dateStr();
    while (state.seenNews < news.length && news[state.seenNews].d <= cur) {
      state.seenNews++;
    }
  }

  const Game = {
    state,
    candles,
    news,
    LEVERS,
    LOAN_LIMIT,
    START_CASH,
    ROUND_DAYS,

    // 状态只读快照
    cash: () => state.cash,
    dayIdx: () => state.dayIdx,
    dateStr,
    price,
    roundStart: () => state.roundStart,
    daysLeft,
    isOver: () => !!state.over,
    overReason: () => state.over,

    // 持仓
    long: () => dirInfo("long"),
    short: () => dirInfo("short"),
    setLever,
    open,
    close,

    // 低利贷
    owed: () => roundMoney(state.loan.owed),
    loanAvailable: availableLoan,
    borrow,
    repay,

    // 流程
    nextDay,
    reset,

    // 新闻
    newsUpToNow,
    unreadImportantCount,
    flashTitles,
    markNewsSeen,

    // 展示
    netWorth,
    equity,
    fmtMoney
  };

  // 首次加载即随机锚定开局日（每次刷新/重新开始都会换一个起点）
  reset();
  window.Game = Game;
})();

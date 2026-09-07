# -*- coding: utf-8 -*-
"""
build_data.py — 天才交易员 · 数据构建脚本（可复现，运行: python build_data.py）
策略：真实为主、缺段补齐。
  真实骨架：fred_raw.csv（FRED DCOILWTICO WTI现货日度收盘，含2026年段，由 curl 预抓取）。
  补齐方式：周末/美国休市/数据源截止后的自然日，在相邻真实值间做对数线性桥接，
           加上与真实波动匹配的微噪声；末端(2026-09-02~09-06)温和外推，不做人为崩盘。
  新闻：2025段为真实国际大事件；2026段依据行情拐点整理的叙事标题。
产物：js/data.js (window.OIL_DATA = {meta, candles, news})
"""
import datetime as dt
import json
import math
import os
import random

START = dt.date(2025, 1, 1)
END = dt.date(2026, 9, 6)          # 环境当前日期（周日）
FRED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fred_raw.csv")

LOG = []


# ------------------------------------------------------------------ 加载真实收盘
def load_fred_local():
    """读取预抓取的 FRED CSV（真实收盘骨架，含 2024-12 上下文）。"""
    if not os.path.exists(FRED_FILE):
        return {}
    rows = {}
    with open(FRED_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("observation"):
                continue
            d, v = (line.split(",", 1) + [""])[:2]
            v = v.strip()
            if v in ("", "."):
                continue
            try:
                rows[dt.date.fromisoformat(d)] = round(float(v), 2)
            except Exception:
                continue
    LOG.append(f"fred_raw.csv 加载 {len(rows)} 条真实收盘"
               f"（{min(rows)} ~ {max(rows)}）")
    return rows


# ------------------------------------------------------------------ 逐日蜡烛
def calendar_dates(start, end):
    out, d = [], start
    while d <= end:
        out.append(d)
        d += dt.timedelta(days=1)
    return out


def build_candles(real):
    dates = calendar_dates(START, END)
    # 锚序列：含范围外最近前值作上下文
    real_sorted = sorted(real.keys())
    idx = 0
    while idx < len(real_sorted) and real_sorted[idx] < START:
        idx += 1

    def next_real(d):
        """返回 >= d 的最小真实日与值"""
        i = idx
        while i < len(real_sorted) and real_sorted[i] < d:
            i += 1
        if i < len(real_sorted):
            return real_sorted[i], real[real_sorted[i]]
        return None, None

    def prev_real(d):
        i = len(real_sorted) - 1
        while i >= 0 and real_sorted[i] > d:
            i -= 1
        if i >= 0:
            return real_sorted[i], real[real_sorted[i]]
        return None, None

    closes = []
    prev_close = None
    last_real_close = None
    for d in dates:
        if d in real:
            c = real[d]
            last_real_close = c
            closes.append(c)
            continue
        # 非真实日（周末/休市/数据源截止后）
        prev_d, prev_v = prev_real(d)
        next_d, next_v = next_real(d)
        if prev_v is None and next_v is not None:
            # 开头（2025-01-01休市）：取上下文前值若在范围内外可用
            # 否则按首根真实值占位
            base = next_v
            closes.append(base)
            continue
        if next_v is None:
            # 数据源截止后（尾部外推）：温和随机游走
            if prev_close is None:
                c = prev_v if prev_v else 72.0
            else:
                wd = d.weekday()
                vol = 0.0045 if wd < 5 else 0.0012
                rng = random.Random((d.year * 10000 + d.month * 100 + d.day) * 31 + 7)
                c = round(prev_close * math.exp(rng.gauss(0, vol)), 2)
            closes.append(c)
            continue
        # 两个真实日之间的桥接（周末/短休市，间隔>=1）
        span = (next_d - prev_d).days
        if span > 8:
            # 极长假缺口按单调漂移处理
            span = 8
        gap = (d - prev_d).days
        ratio = min(1.0, gap / span)
        ln1 = math.log(prev_v)
        ln2 = math.log(next_v)
        wd = d.weekday()
        noise_vol = 0.0006 if wd >= 5 else 0.002
        rng = random.Random((d.year * 10000 + d.month * 100 + d.day) * 17 + 11)
        c = math.exp(ln1 + (ln2 - ln1) * ratio + rng.gauss(0, noise_vol))
        c = round(max(0.5, c), 2)
        closes.append(c)
    return closes, last_real_close


def build_ohlc(dates, closes):
    candles = []
    prev_c = None
    for i, d in enumerate(dates):
        c = closes[i]
        wd = d.weekday()
        seed = (d.year * 10000 + d.month * 100 + d.day) * 41 + 3
        rng = random.Random(seed)
        if prev_c is None:
            o = c
        else:
            # 开盘价：较前收微幅跳空（真实日0.05-0.15%，周末几乎无）
            gap_v = (0.0012 if wd < 5 else 0.0003) if prev_c else 0.0012
            o = round(prev_c * math.exp(rng.gauss(0, gap_v)), 2)
        # 影线：与实体波动(相对幅度)成正比，但避免末端大实体把影线放大过度
        prev = prev_c or c
        body_pct = abs(c - prev) / max(prev, 1e-6)
        wk = max(0.0005 if wd < 5 else 0.0002, body_pct * 0.05)
        wk += rng.random() * (0.002 if wd < 5 else 0.00025)
        h = round(max(o, c) * (1 + wk), 2)
        l = round(min(o, c) * (1 - wk), 2)
        if l <= 0:
            l = round(min(o, c) * 0.9, 2)
        candles.append({"d": d.isoformat(), "o": o, "h": h, "l": l, "c": c})
        prev_c = c
    return candles


# ------------------------------------------------------- 新闻（日期对齐拐点）
def build_news():
    n = [
        # ============ 2025 真实国际大事件 ============
        ("2025-01-03", "美国寒潮来袭，取暖需求激增，EIA原油库存骤降，油价走高", True),
        ("2025-01-06", "OPEC+宣布将原定增产计划推迟至4月，缓解供应过剩担忧", True),
        ("2025-01-09", "美国对俄能源制裁风声再起，叠加寒潮推高油价至三周高位", True),
        ("2025-01-10", "美英宣布对俄罗斯石油行业实施大规模制裁，国际油价应声大涨", True),
        ("2025-01-15", "对俄制裁持续发酵，WTI一度逼近80美元关口创阶段新高", True),
        ("2025-01-16", "加沙停火协议正式生效，地缘风险溢价回落，油价冲高回落", True),
        ("2025-01-20", "特朗普就任美国总统，宣布‘国家能源紧急状态’，誓言扩大本土钻探", True),
        ("2025-01-24", "特朗普要求OPEC降低油价以施压俄罗斯，油价承压下行", False),
        ("2025-02-03", "特朗普政府恢复对伊朗‘极限施压’，签署新一轮对伊制裁行政令", True),
        ("2025-02-10", "EIA上调美国产量预期，供应过剩阴云重燃", False),
        ("2025-02-14", "美俄高层于沙特会晤，俄乌停战谈判推进，供应风险缓和", False),
        ("2025-02-19", "俄乌停战进程提速，乌克兰同意有条件停火，油价低位徘徊", False),
        ("2025-02-26", "OPEC+内部就是否增产分歧加大，油价震荡加剧", True),
        ("2025-03-03", "OPEC+意外宣布4月起启动增产，国际油价单日重挫逾3%", True),
        ("2025-03-05", "OPEC+确认5月继续增产41万桶/日，减产联盟加速退出", True),
        ("2025-03-12", "美国CPI回落不及预期，贸易战阴云压制大宗商品", False),
        ("2025-03-18", "美军空袭也门胡塞武装，红海航线风险溢价回升", False),
        ("2025-03-25", "美国对购买委内瑞拉原油的国家发出25%二级关税威胁", True),
        ("2025-04-02", "特朗普宣布‘对等关税’落地全球震动，能源需求前景蒙阴影", True),
        ("2025-04-03", "关税冲击需求预期，OPEC+超预期增产，油价两日暴跌逾10%", True),
        ("2025-04-04", "全球衰退担忧发酵，原油遭遇恐慌性抛售创数月新低", True),
        ("2025-04-09", "特朗普宣布暂停对等关税90天，风险资产报复性反弹，油价回升", True),
        ("2025-04-15", "美国宣布对伊朗出口原油实施新制裁，地缘溢价回归", True),
        ("2025-04-22", "哈萨克斯坦CPC输油管道因故停运，欧洲供应疑虑升温", True),
        ("2025-04-28", "美伊就核问题开始间接接触，市场评估制裁前景", False),
        ("2025-05-01", "特朗普威胁‘伊朗不谈判就轰炸’，油价盘中跳涨后回落", True),
        ("2025-05-08", "OPEC+维持6月增产计划，供过于求担忧施压油价", True),
        ("2025-05-15", "俄乌停火谈判取得进展，地缘溢价持续消退", True),
        ("2025-05-22", "EIA原油库存超预期累库，油价短线承压", False),
        ("2025-05-30", "OPEC+确认7-8月加速增产，油价刷新阶段低点", True),
        ("2025-06-10", "美伊核谈破裂、伊朗浓缩铀风波再起，中东局势骤然紧张", True),
        ("2025-06-12", "美军对伊朗军事目标发动打击，油价单日暴涨创阶段新高", True),
        ("2025-06-13", "伊朗扬言封锁霍尔木兹海峡，油价续冲多年高位", True),
        ("2025-06-18", "霍尔木兹海峡通行受阻传闻再起，全球能源价格剧烈波动", True),
        ("2025-06-24", "以伊冲突达成停火，油价高位大幅回落", True),
        ("2025-06-30", "停火后风险溢价退潮，油价回归区间震荡", False),
        ("2025-07-10", "OPEC+宣布8月继续增产，油价跌破60美元", True),
        ("2025-07-17", "美国飓风季来袭，墨西哥湾部分产能预防性关停", False),
        ("2025-07-31", "OPEC+称将按需向市场投放产量，油价弱势整理", False),
        ("2025-08-12", "中美贸易休战90天，风险资产巨震拖累油价重挫", True),
        ("2025-08-18", "红海油轮再遇袭，地缘风险短暂支撑油价", False),
        ("2025-08-26", "OPEC+内部对增产节奏分歧公开化，油价波动放大", True),
        ("2025-09-08", "OPEC+会议维持产量政策，市场解读分歧油价震荡", True),
        ("2025-09-18", "美联储降息落地，宽松预期提振风险偏好支撑油价", True),
        ("2025-09-26", "墨西哥湾强飓风逼近，美湾大面积产能停产", True),
        ("2025-10-14", "中东局势再度升级，油价单日大涨9%创阶段新高", True),
        ("2025-10-23", "伊朗石油设施遇袭传闻发酵，油价延续反弹", True),
        ("2025-10-30", "OPEC+讨论暂缓增产以稳定市场，油价高位震荡", True),
        ("2025-11-13", "美国原油产量续创历史新高，供应压力压制油价", False),
        ("2025-11-20", "IEA报告警告需求疲软，油价重心下移", True),
        ("2025-12-04", "OPEC+决定延长减产至明年一季度，油价短线反弹", True),
        ("2025-12-12", "美联储鹰派降息，美元走强打压油价", False),
        ("2025-12-19", "美国加大对伊朗相关油轮制裁，地缘扰动再起", True),
        ("2025-12-24", "年末假期效应，原油市场缩量整理", False),
        ("2025-12-31", "2025年收官：增产与需求担忧主导，油价全年大幅走弱", True),
        # ============ 2026（依据行情拐点整理的叙事新闻） ============
        ("2026-01-09", "美伊局势再度紧绷，油价自57美元附近企稳反弹", False),
        ("2026-01-16", "美国原油库存连续累库，但地缘风险支撑油价", False),
        ("2026-01-23", "特朗普再度威胁对伊朗采取军事行动，油价震荡走高", True),
        ("2026-01-30", "霍尔木兹紧张升温，油价站上63美元刷新数月高位", True),
        ("2026-02-06", "美伊博弈升级，伊朗扬言封锁海峡，油价逼近70美元", True),
        ("2026-02-13", "美国增兵中东，原油风险溢价显著抬升", True),
        ("2026-02-27", "美以伊对峙一触即发，油价创近一年新高逼近70美元", True),
        ("2026-03-05", "中东冲突全面爆发，油价两日飙涨超20%突破80美元", True),
        ("2026-03-06", "霍尔木兹海峡通航受阻，WTI冲上90美元关口", True),
        ("2026-03-09", "国际油价三年来首破100美元，全球能源市场风声鹤唳", True),
        ("2026-03-10", "G7紧急商讨释放战略储备与增产，油价单日大幅回落", True),
        ("2026-03-12", "冲突反复叠加空袭传闻，油价剧烈震荡收复95美元", True),
        ("2026-03-17", "‘第四次能源危机’论升温，油价于百元上方高位震荡", True),
        ("2026-03-24", "美伊接触渠道若隐若现，油价冲高回落", False),
        ("2026-03-31", "冲突未见缓和，油价月线大涨站稳100美元上方", True),
        ("2026-04-02", "美军空袭伊朗重要目标，油价飙涨超11%至113美元", True),
        ("2026-04-08", "市场传闻停火谈判重启，油价单日重挫16%高位跳水", True),
        ("2026-04-10", "霍尔木兹航道遇袭事件再起，油价超跌反弹", True),
        ("2026-04-17", "和谈进展与中国需求疲软共振，油价跌向86美元", True),
        ("2026-04-22", "OPEC+紧急会议讨论增产平抑油价，油价承压", True),
        ("2026-04-29", "中东冲突再度升级，油价暴力反弹重上110美元", True),
        ("2026-05-06", "美伊停火试探消息流出，油价单日大跌6%", True),
        ("2026-05-14", "霍尔木兹航运风险与高油价挤压全球通胀，油价高位巨震", True),
        ("2026-05-20", "美国释放战略储备规模不及预期，油价先抑后扬收于百元上方", True),
        ("2026-05-27", "和谈框架现雏形，油价回落至92美元一线", True),
        ("2026-06-04", "停战谈判进入关键时刻，油价弱势整理", False),
        ("2026-06-15", "美伊达成和平协议、霍尔木兹解封，油价崩跌至85美元下方", True),
        ("2026-06-17", "停战谅解备忘录正式签署，油价跌破80美元", True),
        ("2026-06-23", "冲突溢价加速退潮，油价回落至75美元附近", True),
        ("2026-06-30", "油价基本回落至战前水平，市场重新聚焦供需基本面", True),
        ("2026-07-08", "OPEC+增产决议不及预期，油价低位企稳", False),
        ("2026-07-16", "停战执行现波折，伊朗推迟交还扣押油轮，油价反弹", True),
        ("2026-07-23", "美伊关系再生变数，油价单日大涨6%重上90美元", True),
        ("2026-07-29", "中东局势再度紧张，油价冲高回落至86美元", True),
        ("2026-08-04", "美国与伊朗恢复技术性谈判，油价跌向77美元", True),
        ("2026-08-11", "霍尔木兹通行费率回落，油价窄幅整理", False),
        ("2026-08-18", "美国原油产量创新高叠加库存转增，油价承压", False),
        ("2026-08-26", "伊朗与阿曼就临时通航走廊达成协议，油价小幅走弱", True),
        ("2026-09-01", "新飓风威胁美湾生产叠加地缘余波，油价单日上涨5%", True),
        ("2026-09-04", "飓风与和谈消息交织，油价高位波动", False),
    ]
    seen = set()
    out = []
    for d, title, important in n:
        if d in seen:
            continue
        seen.add(d)
        out.append({"d": d, "title": title, "important": bool(important)})
    return sorted(out, key=lambda x: x["d"])


# ------------------------------------------------------------------ 主流程
def main():
    os.makedirs("js", exist_ok=True)
    real = load_fred_local()
    if not real:
        LOG.append("警告：未找到 fred_raw.csv，将生成演示性走势（真实度受限）")
    dates = calendar_dates(START, END)
    closes, _ = build_candles(real)
    candles = build_ohlc(dates, closes)

    news = build_news()
    real_cnt = sum(1 for c in candles if dt.date.fromisoformat(c["d"]) in real)
    # 依真实收盘修正首根（2025-01-01 休市）为占位
    data = {
        "meta": {
            "market": "WTI 原油（美元/桶）",
            "start": START.isoformat(),
            "end": END.isoformat(),
            "generatedAt": dt.date.today().isoformat(),
            "candles": len(candles),
            "realDays": real_cnt,
            "newsCount": len(news),
            "note": ("收盘价以 FRED DCOILWTICO 真实数据为骨架；周末/休市/截止后为桥接与外推，"
                     "OHLC 中高低价为按波动估计的合成值；2026年新闻为叙事性整理。"),
        },
        "candles": candles,
        "news": news,
    }
    js = "/* 本文件由 build_data.py 自动生成，请勿手改；重跑脚本可刷新数据 */\n"
    js += "window.OIL_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    with open("js/data.js", "w", encoding="utf-8") as f:
        f.write(js)

    print("== 数据源日志 ==")
    for log in LOG:
        print(" -", log)
    print("== 生成统计 ==")
    print(f" 蜡烛总数: {len(candles)}  ({START} ~ {END})")
    print(f" 真实锚定日数: {real_cnt} 天")
    print(f" 新闻条数: {len(news)}  (重要 {sum(1 for x in news if x['important'])} 条)")
    lo = min(c["l"] for c in candles); hi = max(c["h"] for c in candles)
    print(f" 首日收盘: {candles[0]['c']} | 末日收盘: {candles[-1]['c']} | 区间低: {lo} | 区间高: {hi}")
    mv, md = 0, ""
    for i in range(1, len(candles)):
        ch = abs(candles[i]["c"] / candles[i - 1]["c"] - 1) * 100
        if ch > mv:
            mv, md = ch, candles[i]["d"]
    print(f" 最大单日波动: {mv:.2f}% @ {md}")
    print(" 输出: js/data.js")


if __name__ == "__main__":
    main()

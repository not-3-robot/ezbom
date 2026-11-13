#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DWG → EzBOM drawing.svg（2026-10-09 定版流程，见 Obsidian DWG转EzBOM流程.md）

用法:
    python3 dwg2drawing.py <in.dwg> <out.svg> [bom.csv] [--rotate auto|0|90|180|270]
                          [--overrides overrides.json --key 相对路径] [--stroke 数值]

--stroke 覆写笔画宽（预设＝外框对角线×0.002）。细齿图（齿轮/轴承齿距小于
预设笔画）会糊成实心黑块，改细笔画还原齿牙，如 链条/160/齿轮箱 用 0.15。

--rotate 预设 auto：直式（高>宽）自动顺时针转 90° 成横式，与 p_type 参考稿
（p_type.dxf.svg，8400×5940）方向一致；横式不动。p_type 横式故回归输出不变。

--overrides：放大检视.html「修正模式」记录的人工归组修正表（JSON），
  以 --key（相对于 产品手册46 的路径去副档名，如 链条/190/超短小车）取用。
  几何规则分不出来的吃线错误（两条引线端点落在同一叠线上）由此兜底。

模式自动选择:
  1. layer   — 存在 ^P\\d+- 图层：按图层分组（标签=图层名，与手工版同源），
               丢弃全部非 P 层（p_type 实测：层5=引线、层7=串联中心线+气球、0/8=标题）。
  2. balloon — 无 P 层，但有 CIRCLE+数字 TEXT 成对：气球归组（手册批同款 assign），
               丢弃配对圆与贴圆缘引线（K型齿轮箱 路线）。
bom.csv 可选：提供时做 P-id 交叉比对（注意 bom 本身无法从 DWG 产出，
料号/品名/数量只能来自清册或 ERP）。

依赖：BOM树状图/_build/dwg_extract.py（convert_dwg / collect_segments /
extract 分组码；椭圆旋转与 bulge 修正皆在该档，2026-10-09）。
"""
import csv
import json
import math
import os
import re
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
EXTRACT_DIR = "/Users/zone/Documents/Study/B0M研究/BOM树状图/_build"
sys.path.insert(0, EXTRACT_DIR)

from dwg_extract import (convert_dwg, collect_segments, assign_segments,
                         ASSIGN_THRESHOLD, BALLOON_BLOCK)
from dwg_merge import segs_to_svg_path
import ezdxf

LAYER_RE = re.compile(r"^P(\d+)-")
NUM_RE = re.compile(r"^\d+$")
# P-id 契约（权威定义在 _audit/audit_drawing.py 的 LBL，两端必须同语义）：
#   ^P(\d+)(?:$|-)  — "P01"（无 dash）与 "P01-xxx"（有 dash）都算同一零件 P01。
# JS 端对应：viewer.js 的 /^P\d+$/（无 dash 分支）＋ indexOf('-') 截断（有 dash）。
PID_RE = re.compile(r"^P(\d+)(?:$|-)")


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def flip(segs):
    """CAD y-up → SVG y-down。"""
    return [(x1, -y1, x2, -y2) for x1, y1, x2, y2 in segs]


def flip_rot(segs, deg):
    """CAD y-up → SVG y-down，再把画面旋转 deg 度（顺时针）。

    SVG 座标 y 向下，顺时针 90° 的变换是 (x, y) → (-y, x)：
    原本在左上角的内容会跑到右上角。K型 DWG 在 WCS 里是直式
    （viewBox 1863×2594），p_type 参考稿是横式（8400×5940），
    使用者 2026-10-10 裁定直式图一律转正成横式。
    """
    out = flip(segs)
    if deg == 90:
        return [(-y1, x1, -y2, x2) for x1, y1, x2, y2 in out]
    if deg == 180:
        return [(-x1, -y1, -x2, -y2) for x1, y1, x2, y2 in out]
    if deg == 270:
        return [(y1, -x1, y2, -x2) for x1, y1, x2, y2 in out]
    return out


def read_bom_ids(path):
    ids = set()
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                ids.add((row.get("Id") or row.get("标签ID") or "").strip())
    return ids


def read_bom_names(path):
    """Id → 品名（bom.csv 的 Name 栏）。"""
    out = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                pid = (row.get("Id") or "").strip()
                nm = (row.get("Name") or row.get("品名") or "").strip()
                if pid and nm:
                    out[pid] = nm
    return out


def fix_mojibake(s):
    """UTF-8 位元组被当 Latin-1 再存一次的救援（p_type 标签的病灶）。"""
    if not s or not re.search(r"[ÃÂåæçèéê][\u0080-¿]", s):
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def layer_mode(doc, msp):
    """P 图层白名单：分组=图层名，非 P 层（引线/中心线/气球/标题）全丢。"""
    buckets = {}
    for e in msp:
        L = e.dxf.layer if e.dxf.hasattr("layer") else "0"
        if LAYER_RE.match(L):
            buckets.setdefault(L, []).append(e)
    groups = {}
    for L, ents in buckets.items():
        segs = collect_segments(doc, entities=ents)
        if segs:
            groups[L] = segs
    labels = {L: L for L in groups}          # 标签直接用图层名
    return groups, labels, {"dropped_layers": True}


# ── balloon_mode 拆分（2026-10-24）────────────────────────────────────────
# 原 475 行单函式（8 代侦测策略叠加、14 个巢状 def、block_mode 5 处分流）
# 拆成：纯几何 helper（_bm_*）＋ 8 个策略函式 ＋ balloon_mode 编排器。
# 行为零变化：47 张全量逐位元组回归一致（/tmp/balloon_regen harness）。
# 各策略的历史注解与实测标定数据随代码迁移，未改写。
# 规则：所有回圈形状/迭代顺序/常量原样保留——包括看似可优化的部分
# （per-text 重 query、O(n²) 圈搜寻、LIFO pending.pop），它们都是
# 逐位元组回归验证过的行为的一部分。

_BM_DASH_RE = re.compile(r"ISO12|PHANTOM|CENTER|DASHED|ADJPHANT|DOT", re.I)


def _bm_pts_of(e, n=8):
    """实体取样点（crowd/nonline_touch 共用的几何离散化）。"""
    t = e.dxftype()
    if t == "ELLIPSE":
        c, maj = e.dxf.center, e.dxf.major_axis
        ar = maj.magnitude
        br = ar * e.dxf.ratio
        ang = math.atan2(maj.y, maj.x)
        ca, sa = math.cos(ang), math.sin(ang)
        t0, t1 = e.dxf.start_param, e.dxf.end_param
        if t1 <= t0:
            t1 += 2 * math.pi
        out = []
        for k in range(n + 1):
            u = t0 + (t1 - t0) * k / n
            x, y = ar * math.cos(u), br * math.sin(u)
            out.append((c.x + ca * x - sa * y, c.y + sa * x + ca * y))
        return out
    if t in ("CIRCLE", "ARC"):
        c, r = e.dxf.center, e.dxf.radius
        if t == "CIRCLE":
            t0, t1 = 0.0, 2 * math.pi
        else:
            t0 = math.radians(e.dxf.start_angle)
            t1 = math.radians(e.dxf.end_angle)
            if t1 <= t0:
                t1 += 2 * math.pi
        return [(c.x + r * math.cos(t0 + (t1 - t0) * k / n),
                 c.y + r * math.sin(t0 + (t1 - t0) * k / n)) for k in range(n + 1)]
    if t == "LINE":
        a, b = e.dxf.start, e.dxf.end
        return [(a.x + (b.x - a.x) * k / 6, a.y + (b.y - a.y) * k / 6) for k in range(7)]
    if t in ("LWPOLYLINE", "POLYLINE"):
        out = []
        try:
            for v in e.virtual_entities():
                out.extend(_bm_pts_of(v, 6))
        except Exception:
            pass
        return out
    return []


def _bm_geom_size(e):
    return e.dxf.major_axis.magnitude if e.dxftype() == "ELLIPSE" else e.dxf.radius


def _bm_geom_sweep(e):
    if e.dxftype() == "ELLIPSE":
        return math.degrees((e.dxf.end_param - e.dxf.start_param) % (2 * math.pi))
    return (e.dxf.end_angle - e.dxf.start_angle) % 360


def _bm_linetype_of(e, doc, cache):
    """实体线型：自身非 BYLAYER 用自身，否则查图层（cache 为 {层名: 线型}）。"""
    if e.dxf.hasattr("linetype") and e.dxf.linetype not in ("BYLAYER", "ByLayer"):
        return e.dxf.linetype
    L = e.dxf.layer if e.dxf.hasattr("layer") else "0"
    if L not in cache:
        try:
            cache[L] = doc.layers.get(L).dxf.linetype
        except Exception:
            cache[L] = "CONTINUOUS"
    return cache[L]


def _bm_d_axis(px, py, axis_lines):
    """点到最近组立轴线的距离。"""
    best = 1e18
    for L in axis_lines:
        ax, ay = L.dxf.start.x, L.dxf.start.y
        bx, by = L.dxf.end.x, L.dxf.end.y
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            d = math.hypot(px - ax, py - ay)
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
            d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        if d < best:
            best = d
    return best


def _bm_endpoint_d(p, b):
    return math.hypot(p.x - b["x"], p.y - b["y"])


def _bm_radial_leaders(cx, cy, rr, lines):
    out = []
    for L in lines:
        d1 = math.hypot(L.dxf.start.x - cx, L.dxf.start.y - cy)
        d2 = math.hypot(L.dxf.end.x - cx, L.dxf.end.y - cy)
        if min(d1, d2) <= rr * 1.35 and max(d1, d2) >= rr * 2.5:
            out.append(L)
    return out


def _bm_num_text_inside(x, y, r, texts):
    return any(math.hypot(t.dxf.insert.x - x, t.dxf.insert.y - y) <= r for t in texts)


def _bm_has_balloon_leader(ls, balloons):
    for L in ls:
        for b in balloons:
            d1 = math.hypot(L.dxf.start.x - b["x"], L.dxf.start.y - b["y"])
            d2 = math.hypot(L.dxf.end.x - b["x"], L.dxf.end.y - b["y"])
            if min(d1, d2) <= b["r"] * 1.4:
                return True
    return False


def _bm_family_of(cx, cy, msp, lines):
    """候选头的同家族几何（同心圈＋自家引线），crowd 量测时排除用。"""
    drop = set()
    for e in msp:
        if e.dxftype() in ("ELLIPSE", "CIRCLE", "ARC") and e.dxf.hasattr("center"):
            if math.hypot(e.dxf.center.x - cx, e.dxf.center.y - cy) < 15:
                drop.add(id(e))
    for L in lines:
        d1 = math.hypot(L.dxf.start.x - cx, L.dxf.start.y - cy)
        d2 = math.hypot(L.dxf.end.x - cx, L.dxf.end.y - cy)
        if min(d1, d2) <= 70 and max(d1, d2) <= 200:
            drop.add(id(L))
    return drop


def _bm_crowd(cx, cy, R, drop, msp, axis_id):
    n = 0
    for e in msp:
        if id(e) in drop:
            continue
        if id(e) in axis_id:
            continue
        for x, y in _bm_pts_of(e, 6):
            if math.hypot(x - cx, y - cy) <= R:
                n += 1
                break
    return n


def _bm_nonline_touch(px, py, exclude, msp):
    for e in msp:
        if id(e) in exclude or e.dxftype() == "LINE":
            continue
        for x, y in _bm_pts_of(e, 8):
            if math.hypot(x - px, y - py) <= 2.5:
                return True
    return False


def _bm_is_leader(e, balloons, extra_leaders):
    """classic 模式引线判定：一端贴气球圈心 ≤1.3r（insert 量测，旧制）。"""
    if e.dxftype() != "LINE":
        return False
    if id(e) in extra_leaders:
        return True
    for p in (e.dxf.start, e.dxf.end):
        for b in balloons:
            if math.hypot(p.x - b["x"], p.y - b["y"]) <= b["r"] * 1.3:
                return True
    return False


def _bm_edge_leader(e, balloons):
    """block 模式引线判定（2026-10-19）。

    诚岱手册批的气球＝件号 block：引线是独立 LINE，一端落在圆周上、他端
    指向零件。4 支代表图实测判别力完全分离：「一端 |d−圈心 r| ≤ 0.3r 且
    他端 ≥ 2r」命中 131/139、30/30、84/84、85/82，100% 落在专属引线图层
    （层4/5），层0 零件线零命中。tol 0.15r↔0.30r 命中数完全相同＝阈值不敏感。
    取代 insert 量测的旧 is_leader（量测基准错，见 _bm_collect_block_balloons
    真圈心注解）。

    命中回传 (tip_x, tip_y, 气球索引)：远端点＝引线指向零件的那一头，
    归组（assign_components）靠它认领分量。tuple 恒 truthy，旧布林用法
    不受影响。迭代顺序＝气球外层（与 10/20 原型一致，保证输出同位）。
    """
    if e.dxftype() != "LINE":
        return None
    for bi, b in enumerate(balloons):
        for p, q in ((e.dxf.start, e.dxf.end), (e.dxf.end, e.dxf.start)):
            if abs(math.hypot(p.x - b["cx"], p.y - b["cy"]) - b["r"]) \
                    <= b["r"] * 0.3 \
                    and math.hypot(q.x - b["cx"], q.y - b["cy"]) >= b["r"] * 2.0:
                return q.x, q.y, bi
    return None


def _bm_pair_circle_text(texts, circles):
    """策略①（基底）：CIRCLE＋数字 TEXT 配对当气球。回传 (balloons, paired)。"""
    balloons, paired = [], set()
    for t in texts:
        tx, ty = t.dxf.insert.x, t.dxf.insert.y
        for i, c in enumerate(circles):
            if i in paired:
                continue
            r = c.dxf.radius
            if math.hypot(tx - c.dxf.center.x, ty - c.dxf.center.y) <= r:
                balloons.append({"n": int(t.dxf.text.strip()),
                                 "x": c.dxf.center.x, "y": c.dxf.center.y,
                                 "r": r})
                paired.add(i)
                break
    return balloons, paired


def _bm_calibrate_radius(circles, paired):
    """策略②：自动标定气球半径基准。回传 (r_med, ARC_R_LO, ARC_R_HI)。

    下面三个阈值本来是照 K型 一张图量出来写死的（d_axis>60 / crowd≤1 /
    ARC r∈[24,30]），换图要手动复验。改成从「本图已配对的编号气球」推导，
    换图自动跟著走。K型 标定结果 = 原硬编码值（验收：输出须逐位元组一致）。
    """
    paired_r = sorted(circles[i].dxf.radius for i in paired)
    r_med = paired_r[len(paired_r) // 2] if paired_r else 27.0
    ARC_R_LO, ARC_R_HI = r_med - 3, r_med + 3        # K型: 27±3 = [24,30]
    return r_med, ARC_R_LO, ARC_R_HI


def _bm_add_arc_balloons(texts, msp, balloons, arc_r_lo, arc_r_hi):
    """策略③（K型波，165bcac）：ARC 型气球捡回。balloons 原地 append。

    气球不一定画成 CIRCLE：K型 气球#16 画成 ARC r=27、sweep=355°（数字 16 就在
    圈内），配对只认 CIRCLE 所以漏配——流程笔记记的「文字16 无圈」其实是侦测缺口，
    不是源图缺口。sweep≥270 才算整圈（同半径的零件弧 sweep 只有 13~24°，不会误配）。
    """
    balloon_arc_ids = set()
    for t in texts:
        tx, ty = t.dxf.insert.x, t.dxf.insert.y
        if any(math.hypot(tx - b["x"], ty - b["y"]) <= b["r"] for b in balloons):
            continue
        for a in msp.query("ARC"):
            if id(a) in balloon_arc_ids:
                continue
            r = a.dxf.radius
            if not arc_r_lo <= r <= arc_r_hi:
                continue
            if (a.dxf.end_angle - a.dxf.start_angle) % 360 < 270:
                continue
            if math.hypot(tx - a.dxf.center.x, ty - a.dxf.center.y) <= r:
                balloons.append({"n": int(t.dxf.text.strip()),
                                 "x": a.dxf.center.x, "y": a.dxf.center.y,
                                 "r": r})
                balloon_arc_ids.add(id(a))
                break
    return balloon_arc_ids


def _bm_collect_block_balloons(msp):
    """策略④（诚岱46批波）：件号 block ATTRIB 气球。回传 balloons（可为空）。

    诚岱手册 DWG 的编号不是 TEXT+CIRCLE，而是「件号」block 的 ATTRIB 属性
    （同 dwg_extract.extract_balloons 逻辑，2026-10-10 实测这批唯一的气球
    形式）。CIRCLE+TEXT/ARC 配对都落空才走这条——两条路互斥，p_type/K型
    的回归输出因此逐位元组不变。
    """
    balloons = []
    for e in msp:
        if e.dxftype() != "INSERT" or BALLOON_BLOCK not in e.dxf.name:
            continue
        n = None
        for a in e.attribs:
            txt = str(a.dxf.text).strip()
            if txt.isdigit():
                n = int(txt)
                break
        if n is None:
            continue
        # 半径取 block 内部 CIRCLE 最大者（引线/闸门量测都要半径）；
        # 内部无圈退回 27（K型 编号圈实测半径，只当尺度参考）。
        r = 0.0
        cx = cy = None
        try:
            for v in e.virtual_entities():
                if v.dxftype() == "CIRCLE" and v.dxf.radius > r:
                    r = v.dxf.radius
                    cx, cy = v.dxf.center.x, v.dxf.center.y
        except Exception:
            pass
        # 真圈心：件号 block 的插入点落在圆周右缘（离圈心恰为 r），
        # 引线量测必须用圈心——用 insert 会漏掉对侧引线（超短小车实测
        # 残留 52/139）且误杀贴 insert 的零件短线（8 支代表图层0 误杀 33）。
        balloons.append({"n": n, "x": e.dxf.insert.x, "y": e.dxf.insert.y,
                         "r": r or 27.0,
                         "cx": cx if cx is not None else e.dxf.insert.x,
                         "cy": cy if cy is not None else e.dxf.insert.y})
    return balloons


def _bm_orphan_circles(circles, paired, lines, block_mode):
    """策略⑤：漏网气球（孤圈）＋贴圈缘引线。回传 (extra_circles, extra_leaders)。

    圈没配到文字、但圈缘有线端点贴著（引线）→ 同样当气球移除。
    p_type/K型 实测都出现过这种孤圈；只删「一端贴圈(≤1.5r)、另一端在 2r 外」
    的线，避免误杀穿过孔位的中心线。
    """
    extra_circles, extra_leaders = set(), set()
    for i, c in enumerate(circles):
        if block_mode:
            break          # block 模式：顶层圈全是零件，孤圈规则会误杀
        if i in paired:
            continue
        b = {"x": c.dxf.center.x, "y": c.dxf.center.y, "r": c.dxf.radius}
        touch = [e for e in lines
                 if min(_bm_endpoint_d(e.dxf.start, b), _bm_endpoint_d(e.dxf.end, b))
                 <= b["r"] * 1.5
                 and max(_bm_endpoint_d(e.dxf.start, b), _bm_endpoint_d(e.dxf.end, b))
                 > b["r"] * 2]
        if touch:
            extra_circles.add(i)
            extra_leaders.update(id(e) for e in touch)
    return extra_circles, extra_leaders


def _bm_axis_gate(balloons, axis_lines):
    """策略⑥：自动标定①离轴闸门。

    K型 层2 = ACAD_ISO12W100（ISO 虚线）＝零件中间的组立假想线。轴线的「端点
    正好落在零件中心」，radial_leaders 的「一端贴 ≤1.35a、另一端 ≥2.5a」对它
    永远成立 → 坐在轴线上的轴承圈全被误判成泡泡删掉（2026-10-10 实测 13 颗
    全是零件，另加重规则2 的部分弧共 30 颗）。
    判别力（同一份图量的）：
      34 颗编号气球 距轴线 84 ~ 494（中位 128）
      13 颗被误删的轴承 距轴线 0 ~ 16
    完全分离，故闸门取 60（留安全边距）。

    自动标定①：离轴闸门 = 编号气球距轴线「最小值」×0.7。
    原理：气球永远画在轴线外、零件永远坐在轴线上；取最贴近轴线的那颗气球再
    打 7 折当安全边距。K型：min=84 → 58.8（原本硬编码 60，等价）。
    """
    axis_d = sorted(_bm_d_axis(b["x"], b["y"], axis_lines) for b in balloons)
    return max(10.0, axis_d[0] * 0.7) if axis_d else 60.0


def _bm_bubbles(msp, lines, axis_lines, axis_gate, block_mode):
    """策略⑦：注记泡泡（无文字版）。回传 (bubble_ids, leader_ids)。

    完整等轴测圈 a∈[10,50] 若带径向引线（一端贴圈 ≤1.35a、另端 ≥2.5a）
    ＝没有号码的注记圈。
    ⚠️ 这条规则很容易被两个东西骗过，都已加闸门：
      ① 组立轴线（端点落在零件中心 → 条件永远成立）→ AXIS_GATE 挡
      ② 编号气球的引线（气球指的一定是零件）→ _bm_has_balloon_leader 挡
    K型 修前因此误删 13 颗轴承（双同心圈 a=27.8+35.0 当时被误记成「使用者指的
    泡泡球」，实测那些全是零件）；加闸门后 13 → 0。
    ⚠️ block 模式（手册批）整组停用：这批图的等轴测椭圆（ratio 0.58≈cos54.7°）
    全是零件面——超短小车实测「满圈注记泡泡」判定 chain 吃掉相邻 a=13.5 半椭圆
    （链条链环），正是使用者 2026-10-19 点名的「零件轮廓线不能删」。
    🔴 2026-11-12 曾试「⑦b block 保守版」（只删满圈＋直接引线、无链延伸、
    crowd≤1、不设轴线闸门），**全库实证 100% 误杀后拆除**：46 支共删 226 颗
    椭圆、226 颗 ratio 全＝0.577（等轴测签名），零颗真泡泡。等轴测「空心销」
    的两端面＋两条母线正好构成「满圈＋径向引线」，crowd=0 因爆炸图零件本就
    浮空——所有闸门同时失效。齿轮箱b.ba 目视：整支销删光、华司内孔删成实心，
    连带 P32 锚分量消失→区域生长吞邻件（140→1470 段、共管 0→2 重复画图）。
    **别再试任何 block 模式 ELLIPSE 删除规则。**
    """
    bubble_ids, leader_ids = set(), set()
    for e in ([] if block_mode else msp.query("ELLIPSE")):
        a = e.dxf.major_axis.magnitude
        if not (10 <= a <= 50 and 0.45 <= e.dxf.ratio <= 0.75):
            continue
        if abs((e.dxf.end_param - e.dxf.start_param) - 2 * math.pi) > 0.05:
            continue
        cx, cy = e.dxf.center.x, e.dxf.center.y
        # 闸门：坐在组立轴线上的一定是零件（见 _bm_axis_gate 说明）。
        if _bm_d_axis(cx, cy, axis_lines) <= axis_gate:
            continue
        leads = _bm_radial_leaders(cx, cy, a, lines)
        if not leads:
            continue
        # 同心同尺度完整圈一并成组删除（双环结构）
        for f in msp.query("ELLIPSE"):
            b = f.dxf.major_axis.magnitude
            if not (10 <= b <= 50 and 0.45 <= f.dxf.ratio <= 0.75):
                continue
            off = math.hypot(f.dxf.center.x - cx, f.dxf.center.y - cy)
            full = abs((f.dxf.end_param - f.dxf.start_param) - 2 * math.pi) <= 0.05
            if full and off < 5 and abs(b - a) < 25:
                bubble_ids.add(id(f))
            # 规则2：与泡泡同心的同尺寸「部分弧」＝泡泡画圆时的残影复本，
            # 现行完整圈判定会漏掉。K型 实测 9 处 22 颗，红绿叠图确认全是
            # 泡泡复本、非零件几何（2026-10-10）。阈值照流程笔记：偏移<15、|Δa|<5。
            elif (not full) and off < 15 and abs(b - a) < 5:
                bubble_ids.add(id(f))
        leader_ids.update(id(L) for L in leads)
    return bubble_ids, leader_ids


def _bm_heads(msp, lines, texts, balloons, axis_lines, axis_gate, block_mode):
    """策略⑧（S1 半圆头波）：无编号气球头＋引线链。回传 (head_ids, chain_ids)。

    气球不一定画成「满圆」：S1 是 a=10 sweep=180° 的半圆头（外加一条
    129.6 长的折引线），另有一颗 a=15.5 sweep=314° 的近圆头。它们不含数字、
    也不在轴线上，上面两条规则都漏抓 → 头和引线都留在图上（使用者回报 S1）。
    三道闸门，基准都是「本图的编号气球」，阈值自动标定（见 _bm_axis_gate /
    下方 CROWD_GATE），换图不用手调：
      ① 距组立轴线 > AXIS_GATE（= 气球最小距离×0.7；K型 58.8，气球 84~494、
         零件 0~16）
      ② 1.5×尺寸内浮空点 ≤ CROWD_GATE（= 气球 crowd 最大值；K型 气球实测
         [0×25, 1×10] → 1。刚好挡掉一颗 crowd=2 的存疑头——它旁边有同心
         a=4.5 环、又贴 a=80 零件弧，更像零件特征，使用者也没回报它）
      ③ 引线不是编号气球的引线（编号气球指的一定是零件）
    """
    axis_id = {id(L) for L in axis_lines}

    # 自动标定②：浮空闸门 = 编号气球 crowd 的「最大值」。
    # 语意＝「气球头不能比最拥挤的真气球更拥挤」。注意量测口径必须和候选头一致
    # （都要过 family_of，它会排除自家同心圈与引线），否则不可比——K型 实测
    # 气球分布 = [0×25, 1×10]，max = 1；刚好挡掉一颗 crowd=2 的存疑头
    # （有同心 a=4.5 环、又贴 a=80 零件弧，像零件特征，使用者也没回报它），
    # 同时放行 S1 的 crowd=1 半圆头。K型 标定结果 = 1（原本硬编码 1，等价）。
    _bc = ([] if block_mode else          # block 模式头规则已停用，省掉 O(n²) 标定
           [_bm_crowd(b["x"], b["y"], b["r"] * 1.5,
                      _bm_family_of(b["x"], b["y"], msp, lines), msp, axis_id)
            for b in balloons])
    CROWD_GATE = max(_bc) if _bc else 1

    head_ids, chain_ids = set(), set()
    for e in (msp if not block_mode else []):
        if e.dxftype() not in ("ELLIPSE", "ARC"):
            continue
        sz = _bm_geom_size(e)
        if not 6 <= sz <= 50 or _bm_geom_sweep(e) < 150:
            continue
        cx, cy = e.dxf.center.x, e.dxf.center.y
        if _bm_num_text_inside(cx, cy, sz, texts):
            continue                      # 有数字 → 已走配对路径
        if _bm_d_axis(cx, cy, axis_lines) <= axis_gate:
            continue                      # 闸门①：坐在组立轴线上 = 零件
        leads = [L for L in lines
                 if min(math.hypot(L.dxf.start.x - cx, L.dxf.start.y - cy),
                        math.hypot(L.dxf.end.x - cx, L.dxf.end.y - cy)) <= sz * 1.5
                 and max(math.hypot(L.dxf.start.x - cx, L.dxf.start.y - cy),
                         math.hypot(L.dxf.end.x - cx, L.dxf.end.y - cy)) > sz * 2]
        if not leads:
            continue
        if _bm_has_balloon_leader(leads, balloons):
            continue                      # 闸门③：编号气球指向它 = 零件
        drop = _bm_family_of(cx, cy, msp, lines)
        if _bm_crowd(cx, cy, sz * 1.5, drop, msp, axis_id) > CROWD_GATE:
            continue                      # 闸门②：不浮空 = 零件
        head_ids.add(id(e))
        # 沿引线链延伸到碰到零件为止（S1 的折线引线共 2 段）
        pending = list(leads)
        guard = 0
        while pending and guard < 40:
            guard += 1
            L = pending.pop()
            if id(L) in chain_ids:
                continue
            chain_ids.add(id(L))
            for p in (L.dxf.start, L.dxf.end):
                if math.hypot(p.x - cx, p.y - cy) <= sz * 1.5:
                    continue              # 这一端是头
                if _bm_nonline_touch(p.x, p.y, chain_ids | head_ids, msp):
                    continue              # 碰到零件 → 停
                for M in lines:
                    if id(M) in chain_ids:
                        continue
                    if min(math.hypot(M.dxf.start.x - p.x, M.dxf.start.y - p.y),
                           math.hypot(M.dxf.end.x - p.x, M.dxf.end.y - p.y)) <= 2.5:
                        pending.append(M)
    return head_ids, chain_ids


def _bm_keep_drop(msp, circles, paired, extra_circles, extra_leaders,
                  leader_ids, bubble_ids,
                  balloon_arc_ids, head_ids, chain_ids, balloons, block_mode,
                  doc, layer_lt):
    """策略⑨：终局 keep/drop 判决（8 代策略的汇流点，block/classic 共用）。

    回传 (keep, tips, dropped_lids, counters)。
    tips 仅 block 模式有意义：引线远端点 (x, y, 气球索引)，供
    assign_components 认领分量。
    """
    keep = []
    dropped_lids = set()          # 被当引线/假想线丢掉的 LINE id（诊断用）
    tips = []                     # block 模式：引线远端点 (x, y, 气球索引)
    n_drop_c = n_drop_l = n_dash = n_bub = 0
    for e in msp:
        t = e.dxftype()
        if t == "CIRCLE":
            ci = next((i for i, c in enumerate(circles) if c is e), None)
            if ci in paired or ci in extra_circles:
                n_drop_c += 1
                continue
        if id(e) in leader_ids:
            n_drop_l += 1
            dropped_lids.add(id(e))
            continue
        if id(e) in bubble_ids:
            n_bub += 1
            continue
        if id(e) in balloon_arc_ids:
            n_drop_c += 1
            continue
        if id(e) in head_ids:
            n_bub += 1
            continue
        if id(e) in chain_ids:
            n_drop_l += 1
            dropped_lids.add(id(e))
            continue
        hit = _bm_edge_leader(e, balloons) if block_mode else _bm_is_leader(e, balloons, extra_leaders)
        if hit:
            if block_mode:
                tips.append(hit)
            n_drop_l += 1
            dropped_lids.add(id(e))
            continue
        if _BM_DASH_RE.search(_bm_linetype_of(e, doc, layer_lt) or ""):
            n_dash += 1
            dropped_lids.add(id(e))
            continue
        keep.append(e)
    return keep, tips, dropped_lids, {"c": n_drop_c, "l": n_drop_l,
                                      "dash": n_dash, "bub": n_bub}


def balloon_mode(doc, msp):
    """CIRCLE+数字 TEXT 配对当气球：归组 + 丢气球圆与贴圆缘引线。

    管线（各策略详见对应 _bm_* 函式，历史标定数据随函式保存）：
      ① _bm_pair_circle_text    CIRCLE+TEXT 基底配对
      ② _bm_calibrate_radius    半径自动标定（K型 27±3）
      ③ _bm_add_arc_balloons    ARC 型气球（K型波）
      ④ _bm_collect_block_balloons  件号 block 气球（诚岱46批；与①③互斥）
      ⑤ _bm_orphan_circles      孤圈＋贴圈缘引线（block 模式停用）
      ⑥ _bm_axis_gate           组立轴线闸门（自动标定①）
      ⑦ _bm_bubbles             注记泡泡＋同心残影（block 模式停用）
      ⑧ _bm_heads               无编号气球头＋引线链（S1 波；block 模式停用；
                                含自动标定② CROWD_GATE）
      ⑨ _bm_keep_drop           终局判决（block/classic 共用）
    归组：block → assign_components（tip 认领）；classic → assign_segments。
    """
    texts = [e for e in msp if e.dxftype() == "TEXT" and NUM_RE.match(e.dxf.text.strip())]
    circles = [e for e in msp if e.dxftype() == "CIRCLE"]
    lines = msp.query("LINE")

    # ①② 基底配对＋半径标定
    balloons, paired = _bm_pair_circle_text(texts, circles)
    r_med, arc_r_lo, arc_r_hi = _bm_calibrate_radius(circles, paired)
    # ③ ARC 气球（K型波）
    balloon_arc_ids = _bm_add_arc_balloons(texts, msp, balloons, arc_r_lo, arc_r_hi)
    # ④ 件号 block 气球（诚岱46批）——CIRCLE+TEXT/ARC 配对都落空才走这条
    block_mode = False
    if not balloons:
        balloons = _bm_collect_block_balloons(msp)
        block_mode = bool(balloons)
    if not balloons:
        raise SystemExit("无 P 图层，也找不到 CIRCLE+数字 TEXT 配对——先在 CAD 分层再跑")

    # ⑤ 孤圈＋贴圈缘引线
    extra_circles, extra_leaders = _bm_orphan_circles(circles, paired, lines, block_mode)
    # ⑥ 组立假想线（虚线线型整批不进图）＋轴线闸门自动标定
    layer_lt = {}
    axis_lines = [L for L in lines
                  if _BM_DASH_RE.search(_bm_linetype_of(L, doc, layer_lt) or "")]
    axis_gate = _bm_axis_gate(balloons, axis_lines)
    # ⑦ 注记泡泡（无文字版）
    bubble_ids, leader_ids = _bm_bubbles(msp, lines, axis_lines, axis_gate, block_mode)
    # ⑧ 无编号气球头＋引线链
    head_ids, chain_ids = _bm_heads(msp, lines, texts, balloons,
                                    axis_lines, axis_gate, block_mode)
    # ⑨ 终局 keep/drop
    keep, tips, dropped_lids, cnt = _bm_keep_drop(
        msp, circles, paired, extra_circles, extra_leaders, leader_ids,
        bubble_ids, balloon_arc_ids, head_ids, chain_ids, balloons,
        block_mode, doc, layer_lt)

    segs = collect_segments(doc, entities=keep)
    if block_mode:
        groups, labels, n_unassigned = assign_components(segs, balloons, tips)
    else:
        groups_raw, unassigned = assign_segments(segs, balloons, ASSIGN_THRESHOLD)
        groups, labels = {}, {}
        for n, ss in groups_raw.items():
            if ss:
                key = "P%02d" % int(n)
                groups[key] = ss
                labels[key] = "%s-part" % key
        n_unassigned = len(unassigned)
    # 诊断转储：给「泡泡线逐张检查」用（唯读，不影响输出）
    globals()["LAST_DEBUG"] = {
        "keep": keep, "dropped_lids": dropped_lids,
        "bubble_ids": bubble_ids, "head_ids": head_ids,
        "chain_ids": chain_ids, "extra_circles": extra_circles,
        "extra_leaders": extra_leaders, "balloons": balloons,
    }
    return groups, labels, {"dropped_circles": cnt["c"],
                            "dropped_leaders": cnt["l"],
                            "dropped_bubbles": cnt["bub"],
                            "dropped_heads": len(head_ids),
                            "dropped_dashed": cnt["dash"],
                            "unassigned_dropped": n_unassigned}


def connected_components(segs):
    """并查集分量：端点落同 1.0 网格即相连（归组与人工 override 共用）。"""
    parent = list(range(len(segs)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    grid = {}
    for i, s in enumerate(segs):
        for p in ((s[0], s[1]), (s[2], s[3])):
            grid.setdefault((round(p[0]), round(p[1])), []).append(i)
    for lst in grid.values():
        for j in lst[1:]:
            parent[find(lst[0])] = find(j)
    comps = {}
    for i in range(len(segs)):
        comps.setdefault(find(i), []).append(segs[i])
    return list(comps.values())


def assign_components(segs, balloons, tips):
    """block 模式归组：连通分量＋锚定区域生长（2026-10-21 重写）。

    旧规则「每颗 tip 只认领最近一个分量，其余分量按最近 tip、半径＝对角线
    10% 兜底」实测 86% 的分量走兜底、半径 716 单位（零件间距 100–300），
    造成两种症状：邻件碎块被吸进来（两件一起变红）、本件分量被吸走或丢弃
    （只红一半／少线）。新规则：
      1. keep 段按共端点（≤1.0）连成连通分量
      2. tip 认领锚分量（≤80，同旧制）；无引线气球用圆心当伪 tip
      3. 从锚往外区域生长：与「本件已收几何」距离 ≤ 对角线 1.5% 的分量
         吸附进来，先近后远，一个分量只归一件
      4. 仍无主的分量：最近 tip ≤ 对角线 3%，且 d1 < 0.6·d2（明显较近）
         才收；否则画成无标签的「未归组」群（不再整段丢线）
      5. 外图框（≤12 段、框大于全幅 1/4、框内含 ≥80% 线段）直接删除；视图框保留
    """
    if not segs:
        return {}, {}, 0
    xs = [s[0] for s in segs] + [s[2] for s in segs]
    ys = [s[1] for s in segs] + [s[3] for s in segs]

    # 1) 连通分量（并查集逻辑抽成 connected_components，override 共用）
    comp_list = connected_components(segs)

    def pts_of_comp(c):
        return [(s[0], s[1]) for s in c] + [(s[2], s[3]) for s in c]

    def bbox_of(pts):
        xs_ = [p[0] for p in pts]
        ys_ = [p[1] for p in pts]
        return (min(xs_), min(ys_), max(xs_), max(ys_))

    # 1b) 删「整张图的外框」：少段数的大框，且框内含 ≥80% 的线段。
    #     只包住局部零件组的视图框（框内只占少数）保留。
    gx0, gy0 = min(xs), min(ys)
    gx1, gy1 = max(xs), max(ys)
    garea = ((gx1 - gx0) or 1.0) * ((gy1 - gy0) or 1.0)
    keep, n_frame = [], 0
    for c in comp_list:
        bb = bbox_of(pts_of_comp(c))
        if len(c) > 12 or (bb[2] - bb[0]) * (bb[3] - bb[1]) < 0.25 * garea:
            keep.append(c)
            continue
        inside = 0
        total = 0
        for other in comp_list:
            if other is c:
                continue
            for s in other:
                mx, my = (s[0] + s[2]) / 2, (s[1] + s[3]) / 2
                total += 1
                if bb[0] - 5 <= mx <= bb[2] + 5 and bb[1] - 5 <= my <= bb[3] + 5:
                    inside += 1
        if total and inside >= 0.8 * total:
            n_frame += 1
            continue
        keep.append(c)
    comp_list = keep

    cpts = [pts_of_comp(c) for c in comp_list]
    cbb = [bbox_of(p) for p in cpts]
    allx = [p[0] for p in cpts for p in p] or [0.0]
    ally = [p[1] for p in cpts for p in p] or [0.0]
    dia = math.hypot(max(allx) - min(allx), max(ally) - min(ally))

    # 2) 无引线气球：圆心当伪 tip
    tips = list(tips)
    have = {bi for _, _, bi in tips}
    for bi, b in enumerate(balloons):
        if bi not in have:
            tips.append((b["cx"], b["cy"], bi))

    # 3) tip 认领锚分量（≤80，取最近）
    owners = [set() for _ in comp_list]
    for tx, ty, bi in tips:
        best, bd = None, 1e18
        for ci, pts in enumerate(cpts):
            d = min(math.hypot(px - tx, py - ty) for px, py in pts)
            if d < bd:
                bd, best = d, ci
        if best is not None and bd <= 80:
            owners[best].add(bi)

    # 4) 锚定区域生长
    G = dia * 0.015                      # 生长间隙
    parts = {}                           # key -> {"pts": [...], "segs": [...]}
    ggrid = {}                           # (cell) -> [(key, x, y)]

    def add_pts(key, pts):
        for x, y in pts:
            ggrid.setdefault((int(x // G), int(y // G)), []).append((key, x, y))
        parts[key]["pts"].extend(pts)

    cdiag = [math.hypot(b[2] - b[0], b[3] - b[1]) for b in cbb]
    # bis / key 集合必须排序迭代：set 序随 PYTHONHASHSEED 变，会翻动
    # add_pts 的网格插入序 → 区域生长距离平手的 tie-break 不确定（同一支
    # DWG 两次转档群组不同的元凶，2026-10-22 修）。
    for ci, bis in enumerate(owners):
        if not bis:
            continue
        for bi in sorted(bis):
            key = "P%02d" % int(balloons[bi]["n"])
            parts.setdefault(key, {"pts": [], "segs": [], "diag": 0.0})
            parts[key]["segs"].extend(comp_list[ci])
            parts[key]["diag"] = max(parts[key]["diag"], cdiag[ci])
        for key in sorted({"P%02d" % int(balloons[bi]["n"]) for bi in bis}):
            add_pts(key, cpts[ci])

    unassigned = {ci for ci in range(len(comp_list)) if not owners[ci]}
    for _ in range(6):
        attached = 0
        for ci in sorted(unassigned):
            best, bk = 1e18, None
            for (x, y) in cpts[ci]:
                cell = (int(x // G), int(y // G))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for key, px, py in ggrid.get((cell[0] + dx, cell[1] + dy), ()):
                            d = math.hypot(x - px, y - py)
                            if d < best:
                                best, bk = d, key
            if bk is not None and best <= G:
                parts[bk]["segs"].extend(comp_list[ci])
                parts[bk]["diag"] = max(parts[bk]["diag"], cdiag[ci])
                add_pts(bk, cpts[ci])
                unassigned.discard(ci)
                attached += 1
        if not attached:
            break

    # 5) 剩下：明显较近的 tip 才收，否则进「未归组」
    loose = []
    for ci in sorted(unassigned):
        ds = []
        for tx, ty, bi in tips:
            ds.append((min(math.hypot(px - tx, py - ty) for px, py in cpts[ci]), bi))
        ds.sort()
        if len(ds) == 1:
            d1, d2 = ds[0][0], 1e18
        else:
            (d1, b1), (d2, _) = ds[0], ds[1]
        key = "P%02d" % int(balloons[ds[0][1]]["n"])
        if d1 <= dia * 0.03 and d1 < 0.6 * d2:
            parts.setdefault(key, {"pts": [], "segs": [], "diag": 0.0})
            parts[key]["segs"].extend(comp_list[ci])
            parts[key]["diag"] = max(parts[key]["diag"], cdiag[ci])
            add_pts(key, cpts[ci])
        else:
            loose.append(ci)

    groups, labels = {}, {}
    for key, st in parts.items():
        if st["segs"]:
            groups[key] = st["segs"]
            labels[key] = "%s-part" % key
    for ci in loose:
        groups.setdefault("X000", []).extend(comp_list[ci])
    # X000 不给 label → 检视页不会把它变成可 hover 的零件（避免一堆不相干
    # 碎段一起变红）；线仍然画出来，不丢资料。

    multi = sum(1 for o in owners if len({balloons[bi]["n"] for bi in o}) > 1)
    print("归组: 分量 %d / 删图框 %d / 多编号共管 %d / 群组 %d / 未归组分量 %d"
          % (len(comp_list), n_frame, multi, len(groups), len(loose)))
    return groups, labels, len(loose)


def choose_rotation(groups):
    """挑一个让「主轴水平 + 横式」的旋转角（0/90/180/270）。

    主轴＝以线段中点、长度加权的 PCA 主方向；分数 = 主轴离水平的角度
    （0–90°）+ 直式罚分 45°。同分取小角度，确保原本就正的水平图不动。
    """
    best_deg, best_score = 0, 1e9
    for deg in (0, 90, 180, 270):
        t = [s for v in groups.values() for s in flip_rot(v, deg)]
        if not t:
            continue
        xs = [s[0] for s in t] + [s[2] for s in t]
        ys = [s[1] for s in t] + [s[3] for s in t]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        n = mx = my = 0.0
        for x1, y1, x2, y2 in t:
            L = math.hypot(x2 - x1, y2 - y1) or 1e-6
            mx += (x1 + x2) / 2 * L
            my += (y1 + y2) / 2 * L
            n += L
        mx, my = mx / n, my / n
        cxx = cyy = cxy = 0.0
        for x1, y1, x2, y2 in t:
            L = math.hypot(x2 - x1, y2 - y1) or 1e-6
            px, py = (x1 + x2) / 2 - mx, (y1 + y2) / 2 - my
            cxx += L * px * px
            cyy += L * py * py
            cxy += L * px * py
        ang = 0.5 * math.atan2(2 * cxy, cxx - cyy)
        dev = abs(((ang + math.pi / 2) % math.pi) - math.pi / 2)
        score = math.degrees(dev) + (0 if w >= h else 180)
        if score < best_score - 1e-6:
            best_deg, best_score = deg, score
    return best_deg


def seg_point_dist(px, py, s):
    """点到线段的最短距离（投影钳位在段内）。"""
    x1, y1, x2, y2 = s
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / l2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def apply_overrides(xf, labels, ops, key=""):
    """人工指定归组修正（2026-10-22）：放大检视.html「修正模式」记录的 ops。

    每条 op = {"near": [x, y], "from": "P01", "to": "P02"|"X000"}——把离 near
    最近的连通分量整块从 from 搬到 to；X000 = 无主（照画、无标签、检视页
    不可 hover）。near 座标系＝flip_rot 后的输出 SVG，与预览页点击座标一致，
    旋转差异自动吸收。分量搬移不增删线段 → viewBox 不变，可当校验值。
    几何无解的案例（P01 螺栓 vs 配重块，两条引线端点同落一叠线）由此兜底。
    回传实际套用笔数。
    """
    applied = 0
    all_segs = [s for v in xf.values() for s in v]
    xs = [s[0] for s in all_segs] + [s[2] for s in all_segs]
    ys = [s[1] for s in all_segs] + [s[3] for s in all_segs]
    cap = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) * 0.02
    # 校验：录制时的 viewBox vs 本次重转（同 DWG 同旋转 → 应逐字相同；
    # 不同代表旋转/几何变了，near 可能失准——警告但不挡，由人判断）
    want_vb = next((o.get("viewBox") for o in ops if o.get("viewBox")), None)
    if want_vb:
        w_, h_ = ((max(xs) - min(xs)) or 1.0), ((max(ys) - min(ys)) or 1.0)
        pad_ = max(w_, h_) * 0.02
        got_vb = "%.2f %.2f %.2f %.2f" % (min(xs) - pad_, min(ys) - pad_,
                                          w_ + 2 * pad_, h_ + 2 * pad_)
        if got_vb != want_vb:
            print("override ⚠️ viewBox 不一致：录制=%s 现在=%s（near 可能失准）"
                  % (want_vb, got_vb))
    for op in ops:
        near, frm, to = op.get("near"), op.get("from"), op.get("to")
        if not (near and frm and to) or frm == to:
            print("override %s: 栏位不全或 from=to，跳过 %r" % (key, op))
            continue
        if frm not in xf:
            print("override %s: from=%s 不存在，跳过" % (key, frm))
            continue
        comps = connected_components([s for v in xf.values() for s in v])
        best, bd = None, 1e18
        for c in comps:
            d = min(seg_point_dist(near[0], near[1], s) for s in c)
            if d < bd:
                bd, best = d, c
        if best is None or bd > cap:
            print("override %s: 点击离任何线太远（%.0f > %.0f），跳过 %r"
                  % (key, bd, cap, op))
            continue
        cset = set(best)
        moved = [s for s in xf[frm] if s in cset]
        if not moved:
            owners = sorted(L for L, v in xf.items() if any(s in cset for s in v))
            print("override %s: from=%s 不含该分量（在 %s），跳过 %r"
                  % (key, frm, owners, op))
            continue
        xf[frm] = [s for s in xf[frm] if s not in cset]
        # to=无主且分量另有归宿 → 只丢 from 的复本即可，线不会消失；
        # 否则搬进 to（同段去重，共管分量搬两次不会画双线）
        if to != "X000" or not any(
                s in cset for L2, v in xf.items() if L2 != frm for s in v):
            dest = xf.setdefault(to, [])
            have = set(dest)
            dest.extend(s for s in moved if s not in have)
            if to != "X000":
                labels.setdefault(to, "%s-part" % to)
        if not xf[frm]:
            del xf[frm]
            labels.pop(frm, None)
        applied += 1
        print("override %s ✔ %s → %s（%d 段）" % (key, frm, to, len(moved)))
    return applied


def build(svg_path, groups, labels, bom_ids=(), rotate="auto", override_ops=None,
          stroke=None):
    all_segs = [s for v in groups.values() for s in v]
    if not all_segs:
        raise SystemExit("没有可画的线段")
    xs = [s[0] for s in all_segs] + [s[2] for s in all_segs]
    ys = [s[1] for s in all_segs] + [s[3] for s in all_segs]
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    w0, h0 = (maxx - minx) or 1.0, (maxy - miny) or 1.0

    # 自动转正：直式（高>宽）转成横式，与 p_type 参考稿方向一致。
    # 横式图不动 → p_type 回归输出逐位元组不变。可 --rotate 0/90/180/270 覆写。
    deg = (90 if h0 > w0 else 0) if rotate == "auto" else int(rotate)
    xf = {L: flip_rot(v, deg) for L, v in groups.items()}

    # 人工指定修正：在 flip_rot 之后套用——override 的 near 与输出 SVG 同座标
    # 系；搬移不增删线段，viewBox 与未套用时相同，录制值可校验重转一致性。
    if override_ops:
        apply_overrides(xf, labels, override_ops)

    tsegs = [s for v in xf.values() for s in v]
    txs = [s[0] for s in tsegs] + [s[2] for s in tsegs]
    tys = [s[1] for s in tsegs] + [s[3] for s in tsegs]
    tminx, tminy = min(txs), min(tys)
    w, h = (max(txs) - tminx) or 1.0, (max(tys) - tminy) or 1.0
    pad = max(w, h) * 0.02
    # 细齿图（齿轮/轴承齿距 < 预设笔画）会糊成实心黑块，--stroke 可覆写成细笔画
    sw = float(stroke) if stroke is not None else math.hypot(w, h) * 0.002

    def sort_key(L):
        m = PID_RE.match(L)
        return int(m.group(1)) if m else 9999

    parts = []
    for L in sorted(xf, key=sort_key):
        d = segs_to_svg_path(xf[L])
        if d:
            lab = labels.get(L, "")
            attr = ' inkscape:label="%s"' % esc(lab) if lab else ""
            parts.append('<g%s><path d="%s" fill="none" '
                         'stroke="#141413" stroke-width="%.3f"/></g>'
                         % (attr, d, sw))
    svg = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
           '<svg xmlns="http://www.w3.org/2000/svg" version="1.1"\n'
           '     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n'
           '     viewBox="%.2f %.2f %.2f %.2f">\n%s\n</svg>\n'
           % (tminx - pad, tminy - pad, w + 2 * pad, h + 2 * pad,
              "\n".join(parts)))
    with open(svg_path, "w", encoding="utf-8") as fh:
        fh.write(svg)

    ids = {m.group(1) for m in (re.match(r"(P\d+)", v) for v in labels.values()) if m}
    print("产出:", svg_path)
    print("旋转: %s%s（原 %.0f×%.0f → %.0f×%.0f）"
          % (deg, "°顺时针" if deg else "（不转）", w0, h0, w, h))
    print("零件群组 %d / 线段 %d" % (len(groups), len(all_segs)))
    if bom_ids:
        print("bom 交叉: 有图无bom =", sorted(ids - bom_ids) or "无",
              "| 有bom无图 =", sorted(bom_ids - ids) or "无")
    else:
        print("bom 交叉: 未提供 bom.csv（跳过）")


def main():
    args = sys.argv[1:]
    rotate = "auto"
    ov_path = key = None
    stroke = None
    if "--stroke" in args:
        i = args.index("--stroke")
        if i + 1 >= len(args):
            raise SystemExit("--stroke 需要数值（如 0.15）")
        stroke = args[i + 1]
        del args[i:i + 2]
    if "--rotate" in args:
        i = args.index("--rotate")
        if i + 1 >= len(args):
            raise SystemExit("--rotate 需要 0/90/180/270")
        rotate = args[i + 1]
        del args[i:i + 2]
    if "--overrides" in args:
        i = args.index("--overrides")
        if i + 1 >= len(args):
            raise SystemExit("--overrides 需要 JSON 路径")
        ov_path = args[i + 1]
        del args[i:i + 2]
    if "--key" in args:
        i = args.index("--key")
        if i + 1 >= len(args):
            raise SystemExit("--key 需要 相对路径（如 链条/190/超短小车）")
        key = args[i + 1]
        del args[i:i + 2]
    if len(args) < 2:
        raise SystemExit(__doc__)
    dwg, out = args[0], args[1]
    bom = args[2] if len(args) > 2 else None
    override_ops = []
    if ov_path:
        if not key:
            raise SystemExit("--overrides 需搭配 --key")
        with open(ov_path, encoding="utf-8") as fh:
            data = json.load(fh)
        entry = data.get(key) or {}
        override_ops = entry.get("ops") or []
        if key not in data:
            print("override: %s 无记录（表内 %d 档），照常输出" % (key, len(data)))
        elif override_ops:
            print("override: 套用 %d 笔" % len(override_ops))
    doc = ezdxf.readfile(convert_dwg(dwg, "/tmp/dwgextract"))
    msp = doc.modelspace()
    has_player = any(LAYER_RE.match(e.dxf.layer) for e in msp
                     if e.dxf.hasattr("layer"))
    if has_player:
        print("模式: layer（P 图层白名单）")
        groups, labels, stats = layer_mode(doc, msp)
    else:
        print("模式: balloon（CIRCLE+TEXT 气球归组）")
        groups, labels, stats = balloon_mode(doc, msp)
        if rotate == "auto":
            rotate = choose_rotation(groups)   # 主轴水平＋横式
    # 标签正规化：Pnn-part → Pnn-品名（bom Name）；其他格式修乱码
    names = read_bom_names(bom)
    for k in list(labels):
        labels[k] = fix_mojibake(labels[k])
        if k in names:
            labels[k] = "%s-%s" % (k, names[k])
    print("统计:", stats)
    build(out, groups, labels, read_bom_ids(bom), rotate=rotate,
          override_ops=override_ops, stroke=stroke)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DWG → EzBOM drawing.svg（2026-10-09 定版流程，見 Obsidian DWG轉EzBOM流程.md）

用法:
    python3 dwg2drawing.py <in.dwg> <out.svg> [bom.csv] [--rotate auto|0|90|180|270]
                          [--overrides overrides.json --key 相對路徑]

--rotate 預設 auto：直式（高>寬）自動順時針轉 90° 成橫式，與 p_type 參考稿
（p_type.dxf.svg，8400×5940）方向一致；橫式不動。p_type 橫式故回歸輸出不變。

--overrides：放大檢視.html「修正模式」記錄的人工歸組修正表（JSON），
  以 --key（相對於 產品手冊46 的路徑去副檔名，如 鏈條/190/超短小車）取用。
  幾何規則分不出來的吃線錯誤（兩條引線端點落在同一疊線上）由此兜底。

模式自動選擇:
  1. layer   — 存在 ^P\\d+- 圖層：按圖層分組（標籤=圖層名，與手工版同源），
               丟棄全部非 P 層（p_type 實測：層5=引線、層7=串聯中心線+氣球、0/8=標題）。
  2. balloon — 無 P 層，但有 CIRCLE+數字 TEXT 成對：氣球歸組（手冊批同款 assign），
               丟棄配對圓與貼圓緣引線（K型齿轮箱 路線）。
bom.csv 可選：提供時做 P-id 交叉比對（注意 bom 本身無法從 DWG 產出，
料號/品名/數量只能來自清冊或 ERP）。

依賴：BOM樹狀圖/_build/dwg_extract.py（convert_dwg / collect_segments /
extract 分組碼；橢圓旋轉與 bulge 修正皆在該檔，2026-10-09）。
"""
import csv
import json
import math
import os
import re
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
EXTRACT_DIR = "/Users/zone/Documents/Study/B0M研究/BOM樹狀圖/_build"
sys.path.insert(0, EXTRACT_DIR)

from dwg_extract import (convert_dwg, collect_segments, assign_segments,
                         ASSIGN_THRESHOLD, BALLOON_BLOCK)
from dwg_merge import segs_to_svg_path
import ezdxf

LAYER_RE = re.compile(r"^P(\d+)-")
NUM_RE = re.compile(r"^\d+$")


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def flip(segs):
    """CAD y-up → SVG y-down。"""
    return [(x1, -y1, x2, -y2) for x1, y1, x2, y2 in segs]


def flip_rot(segs, deg):
    """CAD y-up → SVG y-down，再把畫面旋轉 deg 度（順時針）。

    SVG 座標 y 向下，順時針 90° 的變換是 (x, y) → (-y, x)：
    原本在左上角的內容會跑到右上角。K型 DWG 在 WCS 裡是直式
    （viewBox 1863×2594），p_type 參考稿是橫式（8400×5940），
    使用者 2026-10-10 裁定直式圖一律轉正成橫式。
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
                ids.add((row.get("Id") or row.get("標籤ID") or "").strip())
    return ids


def read_bom_names(path):
    """Id → 品名（bom.csv 的 Name 欄）。"""
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
    """UTF-8 位元組被當 Latin-1 再存一次的救援（p_type 標籤的病灶）。"""
    if not s or not re.search(r"[ÃÂåæçèéê][\u0080-¿]", s):
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def layer_mode(doc, msp):
    """P 圖層白名單：分組=圖層名，非 P 層（引線/中心線/氣球/標題）全丟。"""
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
    labels = {L: L for L in groups}          # 標籤直接用圖層名
    return groups, labels, {"dropped_layers": True}


def balloon_mode(doc, msp):
    """CIRCLE+數字 TEXT 配對當氣球：歸組 + 丟氣球圓與貼圓緣引線。"""
    texts = [e for e in msp if e.dxftype() == "TEXT" and NUM_RE.match(e.dxf.text.strip())]
    circles = [e for e in msp if e.dxftype() == "CIRCLE"]
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
    # ── 自動標定 ────────────────────────────────────────────────────────────
    # 下面三個閾值本來是照 K型 一張圖量出來寫死的（d_axis>60 / crowd≤1 /
    # ARC r∈[24,30]），換圖要手動複驗。改成從「本圖已配對的編號氣球」推導，
    # 換圖自動跟著走。K型 標定結果 = 原硬編碼值（驗收：輸出須逐位元組一致）。
    paired_r = sorted(circles[i].dxf.radius for i in paired)
    r_med = paired_r[len(paired_r) // 2] if paired_r else 27.0
    ARC_R_LO, ARC_R_HI = r_med - 3, r_med + 3        # K型: 27±3 = [24,30]

    # 氣球不一定畫成 CIRCLE：K型 氣球#16 畫成 ARC r=27、sweep=355°（數字 16 就在
    # 圈內），配對只認 CIRCLE 所以漏配——流程筆記記的「文字16 無圈」其實是偵測缺口，
    # 不是源圖缺口。sweep≥270 才算整圈（同半徑的零件弧 sweep 只有 13~24°，不會誤配）。
    balloon_arc_ids = set()
    for t in texts:
        tx, ty = t.dxf.insert.x, t.dxf.insert.y
        if any(math.hypot(tx - b["x"], ty - b["y"]) <= b["r"] for b in balloons):
            continue
        for a in msp.query("ARC"):
            if id(a) in balloon_arc_ids:
                continue
            r = a.dxf.radius
            if not ARC_R_LO <= r <= ARC_R_HI:
                continue
            if (a.dxf.end_angle - a.dxf.start_angle) % 360 < 270:
                continue
            if math.hypot(tx - a.dxf.center.x, ty - a.dxf.center.y) <= r:
                balloons.append({"n": int(t.dxf.text.strip()),
                                 "x": a.dxf.center.x, "y": a.dxf.center.y,
                                 "r": r})
                balloon_arc_ids.add(id(a))
                break

    # ── 件號 block 氣球（誠岱 46 支可讀批次）────────────────────────────
    # 誠岱手冊 DWG 的編號不是 TEXT+CIRCLE，而是「件號」block 的 ATTRIB 屬性
    # （同 dwg_extract.extract_balloons 邏輯，2026-10-10 實測這批唯一的氣球
    # 形式）。CIRCLE+TEXT/ARC 配對都落空才走這條——兩條路互斥，p_type/K型
    # 的回歸輸出因此逐位元組不變。
    block_mode = False
    if not balloons:
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
            # 半徑取 block 內部 CIRCLE 最大者（引線/閘門量測都要半徑）；
            # 內部無圈退回 27（K型 編號圈實測半徑，只當尺度參考）。
            r = 0.0
            cx = cy = None
            try:
                for v in e.virtual_entities():
                    if v.dxftype() == "CIRCLE" and v.dxf.radius > r:
                        r = v.dxf.radius
                        cx, cy = v.dxf.center.x, v.dxf.center.y
            except Exception:
                pass
            # 真圈心：件號 block 的插入點落在圓周右緣（離圈心恰為 r），
            # 引線量測必須用圈心——用 insert 會漏掉對側引線（超短小車實測
            # 殘留 52/139）且誤殺貼 insert 的零件短線（8 支代表圖層0 誤殺 33）。
            balloons.append({"n": n, "x": e.dxf.insert.x, "y": e.dxf.insert.y,
                             "r": r or 27.0,
                             "cx": cx if cx is not None else e.dxf.insert.x,
                             "cy": cy if cy is not None else e.dxf.insert.y})
        block_mode = bool(balloons)

    if not balloons:
        raise SystemExit("無 P 圖層，也找不到 CIRCLE+數字 TEXT 配對——先在 CAD 分層再跑")

    # 漏網氣球：圈沒配到文字、但圈緣有線端點貼著（引線）→ 同樣當氣球移除。
    # p_type/K型 實測都出現過這種孤圈；只刪「一端貼圈(≤1.5r)、另一端在 2r 外」
    # 的線，避免誤殺穿過孔位的中心線。
    lines = msp.query("LINE")
    extra_circles, extra_leaders = set(), set()

    def endpoint_d(p, b):
        return math.hypot(p.x - b["x"], p.y - b["y"])

    for i, c in enumerate(circles):
        if block_mode:
            break          # block 模式：頂層圈全是零件，孤圈規則會誤殺
        if i in paired:
            continue
        b = {"x": c.dxf.center.x, "y": c.dxf.center.y, "r": c.dxf.radius}
        touch = [e for e in lines
                 if min(endpoint_d(e.dxf.start, b), endpoint_d(e.dxf.end, b))
                 <= b["r"] * 1.5
                 and max(endpoint_d(e.dxf.start, b), endpoint_d(e.dxf.end, b))
                 > b["r"] * 2]
        if touch:
            extra_circles.add(i)
            extra_leaders.update(id(e) for e in touch)

    def is_leader(e):
        if e.dxftype() != "LINE":
            return False
        if id(e) in extra_leaders:
            return True
        for p in (e.dxf.start, e.dxf.end):
            for b in balloons:
                if math.hypot(p.x - b["x"], p.y - b["y"]) <= b["r"] * 1.3:
                    return True
        return False

    # ── block 模式引線判別（2026-10-19）──────────────────────────────────
    # 誠岱手冊批的氣球＝件號 block：引線是獨立 LINE，一端落在圓周上、他端
    # 指向零件。4 支代表圖實測判別力完全分離：「一端 |d−圈心 r| ≤ 0.3r 且
    # 他端 ≥ 2r」命中 131/139、30/30、84/84、85/82，100% 落在專屬引線圖層
    # （層4/5），層0 零件線零命中。tol 0.15r↔0.30r 命中數完全相同＝閾值不敏感。
    # 取代 insert 量測的舊 is_leader（量測基準錯，見上方真圈心註解）。
    def edge_leader(e):
        # 命中回傳 (tip_x, tip_y, 氣球索引)：遠端點＝引線指向零件的那一頭，
        # 歸組（assign_components）靠它認領分量。tuple 恆 truthy，舊布林用法
        # 不受影響。迭代順序＝氣球外層（與 10/20 原型一致，保證輸出同位）。
        if e.dxftype() != "LINE":
            return None
        for bi, b in enumerate(balloons):
            for p, q in ((e.dxf.start, e.dxf.end), (e.dxf.end, e.dxf.start)):
                if abs(math.hypot(p.x - b["cx"], p.y - b["cy"]) - b["r"]) \
                        <= b["r"] * 0.3 \
                        and math.hypot(q.x - b["cx"], q.y - b["cy"]) >= b["r"] * 2.0:
                    return q.x, q.y, bi
        return None

    # 組立假想線：虛線線型（ISO12/PHANTOM/CENTER/DASHED…）的實體整批不進圖。
    # K型 圖層2 = ACAD_ISO12W100（ISO 虛線）＝零件中間的組立假想線，實測釘死。
    dash_re = re.compile(r"ISO12|PHANTOM|CENTER|DASHED|ADJPHANT|DOT", re.I)
    layer_lt = {}

    def linetype_of(e):
        if e.dxf.hasattr("linetype") and e.dxf.linetype not in ("BYLAYER", "ByLayer"):
            return e.dxf.linetype
        L = e.dxf.layer if e.dxf.hasattr("layer") else "0"
        if L not in layer_lt:
            try:
                layer_lt[L] = doc.layers.get(L).dxf.linetype
            except Exception:
                layer_lt[L] = "CONTINUOUS"
        return layer_lt[L]

    # ── 組立軸線 ────────────────────────────────────────────────────────────
    # K型 層2 = ACAD_ISO12W100（ISO 虛線）＝零件中間的組立假想線。軸線的「端點
    # 正好落在零件中心」，radial_leaders 的「一端貼 ≤1.35a、另一端 ≥2.5a」對它
    # 永遠成立 → 坐在軸線上的軸承圈全被誤判成泡泡刪掉（2026-10-10 實測 13 顆
    # 全是零件，另加重規則2 的部分弧共 30 顆）。
    # 判別力（同一份圖量的）：
    #   34 顆編號氣球 距軸線 84 ~ 494（中位 128）
    #   13 顆被誤刪的軸承 距軸線 0 ~ 16
    # 完全分離，故閘門取 60（留安全邊距）。
    axis_lines = [L for L in lines if dash_re.search(linetype_of(L) or "")]

    def d_axis(px, py):
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

    # 自動標定①：離軸閘門 = 編號氣球距軸線「最小值」×0.7。
    # 原理：氣球永遠畫在軸線外、零件永遠坐在軸線上；取最貼近軸線的那顆氣球再
    # 打 7 折當安全邊距。K型：min=84 → 58.8（原本硬編碼 60，等價）。
    axis_d = sorted(d_axis(b["x"], b["y"]) for b in balloons)
    AXIS_GATE = max(10.0, axis_d[0] * 0.7) if axis_d else 60.0

    # 註記泡泡（無文字版）：完整等軸測圈 a∈[10,50] 若帶徑向引線
    # （一端貼圈 ≤1.35a、另端 ≥2.5a）＝沒有號碼的註記圈。
    # ⚠️ 這條規則很容易被兩個東西騙過，都已加閘門：
    #   ① 組立軸線（端點落在零件中心 → 條件永遠成立）→ AXIS_GATE 擋
    #   ② 編號氣球的引線（氣球指的一定是零件）→ 下方 has_balloon_leader 擋
    # K型 修前因此誤刪 13 顆軸承（雙同心圈 a=27.8+35.0 當時被誤記成「使用者指的
    # 泡泡球」，實測那些全是零件）；加閘門後 13 → 0。
    # ⚠️ block 模式（手冊批）整組停用：這批圖的等軸測橢圓（ratio 0.58≈cos54.7°）
    # 全是零件面——超短小車實測「滿圈註記泡泡」判定 chain 吃掉相鄰 a=13.5 半橢圓
    # （鏈條鏈環），正是使用者 2026-10-19 點名的「零件輪廓線不能刪」。
    def radial_leaders(cx, cy, rr):
        out = []
        for L in lines:
            d1 = math.hypot(L.dxf.start.x - cx, L.dxf.start.y - cy)
            d2 = math.hypot(L.dxf.end.x - cx, L.dxf.end.y - cy)
            if min(d1, d2) <= rr * 1.35 and max(d1, d2) >= rr * 2.5:
                out.append(L)
        return out

    bubble_ids, leader_ids = set(), set()
    for e in ([] if block_mode else msp.query("ELLIPSE")):
        a = e.dxf.major_axis.magnitude
        if not (10 <= a <= 50 and 0.45 <= e.dxf.ratio <= 0.75):
            continue
        if abs((e.dxf.end_param - e.dxf.start_param) - 2 * math.pi) > 0.05:
            continue
        cx, cy = e.dxf.center.x, e.dxf.center.y
        # 閘門：坐在組立軸線上的一定是零件（見上方 d_axis 說明）。
        if d_axis(cx, cy) <= AXIS_GATE:
            continue
        leads = radial_leaders(cx, cy, a)
        if not leads:
            continue
        # 同心同尺度完整圈一併成組刪除（雙環結構）
        for f in msp.query("ELLIPSE"):
            b = f.dxf.major_axis.magnitude
            if not (10 <= b <= 50 and 0.45 <= f.dxf.ratio <= 0.75):
                continue
            off = math.hypot(f.dxf.center.x - cx, f.dxf.center.y - cy)
            full = abs((f.dxf.end_param - f.dxf.start_param) - 2 * math.pi) <= 0.05
            if full and off < 5 and abs(b - a) < 25:
                bubble_ids.add(id(f))
            # 規則2：與泡泡同心的同尺寸「部分弧」＝泡泡畫圓時的殘影複本，
            # 現行完整圈判定會漏掉。K型 實測 9 處 22 顆，紅綠疊圖確認全是
            # 泡泡複本、非零件幾何（2026-10-10）。閾值照流程筆記：偏移<15、|Δa|<5。
            elif (not full) and off < 15 and abs(b - a) < 5:
                bubble_ids.add(id(f))
        leader_ids.update(id(L) for L in leads)

    # ── 無編號氣球頭 + 它的引線鏈 ──────────────────────────────────────────
    # 氣球不一定畫成「滿圓」：S1 是 a=10 sweep=180° 的半圓頭（外加一條
    # 129.6 長的折引線），另有一顆 a=15.5 sweep=314° 的近圓頭。它們不含數字、
    # 也不在軸線上，上面兩條規則都漏抓 → 頭和引線都留在圖上（使用者回報 S1）。
    # 三道閘門，基準都是「本圖的編號氣球」，閾值自動標定（見上方 AXIS_GATE /
    # CROWD_GATE），換圖不用手調：
    #   ① 距組立軸線 > AXIS_GATE（= 氣球最小距離×0.7；K型 58.8，氣球 84~494、
    #      零件 0~16）
    #   ② 1.5×尺寸內浮空點 ≤ CROWD_GATE（= 氣球 crowd 最大值；K型 氣球實測
    #      [0×25, 1×10] → 1。剛好擋掉一顆 crowd=2 的存疑頭——它旁邊有同心
    #      a=4.5 環、又貼 a=80 零件弧，更像零件特徵，使用者也沒回報它）
    #   ③ 引線不是編號氣球的引線（編號氣球指的一定是零件）
    axis_id = {id(L) for L in axis_lines}

    def geom_size(e):
        return e.dxf.major_axis.magnitude if e.dxftype() == "ELLIPSE" else e.dxf.radius

    def geom_sweep(e):
        if e.dxftype() == "ELLIPSE":
            return math.degrees((e.dxf.end_param - e.dxf.start_param) % (2 * math.pi))
        return (e.dxf.end_angle - e.dxf.start_angle) % 360

    def pts_of(e, n=8):
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
                    out.extend(pts_of(v, 6))
            except Exception:
                pass
            return out
        return []

    def num_text_inside(x, y, r):
        return any(math.hypot(t.dxf.insert.x - x, t.dxf.insert.y - y) <= r for t in texts)

    def has_balloon_leader(ls):
        for L in ls:
            for b in balloons:
                d1 = math.hypot(L.dxf.start.x - b["x"], L.dxf.start.y - b["y"])
                d2 = math.hypot(L.dxf.end.x - b["x"], L.dxf.end.y - b["y"])
                if min(d1, d2) <= b["r"] * 1.4:
                    return True
        return False

    def family_of(cx, cy):
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

    def crowd(cx, cy, R, drop):
        n = 0
        for e in msp:
            if id(e) in drop:
                continue
            if id(e) in axis_id:
                continue
            for x, y in pts_of(e, 6):
                if math.hypot(x - cx, y - cy) <= R:
                    n += 1
                    break
        return n

    def nonline_touch(px, py, exclude):
        for e in msp:
            if id(e) in exclude or e.dxftype() == "LINE":
                continue
            for x, y in pts_of(e, 8):
                if math.hypot(x - px, y - py) <= 2.5:
                    return True
        return False

    # 自動標定②：浮空閘門 = 編號氣球 crowd 的「最大值」。
    # 語意＝「氣球頭不能比最擁擠的真氣球更擁擠」。注意量測口徑必須和候選頭一致
    # （都要過 family_of，它會排除自家同心圈與引線），否則不可比——K型 實測
    # 氣球分佈 = [0×25, 1×10]，max = 1；剛好擋掉一顆 crowd=2 的存疑頭
    # （有同心 a=4.5 環、又貼 a=80 零件弧，像零件特徵，使用者也沒回報它），
    # 同時放行 S1 的 crowd=1 半圓頭。K型 標定結果 = 1（原本硬編碼 1，等價）。
    _bc = ([] if block_mode else          # block 模式頭規則已停用，省掉 O(n²) 標定
           [crowd(b["x"], b["y"], b["r"] * 1.5, family_of(b["x"], b["y"]))
            for b in balloons])
    CROWD_GATE = max(_bc) if _bc else 1

    head_ids, chain_ids = set(), set()
    for e in (msp if not block_mode else []):
        if e.dxftype() not in ("ELLIPSE", "ARC"):
            continue
        sz = geom_size(e)
        if not 6 <= sz <= 50 or geom_sweep(e) < 150:
            continue
        cx, cy = e.dxf.center.x, e.dxf.center.y
        if num_text_inside(cx, cy, sz):
            continue                      # 有數字 → 已走配對路徑
        if d_axis(cx, cy) <= AXIS_GATE:
            continue                      # 閘門①：坐在組立軸線上 = 零件
        leads = [L for L in lines
                 if min(math.hypot(L.dxf.start.x - cx, L.dxf.start.y - cy),
                        math.hypot(L.dxf.end.x - cx, L.dxf.end.y - cy)) <= sz * 1.5
                 and max(math.hypot(L.dxf.start.x - cx, L.dxf.start.y - cy),
                         math.hypot(L.dxf.end.x - cx, L.dxf.end.y - cy)) > sz * 2]
        if not leads:
            continue
        if has_balloon_leader(leads):
            continue                      # 閘門③：編號氣球指向它 = 零件
        drop = family_of(cx, cy)
        if crowd(cx, cy, sz * 1.5, drop) > CROWD_GATE:
            continue                      # 閘門②：不浮空 = 零件
        head_ids.add(id(e))
        # 沿引線鏈延伸到碰到零件為止（S1 的折線引線共 2 段）
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
                    continue              # 這一端是頭
                if nonline_touch(p.x, p.y, chain_ids | head_ids):
                    continue              # 碰到零件 → 停
                for M in lines:
                    if id(M) in chain_ids:
                        continue
                    if min(math.hypot(M.dxf.start.x - p.x, M.dxf.start.y - p.y),
                           math.hypot(M.dxf.end.x - p.x, M.dxf.end.y - p.y)) <= 2.5:
                        pending.append(M)

    keep = []
    dropped_lids = set()          # 被當引線/假想線丟掉的 LINE id（診斷用）
    tips = []                     # block 模式：引線遠端點 (x, y, 氣球索引)
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
        hit = edge_leader(e) if block_mode else is_leader(e)
        if hit:
            if block_mode:
                tips.append(hit)
            n_drop_l += 1
            dropped_lids.add(id(e))
            continue
        if dash_re.search(linetype_of(e) or ""):
            n_dash += 1
            dropped_lids.add(id(e))
            continue
        keep.append(e)

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
    # 診斷轉儲：給「泡泡線逐張檢查」用（唯讀，不影響輸出）
    globals()["LAST_DEBUG"] = {
        "keep": keep, "dropped_lids": dropped_lids,
        "bubble_ids": bubble_ids, "head_ids": head_ids,
        "chain_ids": chain_ids, "extra_circles": extra_circles,
        "extra_leaders": extra_leaders, "balloons": balloons,
    }
    return groups, labels, {"dropped_circles": n_drop_c,
                            "dropped_leaders": n_drop_l,
                            "dropped_bubbles": n_bub,
                            "dropped_heads": len(head_ids),
                            "dropped_dashed": n_dash,
                            "unassigned_dropped": n_unassigned}


def connected_components(segs):
    """並查集分量：端點落同 1.0 網格即相連（歸組與人工 override 共用）。"""
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
    """block 模式歸組：連通分量＋錨定區域生長（2026-10-21 重寫）。

    舊規則「每顆 tip 只認領最近一個分量，其餘分量按最近 tip、半徑＝對角線
    10% 兜底」實測 86% 的分量走兜底、半徑 716 單位（零件間距 100–300），
    造成兩種症狀：鄰件碎塊被吸進來（兩件一起變紅）、本件分量被吸走或丟棄
    （只紅一半／少線）。新規則：
      1. keep 段按共端點（≤1.0）連成連通分量
      2. tip 認領錨分量（≤80，同舊制）；無引線氣球用圓心當偽 tip
      3. 從錨往外區域生長：與「本件已收幾何」距離 ≤ 對角線 1.5% 的分量
         吸附進來，先近後遠，一個分量只歸一件
      4. 仍無主的分量：最近 tip ≤ 對角線 3%，且 d1 < 0.6·d2（明顯較近）
         才收；否則畫成無標籤的「未歸組」群（不再整段丟線）
      5. 外圖框（≤8 段、覆蓋 ≥90% 全幅）直接刪除；視圖框保留
    """
    if not segs:
        return {}, {}, 0
    xs = [s[0] for s in segs] + [s[2] for s in segs]
    ys = [s[1] for s in segs] + [s[3] for s in segs]

    # 1) 連通分量（並查集邏輯抽成 connected_components，override 共用）
    comp_list = connected_components(segs)

    def pts_of_comp(c):
        return [(s[0], s[1]) for s in c] + [(s[2], s[3]) for s in c]

    def bbox_of(pts):
        xs_ = [p[0] for p in pts]
        ys_ = [p[1] for p in pts]
        return (min(xs_), min(ys_), max(xs_), max(ys_))

    # 1b) 刪「整張圖的外框」：少段數的大框，且框內含 ≥80% 的線段。
    #     只包住局部零件組的視圖框（框內只佔少數）保留。
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

    # 2) 無引線氣球：圓心當偽 tip
    tips = list(tips)
    have = {bi for _, _, bi in tips}
    for bi, b in enumerate(balloons):
        if bi not in have:
            tips.append((b["cx"], b["cy"], bi))

    # 3) tip 認領錨分量（≤80，取最近）
    owners = [set() for _ in comp_list]
    for tx, ty, bi in tips:
        best, bd = None, 1e18
        for ci, pts in enumerate(cpts):
            d = min(math.hypot(px - tx, py - ty) for px, py in pts)
            if d < bd:
                bd, best = d, ci
        if best is not None and bd <= 80:
            owners[best].add(bi)

    # 4) 錨定區域生長
    G = dia * 0.015                      # 生長間隙
    parts = {}                           # key -> {"pts": [...], "segs": [...]}
    ggrid = {}                           # (cell) -> [(key, x, y)]

    def add_pts(key, pts):
        for x, y in pts:
            ggrid.setdefault((int(x // G), int(y // G)), []).append((key, x, y))
        parts[key]["pts"].extend(pts)

    cdiag = [math.hypot(b[2] - b[0], b[3] - b[1]) for b in cbb]
    # bis / key 集合必須排序迭代：set 序隨 PYTHONHASHSEED 變，會翻動
    # add_pts 的網格插入序 → 區域生長距離平手的 tie-break 不確定（同一支
    # DWG 兩次轉檔群組不同的元兇，2026-10-22 修）。
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

    # 5) 剩下：明顯較近的 tip 才收，否則進「未歸組」
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
    # X000 不給 label → 檢視頁不會把它變成可 hover 的零件（避免一堆不相干
    # 碎段一起變紅）；線仍然畫出來，不丟資料。

    multi = sum(1 for o in owners if len({balloons[bi]["n"] for bi in o}) > 1)
    print("歸組: 分量 %d / 刪圖框 %d / 多編號共管 %d / 群組 %d / 未歸組分量 %d"
          % (len(comp_list), n_frame, multi, len(groups), len(loose)))
    return groups, labels, len(loose)


def choose_rotation(groups):
    """挑一個讓「主軸水平 + 橫式」的旋轉角（0/90/180/270）。

    主軸＝以線段中點、長度加權的 PCA 主方向；分數 = 主軸離水平的角度
    （0–90°）+ 直式罰分 45°。同分取小角度，確保原本就正的水平圖不動。
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
    """點到線段的最短距離（投影鉗位在段內）。"""
    x1, y1, x2, y2 = s
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / l2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def apply_overrides(xf, labels, ops, key=""):
    """人工指定歸組修正（2026-10-22）：放大檢視.html「修正模式」記錄的 ops。

    每條 op = {"near": [x, y], "from": "P01", "to": "P02"|"X000"}——把離 near
    最近的連通分量整塊從 from 搬到 to；X000 = 無主（照畫、無標籤、檢視頁
    不可 hover）。near 座標系＝flip_rot 後的輸出 SVG，與預覽頁點擊座標一致，
    旋轉差異自動吸收。分量搬移不增刪線段 → viewBox 不變，可當校驗值。
    幾何無解的案例（P01 螺栓 vs 配重塊，兩條引線端點同落一疊線）由此兜底。
    回傳實際套用筆數。
    """
    applied = 0
    all_segs = [s for v in xf.values() for s in v]
    xs = [s[0] for s in all_segs] + [s[2] for s in all_segs]
    ys = [s[1] for s in all_segs] + [s[3] for s in all_segs]
    cap = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) * 0.02
    # 校驗：錄製時的 viewBox vs 本次重轉（同 DWG 同旋轉 → 應逐字相同；
    # 不同代表旋轉/幾何變了，near 可能失準——警告但不擋，由人判斷）
    want_vb = next((o.get("viewBox") for o in ops if o.get("viewBox")), None)
    if want_vb:
        w_, h_ = ((max(xs) - min(xs)) or 1.0), ((max(ys) - min(ys)) or 1.0)
        pad_ = max(w_, h_) * 0.02
        got_vb = "%.2f %.2f %.2f %.2f" % (min(xs) - pad_, min(ys) - pad_,
                                          w_ + 2 * pad_, h_ + 2 * pad_)
        if got_vb != want_vb:
            print("override ⚠️ viewBox 不一致：錄製=%s 現在=%s（near 可能失準）"
                  % (want_vb, got_vb))
    for op in ops:
        near, frm, to = op.get("near"), op.get("from"), op.get("to")
        if not (near and frm and to) or frm == to:
            print("override %s: 欄位不全或 from=to，跳過 %r" % (key, op))
            continue
        if frm not in xf:
            print("override %s: from=%s 不存在，跳過" % (key, frm))
            continue
        comps = connected_components([s for v in xf.values() for s in v])
        best, bd = None, 1e18
        for c in comps:
            d = min(seg_point_dist(near[0], near[1], s) for s in c)
            if d < bd:
                bd, best = d, c
        if best is None or bd > cap:
            print("override %s: 點擊離任何線太遠（%.0f > %.0f），跳過 %r"
                  % (key, bd, cap, op))
            continue
        cset = set(best)
        moved = [s for s in xf[frm] if s in cset]
        if not moved:
            owners = sorted(L for L, v in xf.items() if any(s in cset for s in v))
            print("override %s: from=%s 不含該分量（在 %s），跳過 %r"
                  % (key, frm, owners, op))
            continue
        xf[frm] = [s for s in xf[frm] if s not in cset]
        # to=無主且分量另有歸宿 → 只丟 from 的複本即可，線不會消失；
        # 否則搬進 to（同段去重，共管分量搬兩次不會畫雙線）
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


def build(svg_path, groups, labels, bom_ids=(), rotate="auto", override_ops=None):
    all_segs = [s for v in groups.values() for s in v]
    if not all_segs:
        raise SystemExit("沒有可畫的線段")
    xs = [s[0] for s in all_segs] + [s[2] for s in all_segs]
    ys = [s[1] for s in all_segs] + [s[3] for s in all_segs]
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    w0, h0 = (maxx - minx) or 1.0, (maxy - miny) or 1.0

    # 自動轉正：直式（高>寬）轉成橫式，與 p_type 參考稿方向一致。
    # 橫式圖不動 → p_type 回歸輸出逐位元組不變。可 --rotate 0/90/180/270 覆寫。
    deg = (90 if h0 > w0 else 0) if rotate == "auto" else int(rotate)
    xf = {L: flip_rot(v, deg) for L, v in groups.items()}

    # 人工指定修正：在 flip_rot 之後套用——override 的 near 與輸出 SVG 同座標
    # 系；搬移不增刪線段，viewBox 與未套用時相同，錄製值可校驗重轉一致性。
    if override_ops:
        apply_overrides(xf, labels, override_ops)

    tsegs = [s for v in xf.values() for s in v]
    txs = [s[0] for s in tsegs] + [s[2] for s in tsegs]
    tys = [s[1] for s in tsegs] + [s[3] for s in tsegs]
    tminx, tminy = min(txs), min(tys)
    w, h = (max(txs) - tminx) or 1.0, (max(tys) - tminy) or 1.0
    pad = max(w, h) * 0.02
    sw = math.hypot(w, h) * 0.002

    def sort_key(L):
        m = LAYER_RE.match(L) or re.match(r"P(\d+)", L)
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
    print("產出:", svg_path)
    print("旋轉: %s%s（原 %.0f×%.0f → %.0f×%.0f）"
          % (deg, "°順時針" if deg else "（不轉）", w0, h0, w, h))
    print("零件群組 %d / 線段 %d" % (len(groups), len(all_segs)))
    if bom_ids:
        print("bom 交叉: 有圖無bom =", sorted(ids - bom_ids) or "無",
              "| 有bom無圖 =", sorted(bom_ids - ids) or "無")
    else:
        print("bom 交叉: 未提供 bom.csv（跳過）")


def main():
    args = sys.argv[1:]
    rotate = "auto"
    ov_path = key = None
    if "--rotate" in args:
        i = args.index("--rotate")
        if i + 1 >= len(args):
            raise SystemExit("--rotate 需要 0/90/180/270")
        rotate = args[i + 1]
        del args[i:i + 2]
    if "--overrides" in args:
        i = args.index("--overrides")
        if i + 1 >= len(args):
            raise SystemExit("--overrides 需要 JSON 路徑")
        ov_path = args[i + 1]
        del args[i:i + 2]
    if "--key" in args:
        i = args.index("--key")
        if i + 1 >= len(args):
            raise SystemExit("--key 需要 相對路徑（如 鏈條/190/超短小車）")
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
            print("override: %s 無記錄（表內 %d 檔），照常輸出" % (key, len(data)))
        elif override_ops:
            print("override: 套用 %d 筆" % len(override_ops))
    doc = ezdxf.readfile(convert_dwg(dwg, "/tmp/dwgextract"))
    msp = doc.modelspace()
    has_player = any(LAYER_RE.match(e.dxf.layer) for e in msp
                     if e.dxf.hasattr("layer"))
    if has_player:
        print("模式: layer（P 圖層白名單）")
        groups, labels, stats = layer_mode(doc, msp)
    else:
        print("模式: balloon（CIRCLE+TEXT 氣球歸組）")
        groups, labels, stats = balloon_mode(doc, msp)
        if rotate == "auto":
            rotate = choose_rotation(groups)   # 主軸水平＋橫式
    # 標籤正規化：Pnn-part → Pnn-品名（bom Name）；其他格式修亂碼
    names = read_bom_names(bom)
    for k in list(labels):
        labels[k] = fix_mojibake(labels[k])
        if k in names:
            labels[k] = "%s-%s" % (k, names[k])
    print("統計:", stats)
    build(out, groups, labels, read_bom_ids(bom), rotate=rotate,
          override_ops=override_ops)


if __name__ == "__main__":
    main()

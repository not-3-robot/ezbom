#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DWG → EzBOM drawing.svg（2026-10-09 定版流程，見 Obsidian DWG轉EzBOM流程.md）

用法:
    python3 dwg2drawing.py <in.dwg> <out.svg> [bom.csv]

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
import math
import os
import re
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
EXTRACT_DIR = "/Users/zone/Documents/Study/B0M研究/BOM樹狀圖/_build"
sys.path.insert(0, EXTRACT_DIR)

from dwg_extract import convert_dwg, collect_segments, assign_segments, ASSIGN_THRESHOLD
from dwg_merge import segs_to_svg_path
import ezdxf

LAYER_RE = re.compile(r"^P(\d+)-")
NUM_RE = re.compile(r"^\d+$")


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def flip(segs):
    """CAD y-up → SVG y-down。"""
    return [(x1, -y1, x2, -y2) for x1, y1, x2, y2 in segs]


def read_bom_ids(path):
    ids = set()
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                ids.add((row.get("Id") or row.get("標籤ID") or "").strip())
    return ids


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
    def radial_leaders(cx, cy, rr):
        out = []
        for L in lines:
            d1 = math.hypot(L.dxf.start.x - cx, L.dxf.start.y - cy)
            d2 = math.hypot(L.dxf.end.x - cx, L.dxf.end.y - cy)
            if min(d1, d2) <= rr * 1.35 and max(d1, d2) >= rr * 2.5:
                out.append(L)
        return out

    bubble_ids, leader_ids = set(), set()
    for e in msp.query("ELLIPSE"):
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
    _bc = [crowd(b["x"], b["y"], b["r"] * 1.5, family_of(b["x"], b["y"]))
           for b in balloons]
    CROWD_GATE = max(_bc) if _bc else 1

    head_ids, chain_ids = set(), set()
    for e in msp:
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
            continue
        if is_leader(e):
            n_drop_l += 1
            continue
        if dash_re.search(linetype_of(e) or ""):
            n_dash += 1
            continue
        keep.append(e)

    segs = collect_segments(doc, entities=keep)
    groups_raw, unassigned = assign_segments(segs, balloons, ASSIGN_THRESHOLD)
    groups, labels = {}, {}
    for n, ss in groups_raw.items():
        if ss:
            key = "P%02d" % int(n)
            groups[key] = ss
            labels[key] = "%s-part" % key
    return groups, labels, {"dropped_circles": n_drop_c,
                            "dropped_leaders": n_drop_l,
                            "dropped_bubbles": n_bub,
                            "dropped_heads": len(head_ids),
                            "dropped_dashed": n_dash,
                            "unassigned_dropped": len(unassigned)}


def build(svg_path, groups, labels, bom_ids=()):
    all_segs = [s for v in groups.values() for s in v]
    if not all_segs:
        raise SystemExit("沒有可畫的線段")
    xs = [s[0] for s in all_segs] + [s[2] for s in all_segs]
    ys = [s[1] for s in all_segs] + [s[3] for s in all_segs]
    minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)
    w, h = (maxx - minx) or 1.0, (maxy - miny) or 1.0
    pad = max(w, h) * 0.02
    sw = math.hypot(w, h) * 0.002

    def sort_key(L):
        m = LAYER_RE.match(L) or re.match(r"P(\d+)", L)
        return int(m.group(1)) if m else 9999

    parts = []
    for L in sorted(groups, key=sort_key):
        d = segs_to_svg_path(flip(groups[L]))
        if d:
            parts.append('<g inkscape:label="%s"><path d="%s" fill="none" '
                         'stroke="#141413" stroke-width="%.3f"/></g>'
                         % (esc(labels[L]), d, sw))
    svg = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
           '<svg xmlns="http://www.w3.org/2000/svg" version="1.1"\n'
           '     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n'
           '     viewBox="%.2f %.2f %.2f %.2f">\n%s\n</svg>\n'
           % (minx - pad, -(maxy + pad), w + 2 * pad, h + 2 * pad,
              "\n".join(parts)))
    with open(svg_path, "w", encoding="utf-8") as fh:
        fh.write(svg)

    ids = {re.match(r"(P\d+)", labels[L]).group(1) for L in labels}
    print("產出:", svg_path)
    print("零件群組 %d / 線段 %d" % (len(groups), len(all_segs)))
    if bom_ids:
        print("bom 交叉: 有圖無bom =", sorted(ids - bom_ids) or "無",
              "| 有bom無圖 =", sorted(bom_ids - ids) or "無")
    else:
        print("bom 交叉: 未提供 bom.csv（跳過）")


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    dwg, out = sys.argv[1], sys.argv[2]
    bom = sys.argv[3] if len(sys.argv) > 3 else None
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
    print("統計:", stats)
    build(out, groups, labels, read_bom_ids(bom))


if __name__ == "__main__":
    main()

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

    # 註記泡泡（無文字版）：完整等軸測圈 a∈[10,50] 若帶徑向引線
    # （一端貼圈 ≤1.35a、另端 ≥2.5a）＝沒有號碼的註記圈。
    # K型 實測：雙同心圈 a=27.8+35.0 + layer0 引線 78.6，即使用者指的泡泡球。
    # 同心同尺度的完整圈一併刪（雙環結構），零件上的軸承/孔紋（a>50 或
    # 不帶徑向引線的 partial 弧）不受影響。
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
        leads = radial_leaders(cx, cy, a)
        if not leads:
            continue
        # 同心同尺度完整圈一併成組刪除
        for f in msp.query("ELLIPSE"):
            b = f.dxf.major_axis.magnitude
            if (10 <= b <= 50 and 0.45 <= f.dxf.ratio <= 0.75
                    and abs((f.dxf.end_param - f.dxf.start_param) - 2 * math.pi) <= 0.05
                    and math.hypot(f.dxf.center.x - cx, f.dxf.center.y - cy) < 5
                    and abs(b - a) < 25):
                bubble_ids.add(id(f))
        leader_ids.update(id(L) for L in leads)

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

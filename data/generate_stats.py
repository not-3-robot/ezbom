#!/usr/bin/env python3
"""
EzBOM 采购统计生成器

从 data/purchases/*.csv 读取采购记录，计算统计数据并输出到 data/stats.json。

用法：
    python3 data/generate_stats.py

产出：
    data/stats.json — 供 viewer.html 前端读取显示
"""

import csv
import json
import os
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent.resolve()
PURCHASES_DIR = DATA_DIR / "purchases"
OUTPUT = DATA_DIR / "stats.json"


def safe_int(val, default=0):
    """安全转换为整数，无效值回传 default"""
    try:
        return int(val)
    except (ValueError, TypeError):
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return default


def safe_float(val, default=0.0):
    """安全转换为浮点数，无效值回传 default"""
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def load_purchases():
    """读取所有产品的采购记录 CSV"""
    purchases_by_product = defaultdict(list)

    if not PURCHASES_DIR.exists():
        print(f"⚠ 找不到目录: {PURCHASES_DIR}")
        return purchases_by_product

    for fpath in sorted(PURCHASES_DIR.glob("*.csv")):
        product_id = fpath.stem  # 档名（不含副档名）作为 product id
        with open(fpath, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                row["_product"] = product_id
                purchases_by_product[product_id].append(row)

    return purchases_by_product


def compute_stats(records):
    """从采购记录计算统计数据"""
    if not records:
        return {
            "topParts": [],
            "topCustomers": [],
            "monthlyStats": [],
            "hotParts": [],
            "partPurchaseHistory": {},
        }

    # ---- 零件统计 ----
    part_qty = defaultdict(int)
    part_count = defaultdict(int)
    part_name = {}

    for r in records:
        pn = r.get("PartNumber", "").strip()
        qty = safe_int(r.get("Quantity", 0))
        part_qty[pn] += qty
        part_count[pn] += 1
        if pn and not part_name.get(pn):
            part_name[pn] = r.get("PartName", "").strip()

    top_parts = sorted(
        [{"partNumber": k, "name": part_name.get(k, ""), "totalQty": v, "orderCount": part_count[k]}
         for k, v in part_qty.items()],
        key=lambda x: (-x["totalQty"], -x["orderCount"])
    )

    # ---- 客户统计 ----
    customer_data = defaultdict(lambda: {"orderCount": 0, "totalQty": 0, "totalAmount": 0.0, "orders": set()})

    for r in records:
        c = r.get("Customer", "未知客户").strip()
        customer_data[c]["orderCount"] += 1
        customer_data[c]["totalQty"] += safe_int(r.get("Quantity", 0))
        customer_data[c]["totalAmount"] += safe_float(r.get("UnitPrice", 0)) * safe_int(r.get("Quantity", 0))
        customer_data[c]["orders"].add(r.get("OrderNo", "").strip())

    top_customers = sorted(
        [{"name": k, "orderCount": len(v["orders"]), "totalQty": v["totalQty"], "totalAmount": round(v["totalAmount"], 2)}
         for k, v in customer_data.items()],
        key=lambda x: (-x["orderCount"], -x["totalQty"])
    )

    # ---- 每月统计 ----
    monthly = defaultdict(lambda: {"orderCount": 0, "totalQty": 0, "totalAmount": 0.0, "orders": set()})

    for r in records:
        date = r.get("Date", "").strip()
        month = date[:7] if len(date) >= 7 else date
        monthly[month]["orderCount"] += 1
        monthly[month]["totalQty"] += safe_int(r.get("Quantity", 0))
        monthly[month]["totalAmount"] += safe_float(r.get("UnitPrice", 0)) * safe_int(r.get("Quantity", 0))
        monthly[month]["orders"].add(r.get("OrderNo", "").strip())

    monthly_stats = sorted(
        [{"month": k, "orderCount": len(v["orders"]), "totalQty": v["totalQty"], "totalAmount": round(v["totalAmount"], 2)}
         for k, v in monthly.items()],
        key=lambda x: x["month"]
    )

    # ---- 各零件采购历史（用于高频零件推荐） ----
    part_history = {}
    for r in records:
        pn = r.get("PartNumber", "").strip()
        if not pn:
            continue
        if pn not in part_history:
            part_history[pn] = {
                "partNumber": pn,
                "name": r.get("PartName", "").strip(),
                "totalQty": 0,
                "orderCount": 0,
                "customers": set(),
                "lastPurchase": "",
                "frequency": 0,
            }
        h = part_history[pn]
        h["totalQty"] += safe_int(r.get("Quantity", 0))
        h["orderCount"] += 1
        h["customers"].add(r.get("Customer", "").strip())
        date = r.get("Date", "").strip()
        if date > h["lastPurchase"]:
            h["lastPurchase"] = date

    # 计算频率分数：订单次数 * 客户数 + 总数量权重
    for pn, h in part_history.items():
        h["customers"] = list(h["customers"])
        h["frequency"] = round(h["orderCount"] * len(h["customers"]) + h["totalQty"] * 0.1, 1)

    # 按频率排序
    part_history_sorted = sorted(part_history.values(), key=lambda x: -x["frequency"])

    return {
        "topParts": top_parts[:10],          # 前10名热门零件
        "topCustomers": top_customers,        # 客户排名
        "monthlyStats": monthly_stats,        # 月度趋势
        "hotParts": part_history_sorted[:10], # 高频推荐零件
    }


def main():
    print("📊 EzBOM 采购统计生成器")
    print("=" * 40)

    purchases = load_purchases()
    if not purchases:
        print("⚠ 没有找到任何采购记录")
        print(f"   请将 CSV 放在 {PURCHASES_DIR}/ 目录下")
        return

    result = {}
    for product_id, records in purchases.items():
        print(f"\n📦 {product_id}: {len(records)} 笔记录")
        stats = compute_stats(records)
        result[product_id] = stats
        print(f"   TOP 3 零件: {', '.join(p['partNumber'] for p in stats['topParts'][:3])}")
        print(f"   客户数: {len(stats['topCustomers'])}")
        print(f"   月份数: {len(stats['monthlyStats'])}")

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\n✅ 统计已写入 {OUTPUT}")


if __name__ == "__main__":
    main()

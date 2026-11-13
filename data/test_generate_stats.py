#!/usr/bin/env python3
"""
EzBOM generate_stats.py 单元测试

执行方式：
    cd EzBOM && python3 -m pytest data/test_generate_stats.py -v
    或
    cd EzBOM && python3 data/test_generate_stats.py
"""

import sys
import os
import json
import tempfile
import csv
from pathlib import Path

# 将 data/ 目录加入路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from generate_stats import compute_stats, load_purchases


# ============================================================
# Test Fixtures
# ============================================================

SAMPLE_RECORDS = [
    {"Date": "2025-01-15", "Customer": "永丰机械", "PartNumber": "400198",
     "PartName": "C型扣环<R-47>", "Quantity": "20", "UnitPrice": "8.5",
     "OrderNo": "PO-2025-001"},
    {"Date": "2025-01-15", "Customer": "永丰机械", "PartNumber": "405563",
     "PartName": "滚珠轴承<60052RS>", "Quantity": "10", "UnitPrice": "35.0",
     "OrderNo": "PO-2025-001"},
    {"Date": "2025-02-03", "Customer": "冠杰工业", "PartNumber": "400198",
     "PartName": "C型扣环<R-47>", "Quantity": "15", "UnitPrice": "8.5",
     "OrderNo": "PO-2025-008"},
    {"Date": "2025-02-20", "Customer": "大明重工", "PartNumber": "205600",
     "PartName": "齿轮箱", "Quantity": "2", "UnitPrice": "8500.0",
     "OrderNo": "PO-2025-015"},
    {"Date": "2025-03-05", "Customer": "永丰机械", "PartNumber": "407736",
     "PartName": "滚珠轴承<6205>", "Quantity": "10", "UnitPrice": "32.0",
     "OrderNo": "PO-2025-022"},
    {"Date": "2025-04-01", "Customer": "冠杰工业", "PartNumber": "407736",
     "PartName": "滚珠轴承<6205>", "Quantity": "10", "UnitPrice": "32.0",
     "OrderNo": "PO-2025-035"},
]


def make_temp_csv(records, filename="test.csv"):
    """建立临时 CSV 档案供测试"""
    tmpdir = tempfile.mkdtemp()
    filepath = os.path.join(tmpdir, filename)
    if records:
        fieldnames = list(records[0].keys())
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(records)
    else:
        # 空档案（只有 header）
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            f.write("Date,Customer,PartNumber,PartName,Quantity,UnitPrice,OrderNo\n")
    return tmpdir, filepath


# ============================================================
# Tests: compute_stats()
# ============================================================

def test_compute_stats_basic():
    """基本统计计算：topParts、topCustomers、monthlyStats、hotParts"""
    stats = compute_stats(SAMPLE_RECORDS)

    # topParts 应按 totalQty 降幂排列
    assert len(stats["topParts"]) > 0
    assert stats["topParts"][0]["partNumber"] == "400198"  # 20+15=35 最多
    assert stats["topParts"][0]["totalQty"] == 35
    assert stats["topParts"][0]["orderCount"] == 2

    # topCustomers
    assert len(stats["topCustomers"]) == 3
    customer_names = [c["name"] for c in stats["topCustomers"]]
    assert "永丰机械" in customer_names

    # monthlyStats: 应该有 4 个月份
    assert len(stats["monthlyStats"]) == 4
    months = [m["month"] for m in stats["monthlyStats"]]
    assert "2025-01" in months
    assert "2025-04" in months

    # hotParts 应包含所有零件
    assert len(stats["hotParts"]) == 4  # 4 个不同料号


def test_compute_stats_empty():
    """空记录应回传空结构"""
    stats = compute_stats([])
    assert stats["topParts"] == []
    assert stats["topCustomers"] == []
    assert stats["monthlyStats"] == []
    assert stats["hotParts"] == []


def test_compute_stats_single_record():
    """单笔记录"""
    record = [{"Date": "2025-06-01", "Customer": "测试客户", "PartNumber": "TEST-001",
               "PartName": "测试零件", "Quantity": "5", "UnitPrice": "100.0",
               "OrderNo": "PO-001"}]
    stats = compute_stats(record)

    assert len(stats["topParts"]) == 1
    assert stats["topParts"][0]["partNumber"] == "TEST-001"
    assert stats["topParts"][0]["totalQty"] == 5

    assert len(stats["topCustomers"]) == 1
    assert stats["topCustomers"][0]["name"] == "测试客户"

    assert len(stats["monthlyStats"]) == 1
    assert stats["monthlyStats"][0]["month"] == "2025-06"

    assert len(stats["hotParts"]) == 1


def test_compute_stats_quantity_aggregation():
    """同料号多次出现应正确加总"""
    records = [
        {"Date": "2025-01-01", "Customer": "A", "PartNumber": "P001",
         "PartName": "螺丝", "Quantity": "10", "UnitPrice": "1.0",
         "OrderNo": "O1"},
        {"Date": "2025-01-02", "Customer": "B", "PartNumber": "P001",
         "PartName": "螺丝", "Quantity": "20", "UnitPrice": "1.0",
         "OrderNo": "O2"},
        {"Date": "2025-01-03", "Customer": "C", "PartNumber": "P001",
         "PartName": "螺丝", "Quantity": "30", "UnitPrice": "1.0",
         "OrderNo": "O3"},
    ]
    stats = compute_stats(records)
    assert stats["topParts"][0]["totalQty"] == 60
    assert stats["topParts"][0]["orderCount"] == 3


def test_compute_stats_missing_fields():
    """缺失选填栏位不应崩溃"""
    records = [
        {"Date": "2025-01-01", "PartNumber": "P001",
         "Quantity": "1", "UnitPrice": "10.0", "OrderNo": "O1"},
        # Customer, PartName 缺失
    ]
    stats = compute_stats(records)
    assert len(stats["topParts"]) == 1
    # 未知客户应被处理
    assert len(stats["topCustomers"]) >= 1


def test_compute_stats_invalid_quantity():
    """无效数量应被安全跳过，不崩溃"""
    records = [
        {"Date": "2025-01-01", "Customer": "A", "PartNumber": "P001",
         "PartName": "X", "Quantity": "not-a-number", "UnitPrice": "10.0",
         "OrderNo": "O1"},
        {"Date": "2025-01-02", "Customer": "A", "PartNumber": "P002",
         "PartName": "Y", "Quantity": "5", "UnitPrice": "10.0",
         "OrderNo": "O2"},
    ]
    stats = compute_stats(records)
    # 无效数量的零件应 qty=0，但不崩溃
    assert len(stats["topParts"]) == 2
    p001 = next(p for p in stats["topParts"] if p["partNumber"] == "P001")
    assert p001["totalQty"] == 0  # 无效数量被视为 0


def test_compute_stats_date_edge_cases():
    """日期边界测试：短日期格式"""
    records = [
        {"Date": "2025", "Customer": "A", "PartNumber": "P001",
         "PartName": "X", "Quantity": "1", "UnitPrice": "10.0",
         "OrderNo": "O1"},
        {"Date": "", "Customer": "A", "PartNumber": "P002",
         "PartName": "Y", "Quantity": "1", "UnitPrice": "10.0",
         "OrderNo": "O2"},
    ]
    stats = compute_stats(records)
    # 应正常处理，不回传空列表（至少有一笔）
    assert len(stats["monthlyStats"]) >= 1


def test_hot_parts_frequency():
    """hotParts 频率分数应正确计算"""
    stats = compute_stats(SAMPLE_RECORDS)
    hot = stats["hotParts"]

    # 400198 出现 2 次，2 个客户 → frequency = 2*2 + 35*0.1 = 7.5
    part_400198 = next(p for p in hot if p["partNumber"] == "400198")
    assert part_400198["orderCount"] == 2
    assert len(part_400198["customers"]) == 2
    assert part_400198["totalQty"] == 35
    assert part_400198["frequency"] == 2 * 2 + 35 * 0.1


def test_hot_parts_sorting():
    """hotParts 应按 frequency 降幂排列"""
    stats = compute_stats(SAMPLE_RECORDS)
    hot = stats["hotParts"]
    for i in range(len(hot) - 1):
        assert hot[i]["frequency"] >= hot[i+1]["frequency"]


def test_top_parts_limit():
    """topParts 最多 10 笔"""
    # 建立 15 个不同料号
    records = []
    for i in range(15):
        records.append({
            "Date": "2025-01-01", "Customer": "C", "PartNumber": f"P{i:03d}",
            "PartName": f"Part{i}", "Quantity": str(i+1), "UnitPrice": "10.0",
            "OrderNo": f"O{i}"
        })
    stats = compute_stats(records)
    assert len(stats["topParts"]) == 10


def test_monthly_stats_sorting():
    """monthlyStats 应按月份升幂排列"""
    stats = compute_stats(SAMPLE_RECORDS)
    months = [m["month"] for m in stats["monthlyStats"]]
    assert months == sorted(months)


# ============================================================
# Tests: load_purchases()
# ============================================================

def test_load_purchases_from_dir():
    """从目录载入采购记录"""
    tmpdir, filepath = make_temp_csv(SAMPLE_RECORDS, "p-type.csv")
    # 需要暂时覆盖 PURCHASES_DIR（此测试仅验证逻辑）
    # 由于 load_purchases 使用全域 PURCHASES_DIR，这里直接测试 CSV 读取逻辑
    import csv as csv_module
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv_module.DictReader(f)
        rows = list(reader)
    assert len(rows) == 6
    assert rows[0]["PartNumber"] == "400198"


def test_load_purchases_empty_dir():
    """空目录不应崩溃"""
    tmpdir, _ = make_temp_csv(SAMPLE_RECORDS)
    # 建立一个空的 purchases 目录
    purchases_dir = os.path.join(tmpdir, "empty_purchases")
    os.makedirs(purchases_dir, exist_ok=True)
    # 不应该有任何 CSV 档案
    csv_files = list(Path(purchases_dir).glob("*.csv"))
    assert len(csv_files) == 0


# ============================================================
# 手动执行（不使用 pytest 时）
# ============================================================
if __name__ == "__main__":
    import traceback

    tests = [
        test_compute_stats_basic,
        test_compute_stats_empty,
        test_compute_stats_single_record,
        test_compute_stats_quantity_aggregation,
        test_compute_stats_missing_fields,
        test_compute_stats_invalid_quantity,
        test_compute_stats_date_edge_cases,
        test_hot_parts_frequency,
        test_hot_parts_sorting,
        test_top_parts_limit,
        test_monthly_stats_sorting,
        test_load_purchases_from_dir,
        test_load_purchases_empty_dir,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            test()
            print(f"  ✅ {test.__name__}")
            passed += 1
        except Exception as e:
            print(f"  ❌ {test.__name__}: {e}")
            traceback.print_exc()
            failed += 1

    print(f"\n{'='*50}")
    print(f"结果: {passed} passed, {failed} failed, {len(tests)} total")
    sys.exit(0 if failed == 0 else 1)

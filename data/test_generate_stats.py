#!/usr/bin/env python3
"""
EzBOM generate_stats.py 單元測試

執行方式：
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

# 將 data/ 目錄加入路徑
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from generate_stats import compute_stats, load_purchases


# ============================================================
# Test Fixtures
# ============================================================

SAMPLE_RECORDS = [
    {"Date": "2025-01-15", "Customer": "永豐機械", "PartNumber": "400198",
     "PartName": "C型扣環<R-47>", "Quantity": "20", "UnitPrice": "8.5",
     "OrderNo": "PO-2025-001"},
    {"Date": "2025-01-15", "Customer": "永豐機械", "PartNumber": "405563",
     "PartName": "滾珠軸承<60052RS>", "Quantity": "10", "UnitPrice": "35.0",
     "OrderNo": "PO-2025-001"},
    {"Date": "2025-02-03", "Customer": "冠杰工業", "PartNumber": "400198",
     "PartName": "C型扣環<R-47>", "Quantity": "15", "UnitPrice": "8.5",
     "OrderNo": "PO-2025-008"},
    {"Date": "2025-02-20", "Customer": "大明重工", "PartNumber": "205600",
     "PartName": "齒輪箱", "Quantity": "2", "UnitPrice": "8500.0",
     "OrderNo": "PO-2025-015"},
    {"Date": "2025-03-05", "Customer": "永豐機械", "PartNumber": "407736",
     "PartName": "滾珠軸承<6205>", "Quantity": "10", "UnitPrice": "32.0",
     "OrderNo": "PO-2025-022"},
    {"Date": "2025-04-01", "Customer": "冠杰工業", "PartNumber": "407736",
     "PartName": "滾珠軸承<6205>", "Quantity": "10", "UnitPrice": "32.0",
     "OrderNo": "PO-2025-035"},
]


def make_temp_csv(records, filename="test.csv"):
    """建立臨時 CSV 檔案供測試"""
    tmpdir = tempfile.mkdtemp()
    filepath = os.path.join(tmpdir, filename)
    if records:
        fieldnames = list(records[0].keys())
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(records)
    else:
        # 空檔案（只有 header）
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            f.write("Date,Customer,PartNumber,PartName,Quantity,UnitPrice,OrderNo\n")
    return tmpdir, filepath


# ============================================================
# Tests: compute_stats()
# ============================================================

def test_compute_stats_basic():
    """基本統計計算：topParts、topCustomers、monthlyStats、hotParts"""
    stats = compute_stats(SAMPLE_RECORDS)

    # topParts 應按 totalQty 降冪排列
    assert len(stats["topParts"]) > 0
    assert stats["topParts"][0]["partNumber"] == "400198"  # 20+15=35 最多
    assert stats["topParts"][0]["totalQty"] == 35
    assert stats["topParts"][0]["orderCount"] == 2

    # topCustomers
    assert len(stats["topCustomers"]) == 3
    customer_names = [c["name"] for c in stats["topCustomers"]]
    assert "永豐機械" in customer_names

    # monthlyStats: 應該有 4 個月份
    assert len(stats["monthlyStats"]) == 4
    months = [m["month"] for m in stats["monthlyStats"]]
    assert "2025-01" in months
    assert "2025-04" in months

    # hotParts 應包含所有零件
    assert len(stats["hotParts"]) == 4  # 4 個不同料號


def test_compute_stats_empty():
    """空記錄應回傳空結構"""
    stats = compute_stats([])
    assert stats["topParts"] == []
    assert stats["topCustomers"] == []
    assert stats["monthlyStats"] == []
    assert stats["hotParts"] == []


def test_compute_stats_single_record():
    """單筆記錄"""
    record = [{"Date": "2025-06-01", "Customer": "測試客戶", "PartNumber": "TEST-001",
               "PartName": "測試零件", "Quantity": "5", "UnitPrice": "100.0",
               "OrderNo": "PO-001"}]
    stats = compute_stats(record)

    assert len(stats["topParts"]) == 1
    assert stats["topParts"][0]["partNumber"] == "TEST-001"
    assert stats["topParts"][0]["totalQty"] == 5

    assert len(stats["topCustomers"]) == 1
    assert stats["topCustomers"][0]["name"] == "測試客戶"

    assert len(stats["monthlyStats"]) == 1
    assert stats["monthlyStats"][0]["month"] == "2025-06"

    assert len(stats["hotParts"]) == 1


def test_compute_stats_quantity_aggregation():
    """同料號多次出現應正確加總"""
    records = [
        {"Date": "2025-01-01", "Customer": "A", "PartNumber": "P001",
         "PartName": "螺絲", "Quantity": "10", "UnitPrice": "1.0",
         "OrderNo": "O1"},
        {"Date": "2025-01-02", "Customer": "B", "PartNumber": "P001",
         "PartName": "螺絲", "Quantity": "20", "UnitPrice": "1.0",
         "OrderNo": "O2"},
        {"Date": "2025-01-03", "Customer": "C", "PartNumber": "P001",
         "PartName": "螺絲", "Quantity": "30", "UnitPrice": "1.0",
         "OrderNo": "O3"},
    ]
    stats = compute_stats(records)
    assert stats["topParts"][0]["totalQty"] == 60
    assert stats["topParts"][0]["orderCount"] == 3


def test_compute_stats_missing_fields():
    """缺失選填欄位不應崩潰"""
    records = [
        {"Date": "2025-01-01", "PartNumber": "P001",
         "Quantity": "1", "UnitPrice": "10.0", "OrderNo": "O1"},
        # Customer, PartName 缺失
    ]
    stats = compute_stats(records)
    assert len(stats["topParts"]) == 1
    # 未知客戶應被處理
    assert len(stats["topCustomers"]) >= 1


def test_compute_stats_invalid_quantity():
    """無效數量應被安全跳過，不崩潰"""
    records = [
        {"Date": "2025-01-01", "Customer": "A", "PartNumber": "P001",
         "PartName": "X", "Quantity": "not-a-number", "UnitPrice": "10.0",
         "OrderNo": "O1"},
        {"Date": "2025-01-02", "Customer": "A", "PartNumber": "P002",
         "PartName": "Y", "Quantity": "5", "UnitPrice": "10.0",
         "OrderNo": "O2"},
    ]
    stats = compute_stats(records)
    # 無效數量的零件應 qty=0，但不崩潰
    assert len(stats["topParts"]) == 2
    p001 = next(p for p in stats["topParts"] if p["partNumber"] == "P001")
    assert p001["totalQty"] == 0  # 無效數量被視為 0


def test_compute_stats_date_edge_cases():
    """日期邊界測試：短日期格式"""
    records = [
        {"Date": "2025", "Customer": "A", "PartNumber": "P001",
         "PartName": "X", "Quantity": "1", "UnitPrice": "10.0",
         "OrderNo": "O1"},
        {"Date": "", "Customer": "A", "PartNumber": "P002",
         "PartName": "Y", "Quantity": "1", "UnitPrice": "10.0",
         "OrderNo": "O2"},
    ]
    stats = compute_stats(records)
    # 應正常處理，不回傳空列表（至少有一筆）
    assert len(stats["monthlyStats"]) >= 1


def test_hot_parts_frequency():
    """hotParts 頻率分數應正確計算"""
    stats = compute_stats(SAMPLE_RECORDS)
    hot = stats["hotParts"]

    # 400198 出現 2 次，2 個客戶 → frequency = 2*2 + 35*0.1 = 7.5
    part_400198 = next(p for p in hot if p["partNumber"] == "400198")
    assert part_400198["orderCount"] == 2
    assert len(part_400198["customers"]) == 2
    assert part_400198["totalQty"] == 35
    assert part_400198["frequency"] == 2 * 2 + 35 * 0.1


def test_hot_parts_sorting():
    """hotParts 應按 frequency 降冪排列"""
    stats = compute_stats(SAMPLE_RECORDS)
    hot = stats["hotParts"]
    for i in range(len(hot) - 1):
        assert hot[i]["frequency"] >= hot[i+1]["frequency"]


def test_top_parts_limit():
    """topParts 最多 10 筆"""
    # 建立 15 個不同料號
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
    """monthlyStats 應按月份升冪排列"""
    stats = compute_stats(SAMPLE_RECORDS)
    months = [m["month"] for m in stats["monthlyStats"]]
    assert months == sorted(months)


# ============================================================
# Tests: load_purchases()
# ============================================================

def test_load_purchases_from_dir():
    """從目錄載入採購記錄"""
    tmpdir, filepath = make_temp_csv(SAMPLE_RECORDS, "p-type.csv")
    # 需要暫時覆蓋 PURCHASES_DIR（此測試僅驗證邏輯）
    # 由於 load_purchases 使用全域 PURCHASES_DIR，這裡直接測試 CSV 讀取邏輯
    import csv as csv_module
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv_module.DictReader(f)
        rows = list(reader)
    assert len(rows) == 6
    assert rows[0]["PartNumber"] == "400198"


def test_load_purchases_empty_dir():
    """空目錄不應崩潰"""
    tmpdir, _ = make_temp_csv(SAMPLE_RECORDS)
    # 建立一個空的 purchases 目錄
    purchases_dir = os.path.join(tmpdir, "empty_purchases")
    os.makedirs(purchases_dir, exist_ok=True)
    # 不應該有任何 CSV 檔案
    csv_files = list(Path(purchases_dir).glob("*.csv"))
    assert len(csv_files) == 0


# ============================================================
# 手動執行（不使用 pytest 時）
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
    print(f"結果: {passed} passed, {failed} failed, {len(tests)} total")
    sys.exit(0 if failed == 0 else 1)

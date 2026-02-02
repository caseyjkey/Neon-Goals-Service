#!/usr/bin/env python3
"""
Test script to verify car scrapers are working correctly.
Tests both text search queries and structured URLs.
"""
import json
import sys
import subprocess
import logging
from pathlib import Path

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)

SCRIPTS_DIR = Path(__file__).parent

# Test cases: (name, script, query, max_results)
TEST_CASES = [
    # AutoTrader tests
    ("AutoTrader (CDP) - GMC Sierra Denali", "scrape-autotrader.py",
     "GMC Sierra Denali Ultimate", 5),

    # CarMax test
    ("CarMax - GMC Sierra", "scrape-carmax.py",
     "https://www.carmax.com/cars/gmc/sierra", 3),

    # KBB test
    ("KBB - GMC Sierra", "scrape-kbb.py",
     "https://www.kbb.com/cars-for-sale/used/gmc/sierra", 3),

    # TrueCar test
    ("TrueCar - GMC Sierra", "scrape-truecar.py",
     "https://www.truecar.com/used-cars-for-sale/listings/inventory/?city=south-san-francisco&mmt[]=gmc_sierra&searchRadius=5000&state=ca", 3),
]


def test_scraper(name: str, script: str, query: str, max_results: int) -> dict:
    """Run a single scraper test."""
    script_path = SCRIPTS_DIR / script
    if not script_path.exists():
        return {
            "name": name,
            "status": "SKIP",
            "reason": f"Script not found: {script}"
        }

    try:
        result = subprocess.run(
            ["python3", str(script_path), query, str(max_results)],
            capture_output=True,
            text=True,
            timeout=120
        )

        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                if isinstance(data, list):
                    return {
                        "name": name,
                        "status": "PASS" if len(data) > 0 else "EMPTY",
                        "results": len(data),
                        "sample": data[0] if data else None
                    }
                elif "error" in data:
                    return {
                        "name": name,
                        "status": "ERROR",
                        "error": data.get("error", "Unknown error")
                    }
            except json.JSONDecodeError:
                return {
                    "name": name,
                    "status": "INVALID",
                    "output": result.stdout[:200]
                }
        else:
            return {
                "name": name,
                "status": "FAIL",
                "stderr": result.stderr[:500] if result.stderr else "No stderr"
            }
    except subprocess.TimeoutExpired:
        return {
            "name": name,
            "status": "TIMEOUT",
            "reason": "Script timed out after 120 seconds"
        }
    except Exception as e:
        return {
            "name": name,
            "status": "EXCEPTION",
            "error": str(e)
        }


def main():
    print("=" * 60)
    print("Car Scraper Test Suite")
    print("=" * 60)
    print()

    results = []
    for name, script, query, max_results in TEST_CASES:
        print(f"Testing: {name}...")
        result = test_scraper(name, script, query, max_results)
        results.append(result)

        status = result["status"]
        if status == "PASS":
            print(f"  ✓ PASS - Found {result['results']} results")
            if result.get("sample"):
                sample = result["sample"]
                print(f"    Sample: {sample.get('name', 'N/A')[:50]} - ${sample.get('price', 0):,}")
        elif status == "EMPTY":
            print(f"  ⚠ EMPTY - No results found (may be expected)")
        elif status == "SKIP":
            print(f"  ⊘ SKIP - {result['reason']}")
        else:
            print(f"  ✗ {status}")
            if "error" in result:
                print(f"    Error: {result['error'][:100]}")
            elif "stderr" in result:
                print(f"    Stderr: {result['stderr'][:200]}")
        print()

    # Summary
    print("=" * 60)
    print("Summary:")
    print("=" * 60)
    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] in ["FAIL", "ERROR", "EXCEPTION", "TIMEOUT"])
    empty = sum(1 for r in results if r["status"] == "EMPTY")
    skipped = sum(1 for r in results if r["status"] == "SKIP")

    print(f"  Passed: {passed}")
    print(f"  Empty:  {empty}")
    print(f"  Failed: {failed}")
    print(f"  Skipped: {skipped}")
    print(f"  Total:  {len(results)}")
    print()

    if failed > 0:
        print("⚠️  Some tests failed. Check the output above for details.")
        return 1
    elif passed == 0 and empty > 0:
        print("⚠️  All scrapers returned empty results. Check if sites are blocking requests.")
        return 1
    else:
        print("✓ Tests complete!")
        return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
CarMax scraper using Camoufox (VISIBLE MODE - headless doesn't work)
Uses exact selectors found via chrome-devtools analysis
"""
import asyncio
import json
import sys
import logging
import re
from pathlib import Path

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)

from camoufox.async_api import AsyncCamoufox
from dotenv import load_dotenv

env_path = Path(__file__).parent.parent / '.env'
load_dotenv(env_path)


def extract_number(text: str) -> int:
    if not text:
        return 0
    cleaned = re.sub(r'[^\d,.]', '', str(text))
    cleaned = cleaned.replace(',', '')
    try:
        return int(float(cleaned))
    except:
        return 0


def parse_data_clickprops(props_str: str) -> dict:
    """Parse CarMax data-clickprops attribute
    Format: 'Element type: Car Tile,StockNumber: 27818903,YMM: 2018 Honda Civic,Price: 14998,...'
    """
    data = {}
    pairs = props_str.split(',')
    for pair in pairs:
        if ':' in pair:
            key, value = pair.split(':', 1)
            data[key.strip()] = value.strip()
    return data


async def scrape_carmax(search_arg: str, max_results: int = 10):
    results = []

    # IMPORTANT: headless=False because camoufox crashes in headless mode
    browser = await AsyncCamoufox(headless=False, humanize=True).__aenter__()

    try:
        page = await browser.new_page()

        # Check if search_arg is a URL or a query
        if search_arg.startswith('http'):
            # Direct URL provided (structured URL from vehicle fields)
            search_url = search_arg
            logging.error(f"[CarMax] Using structured URL: {search_url}")
        else:
            # Fallback to text search
            search_url = f"https://www.carmax.com/cars/all?search={search_arg.replace(' ', '+')}"
            logging.error(f"[CarMax] Searching for: {search_arg}")

        await page.goto(search_url, wait_until='domcontentloaded', timeout=60000)

        # Wait for listings to load
        await asyncio.sleep(5)

        # Find all car tiles using the selector we discovered
        tiles = await page.query_selector_all('.kmx-car-tile')
        logging.error(f"[CarMax] Found {len(tiles)} listings")

        for i, tile in enumerate(tiles[:max_results]):
            try:
                # Method 1: Extract from data-clickprops (most reliable)
                clickprops = await tile.get_attribute('data-clickprops')
                if clickprops:
                    data = parse_data_clickprops(clickprops)
                    name = data.get('YMM', search_arg)  # Year Make Model
                    price = extract_number(data.get('Price', '0'))
                    stock_number = data.get('StockNumber', '')
                else:
                    # Fallback: parse from page elements
                    link_elem = await tile.query_selector('a[href*="/car/"]')
                    name = await link_elem.inner_text() if link_elem else search_arg
                    price = 0
                    stock_number = ''

                # Get mileage (appears in the price/mileage combo element)
                price_elem = await tile.query_selector('[class*="price"]')
                if price_elem:
                    text = await price_elem.inner_text()
                    # Text contains both price and mileage, e.g. "$14,998*\n113K mi"
                    mileage_match = re.search(r'(\d+K?)\s*mi', text, re.IGNORECASE)
                    mileage = extract_number(mileage_match.group(1)) if mileage_match else 0
                    # If mileage has K, multiply by 1000
                    if mileage_match and 'K' in mileage_match.group(1):
                        mileage = mileage * 1000
                else:
                    mileage = 0

                # Get image
                img_elem = await tile.query_selector('img')
                image = ''
                if img_elem:
                    image = await img_elem.get_attribute('src') or ''

                # Construct URL from stock number
                url = f"https://www.carmax.com/car/{stock_number}" if stock_number else ''

                # Get location (try multiple approaches)
                location = 'CarMax'
                # Look for text patterns like "CarMax Serramonte, CA"
                all_text = await tile.inner_text()
                location_match = re.search(r'CarMax\s+([^,]+),\s*([A-Z]{2})', all_text)
                if location_match:
                    location = f"CarMax {location_match.group(1)}, {location_match.group(2)}"

                if price > 0:
                    results.append({
                        'name': name.strip(),
                        'price': price,
                        'mileage': mileage,
                        'image': image,
                        'retailer': 'CarMax',
                        'url': url,
                        'location': location.strip()
                    })
                    logging.error(f"[CarMax] {name[:30]} - ${price:,} - {mileage:,} mi")

            except Exception as e:
                logging.error(f"[CarMax] Error extracting listing {i}: {e}")
                continue

    except Exception as e:
        logging.error(f"[CarMax] Scraping error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        await browser.close()

    return results


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: scrape-carmax.py <search query>"}))
        sys.exit(1)

    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    try:
        result = await scrape_carmax(query, max_results)

        if not result:
            print(json.dumps({"error": f"No CarMax listings found for '{query}'"}))
        else:
            print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())

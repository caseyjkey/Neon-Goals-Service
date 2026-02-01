#!/usr/bin/env python3
"""
AutoTrader scraper using Camoufox (VISIBLE MODE - headless doesn't work)
Supports URL filters: /cars-for-sale/gmc/sierra-3500/san-mateo-ca?trimCode=GMC3500PU|Denali
"""
import asyncio
import json
import sys
import logging
import re
from pathlib import Path

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)

try:
    from camoufox.async_api import AsyncCamoufox
except ImportError:
    print("Installing camoufox...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "camoufox"])
    from camoufox.async_api import AsyncCamoufox


def extract_number(text: str) -> int:
    if not text:
        return 0
    cleaned = re.sub(r'[^\d,.]', '', str(text))
    cleaned = cleaned.replace(',', '')
    try:
        return int(float(cleaned))
    except:
        return 0


async def scrape_autotrader(query: str, max_results: int = 10):
    results = []

    # IMPORTANT: headless=False because camoufox crashes in headless mode
    browser = await AsyncCamoufox(headless=False, humanize=True).__aenter__()

    try:
        page = await browser.new_page()

        # Check if query is a URL or text search
        if query.startswith('http'):
            # Structured URL provided (with filters)
            search_url = query
        else:
            # Fallback to text search
            search_terms = query.replace(' ', '-')
            search_url = f"https://www.autotrader.com/cars-for-sale/all-cars/{search_terms}/san-mateo-ca?searchRadius=500"

        logging.error(f"[AutoTrader] Searching: {search_url}")
        await page.goto(search_url, wait_until='domcontentloaded', timeout=60000)

        # Wait for listings to load
        await asyncio.sleep(5)

        # AutoTrader uses various listing card selectors
        # Try multiple selectors in order of preference
        selectors = [
            '[data-cmp="inventoryListingV2"]',
            '[data-type="listing"]',
            '.inventory-listing-card',
            'div[data-uuid]',
        ]

        listings = []
        for selector in selectors:
            found = await page.query_selector_all(selector)
            if found:
                listings = found
                logging.error(f"[AutoTrader] Found {len(listings)} listings using {selector}")
                break

        if not listings:
            logging.error("[AutoTrader] No listings found")
            return []

        for i, listing in enumerate(listings[:max_results]):
            try:
                # Get all text from listing
                all_text = await listing.inner_text()

                # Extract title (year + make + model + trim)
                # AutoTrader often has this in a heading or link
                title_elem = await listing.query_selector('h2, h3, a[data-cmp="subheading"]')
                if title_elem:
                    title = (await title_elem.inner_text()).strip()
                else:
                    # Try to extract from data attributes or text
                    year_match = re.search(r'\b(19|20)\d{2}\b', all_text)
                    if year_match:
                        title = year_match.group(0)
                    else:
                        title = "Vehicle"

                # Extract price - AutoTrader uses various price selectors
                price_elem = await listing.query_selector('[data-cmp="pricing"], .price, .pricing-value, [data-price]')
                price = 0
                if price_elem:
                    price_text = await price_elem.inner_text()
                    price = extract_number(price_text)

                # Extract mileage
                mileage_match = re.search(r'(\d+[,\d]*)\s*mi', all_text, re.IGNORECASE)
                mileage = extract_number(mileage_match.group(1)) if mileage_match else 0

                # Get image
                img_elem = await listing.query_selector('img')
                image = ''
                if img_elem:
                    image = await img_elem.get_attribute('src') or ''
                    # Get higher quality image if available
                    image = image.replace('/w100/', '/w400/').replace('/h100/', '/h300/')

                # Get URL
                link_elem = await listing.query_selector('a[href*="/cars-for-sale/"]')
                url = ''
                if link_elem:
                    url = await link_elem.get_attribute('href') or ''
                    url = url if url.startswith('http') else f"https://www.autotrader.com{url}"

                # Get location/dealer info
                location = 'AutoTrader'
                dealer_match = re.search(r'(.*?)(?:\s*|\s*\|\s*)(\d+\s*mi)?\s*away', all_text)
                if dealer_match:
                    location = f"AutoTrader ({dealer_match.group(1).strip()})"

                if price > 0:
                    results.append({
                        'name': title,
                        'price': price,
                        'mileage': mileage,
                        'image': image,
                        'retailer': 'AutoTrader',
                        'url': url,
                        'location': location
                    })
                    logging.error(f"[AutoTrader] {title[:30]} - ${price:,}")

            except Exception as e:
                logging.error(f"[AutoTrader] Error extracting listing {i}: {e}")
                continue

    except Exception as e:
        logging.error(f"[AutoTrader] Scraping error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        await browser.close()

    return results


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: scrape-autotrader.py <URL or search query> [max_results]"}))
        sys.exit(1)

    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    try:
        result = await scrape_autotrader(query, max_results)

        if not result:
            print(json.dumps({"error": f"No AutoTrader listings found for '{query}'"}))
        else:
            print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())

#!/usr/bin/env python3
"""
Carvana scraper using Camoufox (VISIBLE MODE - headless doesn't work)
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


async def scrape_carvana(query: str, max_results: int = 10):
    results = []

    # IMPORTANT: headless=False because camoufox crashes in headless mode
    browser = await AsyncCamoufox(headless=False, humanize=True).__aenter__()

    try:
        page = await browser.new_page()

        # Check if query is a URL or text search
        if query.startswith('http'):
            # Structured URL provided (with filters via cvnaid)
            search_url = query
        else:
            # Build simple make-model URL from text query
            # Carvana URL format: /cars/make-model
            query_lower = query.lower()
            search_slug = query_lower.replace(' ', '-')
            search_url = f"https://www.carvana.com/cars/{search_slug}"

        logging.error(f"[Carvana] Searching: {search_url}")
        await page.goto(search_url, wait_until='domcontentloaded', timeout=60000)

        # Wait for listings to load
        await asyncio.sleep(5)

        # Carvana listings are links to /vehicle/ pages
        listings = await page.query_selector_all('a[href*="/vehicle/"]')
        logging.error(f"[Carvana] Found {len(listings)} listing links")

        for i, listing in enumerate(listings[:max_results]):
            try:
                # Get all text from listing for pattern matching
                all_text = await listing.inner_text()

                # Get URL
                url = await listing.get_attribute('href') or ''
                if url and not url.startswith('http'):
                    url = f"https://www.carvana.com{url}"

                # Extract title (year + make + model + trim)
                # Format from chrome-devtools: "2023 GMC Sierra 3500 HD Crew Cab Pro 6 1/2 ft"
                # Extract year first
                year_match = re.search(r'\b(\d{4})\b', all_text)
                year = year_match.group(1) if year_match else ''

                # Build title from all text - it's typically the first meaningful text
                # Skip common labels and extract the vehicle description
                lines = [line.strip() for line in all_text.split('\n') if line.strip()]

                # Find the vehicle name (make + model + trim)
                title = ''
                for line in lines:
                    # Skip lines that are price, mileage, buttons, or labels
                    if re.search(r'^\$\d+', line):  # Price
                        continue
                    if re.search(r'\d+k?\s*miles$', line, re.IGNORECASE):  # Mileage
                        continue
                    if re.search(r'^(Estimated|Get it|Free shipping|Cash down|mo|Purchase|Recent|Price Drop|Great Deal|Favorite|On hold)', line, re.IGNORECASE):
                        continue
                    if line in ['Audi', 'BMW', 'Chevrolet', 'Ford', 'GMC', 'Honda', 'Toyota', 'Mercedes-Benz', 'Ram', 'Jeep']:
                        # Just the make name, continue to get full model line
                        continue

                    # This should be the vehicle description line
                    # Skip if it's just the year
                    if line == year:
                        continue

                    # If line looks like vehicle description (contains model words)
                    if len(line) > 10 and not line.startswith('$'):
                        title = line
                        break

                # If no title found, use query
                if not title:
                    title = query

                # Extract price (pattern: "$25,990")
                price_match = re.search(r'\$\s*([\d,]+)', all_text)
                price = 0
                if price_match:
                    price = extract_number(price_match.group(1))

                # Extract mileage (pattern: "54k miles" or "16,000 miles")
                mileage_match = re.search(r'(\d+[,\d]*)\s*(k|k)?\s*miles', all_text, re.IGNORECASE)
                mileage = 0
                if mileage_match:
                    mileage = extract_number(mileage_match.group(1))
                    if mileage_match.group(2) and 'k' in mileage_match.group(2).lower():
                        mileage = mileage * 1000

                # Get image
                img_elem = await listing.query_selector('img')
                image = ''
                if img_elem:
                    image = await img_elem.get_attribute('src') or ''

                # Carvana delivers nationally, so location is just "Carvana"
                location = 'Carvana'

                if price > 0:
                    results.append({
                        'name': title,
                        'price': price,
                        'mileage': mileage,
                        'image': image,
                        'retailer': 'Carvana',
                        'url': url,
                        'location': location
                    })
                    logging.error(f"[Carvana] {title[:40]} - ${price:,} - {mileage:,} mi")

            except Exception as e:
                logging.error(f"[Carvana] Error extracting listing {i}: {e}")
                import traceback
                traceback.print_exc()
                continue

    except Exception as e:
        logging.error(f"[Carvana] Scraping error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        await browser.close()

    return results


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: scrape-carvana.py <search query>"}))
        sys.exit(1)

    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    try:
        result = await scrape_carvana(query, max_results)

        if not result:
            print(json.dumps({"error": f"No Carvana listings found for '{query}'"}))
        else:
            print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())

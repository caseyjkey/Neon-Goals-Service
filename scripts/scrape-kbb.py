#!/usr/bin/env python3
"""
KBB (Kelley Blue Book) scraper using Camoufox (VISIBLE MODE - headless doesn't work)
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


async def scrape_kbb(query: str, max_results: int = 10):
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
            search_terms = query.replace(' ', '%20')
            search_url = f"https://www.kbb.com/cars-for-sale/all?searchRadius=75&city=San%20Mateo&state=CA&zip=94401&allListingType=all&keywords={search_terms}"

        logging.error(f"[KBB] Searching: {search_url}")
        await page.goto(search_url, wait_until='domcontentloaded', timeout=60000)

        # Wait for listings to load
        await asyncio.sleep(5)

        # KBB listings are links containing vehicle details
        # Based on chrome-devtools analysis, listings contain text like:
        # "New 2026 GMC Sierra 3500 Denali Ultimate $103,615 Dublin Buick GMC"
        # with URL pattern: /cars-for-sale/vehicledetails.xhtml/?listingId=...
        listings = await page.query_selector_all('a[href*="/cars-for-sale/vehicledetails.xhtml/"]')
        logging.error(f"[KBB] Found {len(listings)} listing links")

        for i, listing in enumerate(listings[:max_results]):
            try:
                # Get all text from the link
                all_text = await listing.inner_text()

                # Get URL
                url = await listing.get_attribute('href') or ''
                if not url.startswith('http'):
                    url = f"https://www.kbb.com{url}"

                # Parse the listing text to extract components
                # Format: "New 2026\nGMC Sierra 3500 Denali Ultimate\n$103,615\nDublin Buick GMC"
                lines = [line.strip() for line in all_text.split('\n') if line.strip()]
                logging.error(f"[KBB] Listing text lines: {lines}")

                # Extract condition + year (e.g., "New 2026")
                condition = ""
                year = 0
                title = ""

                # Extract price (format: "$103,615")
                price = 0
                for line in lines:
                    price_match = re.search(r'\$?([\d,]+)', line)
                    if price_match and ',' in price_match.group(1):
                        price = extract_number(line)
                        break

                # Extract vehicle name (make/model/trim)
                # Skip lines that are condition/year, price, or dealer names
                for line in lines:
                    # Skip price lines, dealer lines, condition lines
                    if re.search(r'(New|Used|Certified)\s+\d{4}', line):
                        # Extract year from condition line
                        year_match = re.search(r'\d{4}', line)
                        if year_match:
                            year = int(year_match.group(0))
                        condition = line.split()[0]  # "New", "Used", etc
                    elif not re.search(r'\$[\d,]+', line) and not re.search(r'(Buick|GMC|Dealer|Availability)', line, re.IGNORECASE):
                        # This is likely the vehicle name
                        if not title and len(line) > 5:  # Minimum reasonable name length
                            title = line
                            break

                # If we didn't find a proper title, use query
                if not title:
                    title = query

                # Extract dealer name (usually appears near "Confirm Availability" button text)
                dealer = 'KBB Dealer'
                for line in lines:
                    # Look for dealer names (multi-word, often contains GMC/Buick/etc)
                    if re.search(r'(Buick|GMC|Chevrolet|Ford|Toyota|Honda|Dealer)', line, re.IGNORECASE):
                        if not line.startswith('Confirm') and not line.startswith('New'):
                            dealer = line
                            break

                # Get image if present
                img_elem = await listing.query_selector('img')
                image = ''
                if img_elem:
                    image = await img_elem.get_attribute('src') or ''

                # For new vehicles, mileage is typically 0
                mileage = 0
                if condition.lower() == 'used':
                    # Try to extract mileage from text (format: "60K mi" or "3 mi")
                    mileage_match = re.search(r'(\d+[,\d]*)\s*(K|k)?\s*mi', all_text, re.IGNORECASE)
                    if mileage_match:
                        mileage = extract_number(mileage_match.group(1))
                        if 'K' in mileage_match.group(0) or 'k' in mileage_match.group(0):
                            mileage = mileage * 1000

                if price > 0:
                    results.append({
                        'name': title,
                        'price': price,
                        'mileage': mileage,
                        'image': image,
                        'retailer': 'KBB',
                        'url': url,
                        'location': dealer
                    })
                    logging.error(f"[KBB] {title[:40]} - ${price:,} - {dealer[:20]}")

            except Exception as e:
                logging.error(f"[KBB] Error extracting listing {i}: {e}")
                import traceback
                traceback.print_exc()
                continue

    except Exception as e:
        logging.error(f"[KBB] Scraping error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        await browser.close()

    return results


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: scrape-kbb.py <search query>"}))
        sys.exit(1)

    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    try:
        result = await scrape_kbb(query, max_results)

        if not result:
            print(json.dumps({"error": f"No KBB listings found for '{query}'"}))
        else:
            print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())

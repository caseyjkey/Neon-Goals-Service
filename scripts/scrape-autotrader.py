#!/usr/bin/env python3
"""
AutoTrader scraper using Chrome CDP (primary) or Camoufox (fallback)

Accepts structured query format (from parse_vehicle_query.py) and
converts it to AutoTrader-specific parameters via the adapter function.
"""
import json
import os
import sys
import tempfile
import logging
import re
import random
import time
from pathlib import Path
from typing import Dict

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)

# Try to import Playwright for CDP first
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

# Try to import Camoufox as fallback
try:
    from camoufox.sync_api import Camoufox
    from browserforge.fingerprints import Screen
    CAMOUFOX_AVAILABLE = True
except ImportError:
    CAMOUFOX_AVAILABLE = False


def adapt_structured_to_autotrader(structured: dict) -> str:
    """
    Convert structured query format to AutoTrader search query string.

    The structured format is the universal format output by parse_vehicle_query.py.
    Each scraper has its own adapter to convert this to scraper-specific params.

    AutoTrader specifics:
    - Uses text-based search query (like "GMC Sierra Denali black")
    - Supports make/model/trim/color combinations
    - Location can be added with "near [zip]" or similar

    Args:
        structured: The structured query dict with keys like makes, models, trims, etc.

    Returns:
        AutoTrader search query string
    """
    parts = []

    # Add make/model/trim
    if structured.get('makes'):
        parts.extend(structured['makes'])

    if structured.get('models'):
        # AutoTrader combines make and model nicely
        for model in structured['models']:
            parts.append(model)

    if structured.get('trims'):
        parts.extend(structured['trims'])

    # Add color
    if structured.get('exteriorColor'):
        parts.append(structured['exteriorColor'])

    # Add other key features as text
    if structured.get('features'):
        # Add notable features that help search
        feature_keywords = {
            'Seat Massagers': 'massaging seats',
            'Sunroof': 'sunroof',
            'Navigation': 'navigation',
            'Tow Hitch': 'tow hitch'
        }
        for feature in structured['features']:
            if feature in feature_keywords:
                parts.append(feature_keywords[feature])

    # Build query
    query = ' '.join(parts)

    # Add location if provided
    location = structured.get('location', {})
    if location.get('zip'):
        query += f' near {location["zip"]}'
    elif location.get('city'):
        query += f' near {location["city"]}'
        if location.get('state'):
            query += f', {location["state"]}'

    return query


def extract_number(text: str) -> int:
    if not text:
        return 0
    cleaned = re.sub(r'[^\d,.]', '', str(text))
    cleaned = cleaned.replace(',', '')
    try:
        return int(float(cleaned))
    except:
        return 0


def scrape_with_playwright_cdp(query: str, max_results: int, cdp_url: str = "http://localhost:9222"):
    """Scrape using Playwright connected to Chrome CDP"""
    results = []

    with sync_playwright() as p:
        try:
            logging.error(f"[AutoTrader] Connecting to Chrome CDP at {cdp_url}...")
            browser = p.chromium.connect_over_cdp(cdp_url)

            # Use the first context or create a new one
            if browser.contexts:
                context = browser.contexts[0]
            else:
                context = browser.new_context()

            # Use existing page or create new one, close other pages
            if len(context.pages) > 0:
                # Close extra pages, keep only one
                while len(context.pages) > 1:
                    context.pages[-1].close()
                page = context.pages[0]
            else:
                page = context.new_page()

            logging.error(f"[AutoTrader] Connected via CDP!")
        except Exception as e:
            logging.error(f"[AutoTrader] CDP connection failed: {e}")
            return None

        try:
            logging.error(f"[AutoTrader] Query: {query}")

            # Use the query URL directly if it's a full URL
            if query.startswith('http'):
                search_url = query
            else:
                # Build search URL from text query
                search_terms_slug = query.replace(' ', '-').lower()
                search_url = f"https://www.autotrader.com/cars-for-sale/{search_terms_slug}/san-mateo-ca?searchRadius=500"

            logging.error(f"[AutoTrader] Navigating to: {search_url}")
            page.goto(search_url, wait_until='domcontentloaded', timeout=60000)
            time.sleep(random.uniform(2, 4))

            # Wait for listings
            try:
                page.wait_for_selector('a[href*="/cars-for-sale/vehicle/"]', timeout=30000)
                logging.error(f"[AutoTrader] Vehicle links appeared")
            except:
                logging.error(f"[AutoTrader] Timeout waiting for vehicle links")

            # Infinite scroll
            last_listing_count = 0
            scroll_attempts = 0
            max_scroll_attempts = 15

            while scroll_attempts < max_scroll_attempts:
                listings = page.query_selector_all('a[href*="/cars-for-sale/vehicle/"]')
                current_count = len(listings)
                logging.error(f"[AutoTrader] Scroll attempt {scroll_attempts + 1}: Found {current_count} listings")

                if current_count >= max_results or current_count == last_listing_count:
                    if current_count == last_listing_count and current_count > 0:
                        break
                    break

                last_listing_count = current_count
                scroll_height = scroll_attempts * 800 + 1000
                page.evaluate(f'window.scrollBy(0, {scroll_height})')
                time.sleep(1.5)
                scroll_attempts += 1

            page.evaluate('window.scrollTo(0, 0)')
            time.sleep(2)

            # Check for bot detection
            page_text = page.inner_text('body')
            if any(indicator in page_text.lower() for indicator in ['page unavailable', 'incident number:', 'we\'re sorry']):
                logging.error(f"[AutoTrader] Bot detected - returning empty")
                return []

            # Deduplicate and extract listings
            listings = page.query_selector_all('a[href*="/cars-for-sale/vehicle/"]')
            logging.error(f"[AutoTrader] Found {len(listings)} vehicle listing links")

            seen_vehicle_ids = set()
            for listing in listings:
                url = listing.get_attribute('href') or ''
                clean_url = url.split('#')[0]
                vehicle_id_match = re.search(r'/vehicle/(\d+)', clean_url)
                if vehicle_id_match:
                    vehicle_id = vehicle_id_match.group(1)
                    if vehicle_id not in seen_vehicle_ids:
                        seen_vehicle_ids.add(vehicle_id)
                        # Extract listing data...
                        link_text = listing.inner_text()
                        title = link_text.strip()

                        if not title or len(title) < 10:
                            continue

                        # Get price and mileage from ancestor text
                        all_text = ''
                        for ancestor_level in range(1, 13):
                            try:
                                ancestor = listing.evaluate(f'el => {{ let p = el; for(let i=0; i<{ancestor_level}; i++) p = p?.parentElement; return p?.innerText; }}')
                                if ancestor and len(ancestor) > 100:
                                    all_text = ancestor
                                    break
                            except:
                                continue

                        price_match = re.search(r'\$\s*([\d,]+)', all_text)
                        price = extract_number(price_match.group(1)) if price_match else 0

                        if price == 0:
                            for match in re.finditer(r'(\d{1,2},\d{3})', all_text):
                                potential_price = extract_number(match.group(1))
                                if 5000 <= potential_price <= 500000:
                                    price = potential_price
                                    break

                        mileage_match = re.search(r'(\d+)\s*mi\b', all_text, re.IGNORECASE)
                        mileage = int(mileage_match.group(1)) if mileage_match else 0

                        # Get image from ancestor elements
                        image = ''
                        try:
                            img_src = listing.evaluate('''
                                el => {
                                    for (let level = 1; level <= 8; level++) {
                                        let ancestor = el;
                                        for (let i = 0; i < level; i++) {
                                            if (ancestor) ancestor = ancestor.parentElement;
                                        }
                                        if (!ancestor) continue;
                                        const img = ancestor.querySelector('img');
                                        if (img && img.src && img.src.includes('autotrader.com')) {
                                            return img.src;
                                        }
                                    }
                                    return '';
                                }
                            ''')
                            if img_src:
                                image = img_src
                        except:
                            pass

                        if price > 0:
                            results.append({
                                'name': title,
                                'price': price,
                                'mileage': mileage,
                                'image': image,
                                'retailer': 'AutoTrader',
                                'url': f"https://www.autotrader.com{clean_url}" if not clean_url.startswith('http') else clean_url,
                                'location': 'AutoTrader'
                            })
                            logging.error(f"[AutoTrader] {title[:30]} - ${price:,}")

                        if len(results) >= max_results:
                            break

        except Exception as e:
            logging.error(f"[AutoTrader] CDP scraping error: {e}")

        return results


def scrape_with_camoufox(query: str, max_results: int):
    """Scrape using Camoufox as fallback"""
    results = []

    os_choice = random.choice(['windows', 'macos', 'linux'])

    with Camoufox(
        headless=False,
        os=(os_choice,),
        screen=Screen(max_width=800, max_height=600),
        humanize=True,
    ) as browser:
        page = browser.new_page()

        logging.error(f"[AutoTrader] Using Camoufox with {os_choice} fingerprint...")
        page.goto("https://www.autotrader.com", wait_until='domcontentloaded', timeout=30000)
        time.sleep(random.uniform(5, 10))

        # Determine search terms
        if query.startswith('http'):
            parts = query.split('/')
            if 'cars-for-sale' in parts:
                idx = parts.index('cars-for-sale')
                if idx + 2 < len(parts):
                    make = parts[idx + 1].replace('-', ' ').title()
                    model = parts[idx + 2].split('-')[0].replace('-', ' ').title() if idx + 2 < len(parts) else ''
                    search_terms = f"{make} {model}".strip()
                else:
                    search_terms = "GMC Sierra"
            else:
                search_terms = "GMC Sierra"
        else:
            search_terms = query

        search_terms_slug = search_terms.replace(' ', '-').lower()
        search_url = f"https://www.autotrader.com/cars-for-sale/{search_terms_slug}/san-mateo-ca?searchRadius=500"

        logging.error(f"[AutoTrader] Navigating to: {search_url}")
        page.goto(search_url, wait_until='domcontentloaded', timeout=60000)
        time.sleep(random.uniform(3, 5))

        # Same extraction logic as CDP...
        try:
            page.wait_for_selector('a[href*="/cars-for-sale/vehicle/"]', timeout=30000)
        except:
            pass

        listings = page.query_selector_all('a[href*="/cars-for-sale/vehicle/"]')

        for listing in listings[:max_results]:
            url = listing.get_attribute('href') or ''
            if not url:
                continue

            # Extract data (simplified for brevity)
            link_text = listing.inner_text()
            title = link_text.strip()

            if not title or len(title) < 10:
                continue

            # Get ancestor text for price
            try:
                all_text = ''
                for ancestor_level in range(1, 8):
                    try:
                        ancestor = listing.evaluate(f'el => {{ let p = el; for(let i=0; i<{ancestor_level}; i++) p = p?.parentElement; return p?.innerText; }}')
                        if ancestor and len(ancestor) > 50:
                            all_text = ancestor
                            break
                    except:
                        continue

                price_match = re.search(r'\$\s*([\d,]+)', all_text)
                price = extract_number(price_match.group(1)) if price_match else 0

                # Get image from ancestor elements
                image = ''
                try:
                    img_src = listing.evaluate('''
                        el => {
                            for (let level = 1; level <= 8; level++) {
                                let ancestor = el;
                                for (let i = 0; i < level; i++) {
                                    if (ancestor) ancestor = ancestor.parentElement;
                                }
                                if (!ancestor) continue;
                                const img = ancestor.querySelector('img');
                                if (img && img.src && img.src.includes('autotrader.com')) {
                                    return img.src;
                                }
                            }
                            return '';
                        }
                    ''')
                    if img_src:
                        image = img_src
                except:
                    pass

                if price > 0:
                    results.append({
                        'name': title,
                        'price': price,
                        'mileage': 0,
                        'image': image,
                        'retailer': 'AutoTrader',
                        'url': url,
                        'location': 'AutoTrader'
                    })
                    logging.error(f"[AutoTrader] {title[:30]} - ${price:,}")

            except:
                continue

    return results


def scrape_autotrader(query: str, max_results: int = 10, cdp_url: str = "http://localhost:9222"):
    """
    Main scrape function that tries CDP first, then falls back to Camoufox
    """
    # Try CDP first if Playwright is available
    if PLAYWRIGHT_AVAILABLE:
        logging.error(f"[AutoTrader] Trying Chrome CDP...")
        results = scrape_with_playwright_cdp(query, max_results, cdp_url)

        if results is not None:  # CDP connection succeeded
            if results:
                logging.error(f"[AutoTrader] CDP scraping successful: {len(results)} results")
                return results
            else:
                logging.error(f"[AutoTrader] CDP returned no results")
                return results
        else:
            logging.error(f"[AutoTrader] CDP connection failed, trying fallback...")

    # Fallback to Camoufox
    if CAMOUFOX_AVAILABLE:
        logging.error(f"[AutoTrader] Using Camoufox fallback...")
        return scrape_with_camoufox(query, max_results)
    else:
        logging.error(f"[AutoTrader] No scraping backend available!")
        return []


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: scrape-autotrader.py <URL or search query or structured> [max_results] [cdp_url]",
            "examples": [
                "scrape-autotrader.py 'GMC Sierra Denali black'",
                "scrape-autotrader.py 'https://www.autotrader.com/cars-for-sale/...'",
                "scrape-autotrader.py '{\"structured\": {...}}'  # From parse_vehicle_query.py"
            ],
            "note": "Start Chrome with: google-chrome --remote-debugging-port=9222"
        }))
        sys.exit(1)

    query_input = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    cdp_url = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:9222"

    # Parse input to determine format
    query = query_input

    if query_input.strip().startswith('{'):
        # Structured JSON format from parse_vehicle_query.py
        try:
            structured_data = json.loads(query_input)
            if 'structured' in structured_data:
                # Use adapter to convert structured to AutoTrader query
                query = adapt_structured_to_autotrader(structured_data['structured'])
            else:
                query = query_input  # Use as-is
        except json.JSONDecodeError:
            query = query_input
    elif not query_input.startswith('http'):
        # Plain text query - use as-is
        query = query_input

    try:
        result = scrape_autotrader(query, max_results, cdp_url)

        if not result:
            print(json.dumps({"error": f"No AutoTrader listings found for '{query}'"}))
            sys.stdout.flush()
        else:
            output = json.dumps(result, indent=2)
            print(output)
            sys.stdout.flush()
            # Also write to temp file as backup
            with open(f"/tmp/scraper_output_{os.getpid()}.json", "w") as f:
                f.write(output)
            f.flush()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
            sys.stdout.flush()
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()

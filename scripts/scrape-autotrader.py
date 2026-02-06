#!/usr/bin/env python3
"""
AutoTrader scraper using Camoufox with VPN rotation support.

Accepts structured query format (from parse_vehicle_query.py) and
converts it to AutoTrader-specific parameters via the adapter function.

Features:
- VPN rotation when bot detection is triggered
- Automatic retry with IP rotation
- Camoufox anti-detection browser
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
from typing import Dict, Optional, List

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

# Try to import VPN manager
try:
    from vpn_manager import create_vpn_manager
    VPN_AVAILABLE = True
except ImportError:
    VPN_AVAILABLE = False

# Global VPN manager instance
_vpn_manager = None
_max_vpn_rotations = 3


def get_vpn_manager():
    """Get or create the global VPN manager instance."""
    global _vpn_manager
    if _vpn_manager is None and VPN_AVAILABLE:
        # gilbert has 5 WireGuard configs (v1.conf through v5.conf)
        _vpn_manager = create_vpn_manager(total_configs=5, config_prefix="v")
    return _vpn_manager


def adapt_structured_to_autotrader(structured: dict) -> str:
    """
    Convert structured query format to AutoTrader URL.

    The structured format is the universal format output by parse_vehicle_query.py.
    Each scraper has its own adapter to convert this to scraper-specific params.

    AutoTrader specifics:
    - URL format: /cars-for-sale/{make}/{model}/{trim}/{location}?{params}
    - Example: /cars-for-sale/gmc/sierra-3500/denali-ultimate/san-mateo-ca?endYear=2024&searchRadius=500
    - Supports trim, location, and year filters in URL

    Args:
        structured: The structured query dict with keys like makes, models, trims, etc.

    Returns:
        AutoTrader URL string
    """
    # Get make (first one if multiple) - handle both singular and plural
    makes = structured.get('makes') or ([structured.get('make')] if structured.get('make') else [])
    make = makes[0].lower().replace(' ', '-') if makes else ''

    # Get model (first one if multiple) - handle both singular and plural
    models = structured.get('models') or ([structured.get('model')] if structured.get('model') else [])
    model = models[0].lower().replace(' ', '-') if models else ''

    # Get trim (first one if multiple)
    trims = structured.get('trims', [])
    trim = trims[0].lower().replace(' ', '-') if trims else ''

    # Build base URL path
    path_parts = ["cars-for-sale"]
    if make:
        path_parts.append(make)
    if model:
        path_parts.append(model)
    if trim:
        path_parts.append(trim)

    # Add location to path - handle both location dict and zip code
    location = structured.get('location', {})
    zip_code = structured.get('zip')
    
    # If we have a zip code, skip adding location to path (use query param instead)
    if not zip_code:
        city = location.get('city', '').lower().replace(' ', '-') if location.get('city') else ''
        state = location.get('state', '').lower() if location.get('state') else ''
        
        if city or state:
            location_part = f"{city}-{state}" if city and state else (city or state)
            path_parts.append(location_part)

    url_path = '/' + '/'.join(path_parts)

    # Build query parameters
    params = []

    # Add zip code if provided
    if structured.get('zip'):
        params.append(f"zip={structured['zip']}")

    # Add search radius (use provided radius or default to 500)
    radius = structured.get('radius', 500)
    params.append(f"searchRadius={radius}")

    # Add year range
    year = structured.get('year', {})
    if isinstance(year, dict):
        if year.get('min'):
            params.append(f"startYear={year['min']}")
        if year.get('max'):
            params.append(f"endYear={year['max']}")
    elif isinstance(year, int):
        params.append(f"startYear={year}&endYear={year}")

    # Fallback to yearMin/yearMax if year dict not provided
    if structured.get('yearMin'):
        params.append(f"startYear={structured['yearMin']}")
    if structured.get('yearMax'):
        params.append(f"endYear={structured['yearMax']}")

    # Add max price if specified
    if structured.get('maxPrice'):
        params.append(f"maxPrice={structured['maxPrice']}")

    # Build final URL
    base_url = "https://www.autotrader.com"
    query_string = '&'.join(params)
    url = f"{base_url}{url_path}?{query_string}"

    return url


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


def scrape_with_camoufox(query: str, max_results: int, os_choice: str = None):
    """
    Scrape using Playwright Firefox (formerly Camoufox).
    Name kept for compatibility but now uses regular Firefox for better fingerprint.
    """
    results = []

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logging.error("[AutoTrader] Playwright not available!")
        return None

    with sync_playwright() as p:
        browser = p.firefox.launch(
            headless=False,
            firefox_user_prefs={"dom.webdriver.enabled": False}
        )

        context = browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = context.new_page()

        logging.error(f"[AutoTrader] Using Playwright Firefox...")

        if query.startswith('http'):
            search_url = query
        else:
            search_terms = query.replace(' ', '-').lower()
            search_url = f"https://www.autotrader.com/cars-for-sale/{search_terms}?searchRadius=500&zip=94401"

        logging.error(f"[AutoTrader] Navigating to: {search_url}")
        try:
            page.goto(search_url, timeout=60000)
            time.sleep(5)
        except Exception as e:
            logging.error(f"[AutoTrader] Navigation error: {e}")
            time.sleep(5)

        page_text = page.inner_text('body')

        try:
            screenshot_path = f"/tmp/autotrader_debug_{os.getpid()}.png"
            page.screenshot(path=screenshot_path)
            logging.error(f"[AutoTrader] Debug screenshot: {screenshot_path}")
        except:
            pass

        logging.error(f"[AutoTrader] Page text preview: {page_text[:200]}")

        if any(keyword in page_text.lower() for keyword in ['unavailable', 'incident number', 'blocked']):
            logging.error(f"[AutoTrader] BOT DETECTED - retry needed")
            browser.close()
            return None

        logging.error(f"[AutoTrader] Page loaded successfully, extracting...")

        try:
            page.wait_for_selector('[data-cmp="inventoryListing"]', timeout=10000)
        except:
            logging.error(f"[AutoTrader] No listings found or timeout")

        listing_cards = page.query_selector_all('[data-cmp="inventoryListing"]')
        logging.error(f"[AutoTrader] Found {len(listing_cards)} listings")

        for idx, card in enumerate(listing_cards):
            if idx >= max_results:
                break
            try:
                # Title - h2 with data-cmp=subheading
                title_elem = card.query_selector('h2[data-cmp="subheading"]')
                title = title_elem.inner_text().strip() if title_elem else "Unknown"

                # Price - div with data-cmp=firstPrice (just number, no $ sign)
                price_elem = card.query_selector('div[data-cmp="firstPrice"]')
                price_text = price_elem.inner_text().strip() if price_elem else ""
                price = int(price_text.replace(',', '')) if price_text and price_text.replace(',', '').isdigit() else 0

                # Mileage - in the list items, look for text containing "mi"
                mileage = 0
                list_items = card.query_selector_all('ul[data-cmp="list"] li')
                for item in list_items:
                    text = item.inner_text().strip()
                    if 'mi' in text.lower():
                        # Extract number from "65K mi" or "12,345 mi"
                        num_match = re.search(r'([\d,]+(?:\.\d+)?)\s*[kK]?\s*mi', text, re.IGNORECASE)
                        if num_match:
                            num_str = num_match.group(1).replace(',', '')
                            # Handle K suffix
                            if 'k' in text.lower():
                                mileage = int(float(num_str) * 1000)
                            else:
                                mileage = int(float(num_str))
                        break

                # Location - try various selectors
                location = "Unknown"
                location_selectors = [
                    '[data-cmp="listingSummaryLocationText"]',
                    '.dealer-name',
                    '.location-text',
                    '[data-cmp="dealerName"]'
                ]
                for selector in location_selectors:
                    location_elem = card.query_selector(selector)
                    if location_elem:
                        location = location_elem.inner_text().strip()
                        break

                # Link - AutoTrader listings always have a link
                # HTML structure: <a href="..."><h2 data-cmp="subheading">TITLE</h2></a>
                # The anchor wraps the h2, so we need to find h2 first, then get parent anchor
                link = ""
                try:
                    # Find the h2 element with data-cmp="subheading"
                    h2_elem = card.query_selector('h2[data-cmp="subheading"]')

                    if h2_elem:
                        # Get the parent anchor tag of the h2 element
                        # The anchor wraps the h2, so we use evaluate to call closest() on the h2
                        link_result = h2_elem.evaluate('(el) => { const anchor = el.closest("a"); return anchor ? anchor.href : null; }')
                        if link_result:
                            link = link_result
                            logging.error(f"[AutoTrader] Listing {idx}: Found URL via h2 parent anchor: {link[:80]}...")
                        else:
                            logging.error(f"[AutoTrader] Listing {idx}: h2 found but no parent anchor")
                    else:
                        logging.error(f"[AutoTrader] Listing {idx}: No h2[data-cmp='subheading'] found in card")

                    # Fallback: try finding anchor with vehicle href directly
                    if not link:
                        fallback_links = card.query_selector_all('a[href*="/cars-for-sale/vehicle/"]')
                        if fallback_links:
                            link = fallback_links[0].get_attribute('href') or ""
                            logging.error(f"[AutoTrader] Listing {idx}: Found URL via fallback (vehicle href)")

                except Exception as e:
                    logging.error(f"[AutoTrader] Error extracting link for listing {idx}: {e}")

                # If still no link, log details for debugging
                if not link:
                    logging.error(f"[AutoTrader] Listing {idx}: NO URL FOUND - this should not happen")
                    # Still add the listing - user wants all listings
                    link = f"https://www.autotrader.com/error-no-url-{idx}"

                vehicle = {
                    "name": title,           # Changed from "title" to "name" for backend compatibility
                    "price": price,
                    "mileage": mileage,
                    "location": location,
                    "url": link,             # Changed from "link" to "url" for backend compatibility
                    "image": "",            # Will be filled by backend if missing
                    "retailer": "AutoTrader",  # Explicit retailer name
                    "source": "autotrader"
                }

                results.append(vehicle)
                logging.error(f"[AutoTrader] Extracted: {title} - ${price:,}")

            except Exception as e:
                logging.error(f"[AutoTrader] Error extracting vehicle {idx}: {e}")
                continue

        browser.close()

    return results

def scrape_autotrader(query: str, max_results: int = 10, cdp_url: str = "http://localhost:9222", enable_vpn: bool = True):
    """
    Main scrape function with VPN rotation support.

    Args:
        query: Search URL or structured query
        max_results: Maximum number of results to return
        cdp_url: CDP URL (not used, kept for compatibility)
        enable_vpn: Whether to use VPN rotation (default: True)

    Returns:
        List of vehicle listings
    """
    global _max_vpn_rotations

    # If Camoufox is not available, fall back to CDP
    if not CAMOUFOX_AVAILABLE:
        logging.error(f"[AutoTrader] Camoufox not available, falling back to CDP...")
        # CDP doesn't support VPN rotation, just try once
        return scrape_with_playwright_cdp(query, max_results, cdp_url)

    # Initialize VPN if enabled
    vpn = get_vpn_manager() if enable_vpn else None
    if vpn and vpn.vpn_enabled is False:
        # Start with VPN enabled
        logging.error(f"[AutoTrader] Starting VPN for scraping...")
        vpn.rotate_vpn()

    # Try scraping with VPN rotation on bot detection
    # Systematically try different OS fingerprints
    os_options = ['windows', 'macos', 'linux']

    for attempt in range(_max_vpn_rotations + 1):
        os_choice = os_options[attempt % len(os_options)]
        logging.error(f"[AutoTrader] Scrape attempt {attempt + 1}/{_max_vpn_rotations + 1} (OS: {os_choice})")

        result = scrape_with_camoufox(query, max_results, os_choice=os_choice)

        # Success (scraping completed) - return results
        # result is not None means scraping succeeded (even if empty list)
        # result is None means bot detected
        if result is not None:
            if vpn:
                logging.error(f"[AutoTrader] Got {len(result)} results")
            return result

        # Bot detected (result is None) - rotate VPN and retry
        if result is None and vpn:
            logging.error(f"[AutoTrader] Bot detected, rotating VPN...")
            vpn.rotate_vpn()
            time.sleep(3)  # Give VPN time to settle
        elif result is None and not vpn:
            # No VPN available and bot detected
            logging.error(f"[AutoTrader] Bot detected but VPN not available - giving up")
            break

    # If we get here, all attempts failed
    logging.error(f"[AutoTrader] All {_max_vpn_rotations + 1} attempts failed")
    return []


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: scrape-autotrader.py <URL or search query or structured> [max_results] [cdp_url] [--no-vpn]",
            "examples": [
                "scrape-autotrader.py 'GMC Sierra Denali black'",
                "scrape-autotrader.py 'https://www.autotrader.com/cars-for-sale/...'",
                "scrape-autotrader.py '{\"structured\": {...}}'  # From parse_vehicle_query.py",
                "scrape-autotrader.py '{\"structured\": {...}}' 10 '' --no-vpn  # Disable VPN"
            ],
            "note": "VPN rotation is enabled by default. Use --no-vpn to disable.",
            "vpn": "Requires WireGuard configs in /etc/wireguard/ and sudo access."
        }))
        sys.exit(1)

    query_input = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    cdp_url = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:9222"

    # Check for --no-vpn flag
    enable_vpn = '--no-vpn' not in sys.argv

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
        result = scrape_autotrader(query, max_results, cdp_url, enable_vpn=enable_vpn)

        # Cleanup: Disable VPN after scraping
        if enable_vpn:
            vpn = get_vpn_manager()
            if vpn:
                logging.error(f"[AutoTrader] Cleaning up VPN...")
                vpn.disable_vpn()

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
        # Cleanup on error
        if enable_vpn:
            vpn = get_vpn_manager()
            if vpn:
                vpn.disable_vpn()

        print(json.dumps({"error": str(e)}))
        sys.stdout.flush()
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()

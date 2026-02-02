#!/usr/bin/env python3
"""
AutoTrader scraper using Chrome remote debugging (CDP) as fallback
Connects to a real Chrome browser for maximum stealth
"""
import json
import sys
import logging
import re
import random
import time
from pathlib import Path

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Installing playwright...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "playwright"])
    from playwright.sync_api import sync_playwright


def extract_number(text: str) -> int:
    if not text:
        return 0
    cleaned = re.sub(r'[^\d,.]', '', str(text))
    cleaned = cleaned.replace(',', '')
    try:
        return int(float(cleaned))
    except:
        return 0


def scrape_autotrader_cdp(query: str, max_results: int = 10, cdp_url: str = "http://localhost:9222"):
    """
    Scrape AutoTrader using Chrome remote debugging (CDP)
    Requires Chrome to be started with: chrome --remote-debugging-port=9222
    """
    results = []

    with sync_playwright() as p:
        try:
            # Connect to Chrome via CDP
            logging.error(f"[AutoTrader] Connecting to Chrome CDP at {cdp_url}...")
            browser = p.chromium.connect_over_cdp(cdp_url)

            # Get or create context and page
            default_context = browser.contexts[0] if browser.contexts else browser.new_context()
            page = default_context.pages[0] if default_context.pages else default_context.new_page()

            logging.error(f"[AutoTrader] Connected successfully!")
        except Exception as e:
            logging.error(f"[AutoTrader] Failed to connect to CDP: {e}")
            logging.error(f"[AutoTrader] Make sure Chrome is running with: chrome --remote-debugging-port=9222")
            return None  # Return None to indicate fallback failed

        try:
            # Navigate to AutoTrader homepage first (natural human behavior)
            logging.error(f"[AutoTrader] Navigating to homepage via real Chrome...")
            page.goto("https://www.autotrader.com", wait_until='domcontentloaded', timeout=30000)
            time.sleep(random.uniform(3, 6))  # Human-like pause on homepage

            # Determine search terms and build simple search URL
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

            # Build search URL - simple format that humans would use
            search_terms_slug = search_terms.replace(' ', '-').lower()
            search_url = f"https://www.autotrader.com/cars-for-sale/{search_terms_slug}/san-mateo-ca?searchRadius=500"

            logging.error(f"[AutoTrader] Navigating to search URL: {search_url}")

            # Navigate to search results
            page.goto(search_url, wait_until='domcontentloaded', timeout=60000)
            time.sleep(random.uniform(2, 4))  # Wait for page to fully load

            # Wait for listings to load
            try:
                page.wait_for_selector('a[href*="/cars-for-sale/vehicle/"]', timeout=30000)
                logging.error(f"[AutoTrader] Vehicle links appeared")
            except:
                logging.error(f"[AutoTrader] Timeout waiting for vehicle links")

            # AutoTrader uses infinite scroll - need to scroll down to load all listings
            last_listing_count = 0
            scroll_attempts = 0
            max_scroll_attempts = 15

            while scroll_attempts < max_scroll_attempts:
                # Check current number of listing links
                listings = page.query_selector_all('a[href*="/cars-for-sale/vehicle/"]')
                current_count = len(listings)
                logging.error(f"[AutoTrader] Scroll attempt {scroll_attempts + 1}: Found {current_count} listings")

                # If we have enough results or no new results loaded, stop scrolling
                if current_count >= max_results or current_count == last_listing_count:
                    if current_count == last_listing_count and current_count > 0:
                        logging.error(f"[AutoTrader] No new listings loaded, stopping scroll")
                    break

                last_listing_count = current_count

                # Scroll down in steps
                scroll_height = scroll_attempts * 800 + 1000
                page.evaluate(f'window.scrollBy(0, {scroll_height})')
                time.sleep(1.5)  # Wait for content to load

                scroll_attempts += 1

            # Scroll back to top for consistent parsing
            page.evaluate('window.scrollTo(0, 0)')
            time.sleep(2)

            # Debug: Check page content
            page_text = page.inner_text('body')

            # Debug: Log page title and first 200 chars to verify page loaded
            try:
                page_title = page.title()
                logging.error(f"[AutoTrader] Page title: {page_title[:100]}")
            except:
                pass

            # Check for bot detection / site unavailable errors
            bot_detection_indicators = [
                'page unavailable',
                'site unavailable',
                'access denied',
                'blocked',
                'couldn\'t find the page',
                'having trouble',
                'please try again later',
                'Access to this page has been denied',
                'you don\'t have permission',
                'Incident Number:',
                'We\'re sorry for any inconvenience'
            ]
            if any(indicator.lower() in page_text.lower() for indicator in bot_detection_indicators):
                logging.error(f"[AutoTrader] BOT DETECTION / SITE UNAVAILABLE - returning empty")
                return []

            # Check for "No results found" condition
            no_results_indicators = [
                'No matching vehicles',
                'No results found',
                '0 results',
                'No cars found',
                'Try changing your search',
                'No exact matches'
            ]
            if any(indicator in page_text for indicator in no_results_indicators):
                logging.error(f"[AutoTrader] No results found - returning empty")
                return []

            # AutoTrader uses links to vehicle listings
            listings = page.query_selector_all('a[href*="/cars-for-sale/vehicle/"]')
            logging.error(f"[AutoTrader] Found {len(listings)} vehicle listing links")

            if not listings:
                logging.error("[AutoTrader] No listings found")
                return []

            # Deduplicate by vehicle ID to avoid processing same listing multiple times
            seen_vehicle_ids = set()
            unique_listings = []
            skipped_count = 0

            for listing in listings:
                url = listing.get_attribute('href') or ''
                if not url:
                    continue

                # Extract vehicle ID from URL
                clean_url = url.split('#')[0]
                vehicle_id_match = re.search(r'/vehicle/(\d+)', clean_url)
                if vehicle_id_match:
                    vehicle_id = vehicle_id_match.group(1)
                    if vehicle_id in seen_vehicle_ids:
                        skipped_count += 1
                        continue
                    seen_vehicle_ids.add(vehicle_id)
                    unique_listings.append(listing)

            logging.error(f"[AutoTrader] Deduplicated: {len(unique_listings)} unique listings (skipped {skipped_count} duplicates)")

            for i, listing in enumerate(unique_listings[:max_results]):
                try:
                    # Get the URL
                    url = listing.get_attribute('href') or ''
                    url = url.split('#')[0]
                    if not url.startswith('http'):
                        url = f"https://www.autotrader.com{url}"

                    # Get link text for title
                    link_text = listing.inner_text()
                    title = link_text.strip()

                    # Skip non-vehicle links
                    if not title or len(title) < 10 or title in ['No Accidents', 'Clean Title', ' accident']:
                        continue

                    # Get all text from parent element to find price and mileage
                    all_text = ''
                    for ancestor_level in range(1, 13):
                        try:
                            ancestor = listing.evaluate(f'el => {{ let p = el; for(let i=0; i<{ancestor_level}; i++) p = p?.parentElement; return p?.innerText; }}')
                            if ancestor and len(ancestor) > 100:
                                all_text = ancestor
                                break
                        except:
                            continue

                    # If still no text, try using JavaScript to find the closest card container
                    if not all_text or len(all_text) < 50:
                        try:
                            card_text = listing.evaluate('''
                                el => {
                                    let current = el;
                                    for (let level = 0; level < 15; level++) {
                                        if (!current || !current.parentElement) break;
                                        current = current.parentElement;
                                        const text = current.innerText || '';
                                        if (text.includes('$') && text.includes('mi') && text.length > 100) {
                                            return text;
                                        }
                                    }
                                    return '';
                                }
                            ''')
                            if card_text and len(card_text) > len(all_text):
                                all_text = card_text
                        except:
                            pass

                    # Extract price
                    price_match = re.search(r'\$\s*([\d,]+)', all_text)
                    price = 0
                    if price_match:
                        price = extract_number(price_match.group(1))
                    else:
                        price_candidates = []
                        for match in re.finditer(r'(\d{1,2},\d{3})', all_text):
                            potential_price = extract_number(match.group(1))
                            if 1900 <= potential_price <= 2100:
                                continue
                            if 5000 <= potential_price <= 500000:
                                price_candidates.append((potential_price, match.start()))
                        if not price_candidates:
                            for match in re.finditer(r'(\d{5,6})', all_text):
                                potential_price = extract_number(match.group(1))
                                if 1900 <= potential_price <= 2100:
                                    continue
                                if 5000 <= potential_price <= 500000:
                                    price_candidates.append((potential_price, match.start()))
                        if price_candidates:
                            price = price_candidates[-1][0]

                    # Extract mileage
                    mileage_match = re.search(r'(\d+)\s*mi\b', all_text, re.IGNORECASE)
                    mileage = int(mileage_match.group(1)) if mileage_match else 0

                    # Get image
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

                    # Get location/dealer info
                    location = 'AutoTrader'
                    dealer_match = re.search(r'([A-Z][a-zA-Z]+\s+(?:Buick|GMC|Ford|Toyota|Honda|Chevrolet)\s+(?:[A-Z][a-z]+)?)', all_text)
                    if dealer_match:
                        location = f"AutoTrader ({dealer_match.group(1)})"

                    # Debug: Log first few listings
                    if i < 5:
                        logging.error(f"[AutoTrader DEBUG] Listing {i}: title='{title[:50]}', price={price}, all_text_len={len(all_text)}")

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

        # Don't close the browser - let the user keep it open
        # browser.close()

    return results


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: scrape-autotrader-cdp.py <URL or search query> [max_results] [cdp_url]"}))
        print(json.dumps({"error": "Start Chrome with: chrome --remote-debugging-port=9222"}))
        sys.exit(1)

    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    cdp_url = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:9222"

    try:
        result = scrape_autotrader_cdp(query, max_results, cdp_url)

        if result is None:
            print(json.dumps({"error": "Could not connect to Chrome CDP. Make sure Chrome is running with: chrome --remote-debugging-port=9222"}))
        elif not result:
            print(json.dumps({"error": f"No AutoTrader listings found for '{query}'"}))
        else:
            print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Carvana scraper using Camoufox with interactive filter selection
Opens browser, clicks filter UI elements, then extracts results
"""
import asyncio
import json
import sys
import logging
import re
from pathlib import Path
from typing import Optional, List, Dict

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


async def scrape_carvana_interactive(
    make: Optional[str] = None,
    model: Optional[str] = None,
    series: Optional[str] = None,
    trims: Optional[List[str]] = None,
    year: Optional[int] = None,
    max_results: int = 10
):
    """
    Scrape Carvana by interacting with filter UI elements

    Args:
        make: Vehicle make (e.g., "GMC")
        model: Vehicle model (e.g., "Sierra 3500")
        series: Vehicle series (e.g., "HD")
        trims: List of trim names to filter (e.g., ["Denali", "AT4"])
        year: Model year
        max_results: Maximum number of results to return
    """
    results = []

    browser = await AsyncCamoufox(headless=False, humanize=True).__aenter__()

    try:
        page = await browser.new_page(viewport={'width': 1366, 'height': 768})

        # Resize window using JavaScript to ensure full width
        await page.evaluate("window.resizeTo(1366, 768)")
        await page.set_viewport_size({'width': 1366, 'height': 768})
        logging.error(f"[Carvana] Window and viewport resized to 1366x768")

        # Start at Carvana search page
        logging.error(f"[Carvana] Starting search")
        await page.goto("https://www.carvana.com/cars", wait_until='domcontentloaded', timeout=60000)
        await asyncio.sleep(3)

        # Step 1: Click "Make & Model" filter button to expand filters
        logging.error(f"[Carvana] Clicking Make & Model filter")
        try:
            make_model_button = None
            selectors_to_try = [
                # Primary: Use data-analytics-id attribute (most reliable)
                '[data-analytics-id="Filter Menu"][data-analytics-attributes*="Make & Model"]',
                # Fallback: Role button with exact text
                '[role="button"]:has-text("Make & Model")',
                # XPath for exact text match in div with role button
                '//div[@role="button"][contains(text(), "Make & Model")]',
                # Get by role (Playwright's accessibility API)
                'get_by_role=button:Make & Model',
            ]

            for selector in selectors_to_try:
                try:
                    if selector.startswith('get_by_role='):
                        # Special handling for get_by_role
                        role, name = selector.split('=')[1].split(':')
                        make_model_button = page.get_by_role(role, name=name, exact=True)
                        await make_model_button.click(timeout=5000)
                    elif selector.startswith('//'):
                        make_model_button = await page.wait_for_selector('xpath=' + selector, timeout=5000)
                        if make_model_button:
                            await make_model_button.click()
                    else:
                        make_model_button = await page.wait_for_selector(selector, timeout=5000)
                        if make_model_button:
                            await make_model_button.click()

                    await asyncio.sleep(1)
                    logging.error(f"[Carvana] Make & Model filter opened (selector: {selector})")
                    break
                except Exception as inner_e:
                    continue

            if not make_model_button:
                logging.error(f"[Carvana] Could not find Make & Model button with any selector")

            await asyncio.sleep(2)
        except Exception as e:
            logging.error(f"[Carvana] Error opening Make & Model filter: {e}")

        # Step 2: Click on make if provided
        if make:
            logging.error(f"[Carvana] Selecting make: {make}")
            try:
                make_clicked = False

                # Get all label elements (the clickable checkboxes)
                # Labels contain the span with text, and clicking the label clicks the checkbox
                all_labels = await page.query_selector_all('label[class*="Checkbox-module_checkbox"]')
                logging.error(f"[Carvana] Found {len(all_labels)} checkbox labels")

                for label in all_labels:
                    try:
                        # Get the span inside the label that contains the text
                        span = await label.query_selector('span[class*="Checkbox-module_label"]')
                        if span:
                            text = (await span.inner_text()).strip()
                            if text == make:
                                await label.click(timeout=5000)
                                await asyncio.sleep(2)
                                logging.error(f"[Carvana] Selected make: {make} (clicked label)")
                                make_clicked = True
                                break
                    except Exception as inner_e:
                        continue

                if not make_clicked:
                    logging.error(f"[Carvana] Could not find/click make: {make}")

            except Exception as e:
                logging.error(f"[Carvana] Error selecting make: {e}")

        # Step 3: Click on model if provided
        if model:
            # Combine model and series for search (e.g., "Sierra" + "3500HD" -> "Sierra 3500")
            search_model = model
            if series:
                # Remove "HD" from series for search (Carvana uses "3500" not "3500HD")
                series_clean = series.replace('HD', '').replace('hd', '')
                search_model = f"{model} {series_clean}"
                logging.error(f"[Carvana] Combined model + series: '{search_model}'")

            logging.error(f"[Carvana] Selecting model: {search_model}")
            try:
                # Wait for Models section to appear after make is selected
                await asyncio.sleep(1)

                model_clicked = False

                # Same approach: Get all label elements and find exact text match
                all_labels = await page.query_selector_all('label[class*="Checkbox-module_checkbox"]')
                logging.error(f"[Carvana] Found {len(all_labels)} checkbox labels for model search")

                for label in all_labels:
                    try:
                        # Get the span inside the label that contains the text
                        span = await label.query_selector('span[class*="Checkbox-module_label"]')
                        if span:
                            text = (await span.inner_text()).strip()
                            if text == search_model:
                                await label.click(timeout=5000)
                                await asyncio.sleep(2)
                                logging.error(f"[Carvana] Selected model: {search_model} (clicked label)")
                                model_clicked = True
                                break
                    except Exception as inner_e:
                        continue

                # If exact match not found, try fuzzy match
                if not model_clicked:
                    logging.error(f"[Carvana] Could not find exact model '{search_model}', trying fuzzy match...")

                    for label in all_labels:
                        try:
                            span = await label.query_selector('span[class*="Checkbox-module_label"]')
                            if span:
                                text = (await span.inner_text()).strip()
                                # Try various fuzzy matching strategies
                                model_lower = search_model.lower()
                                text_lower = text.lower()

                                # Strategy 1: Remove HD/Hd from model to find base
                                # "Sierra 3500HD" -> "Sierra 3500"
                                base_model = model_lower.replace('hd', '').replace('hd', '').replace('-', ' ').strip()
                                if base_model == text_lower or text_lower == base_model:
                                    await label.click(timeout=5000)
                                    await asyncio.sleep(2)
                                    logging.error(f"[Carvana] Selected fuzzy model match: '{text}' (for '{search_model}')")
                                    model_clicked = True
                                    break

                                # Strategy 2: Check if model is a prefix of available model
                                # "Sierra 3500" matches "Sierra 3500 Crew Cab"
                                if text_lower.startswith(model_lower + ' '):
                                    await label.click(timeout=5000)
                                    await asyncio.sleep(2)
                                    logging.error(f"[Carvana] Selected prefix model match: '{text}' (for '{search_model}')")
                                    model_clicked = True
                                    break

                                # Strategy 3: Check if available model is a prefix of requested model
                                # "Sierra 3500" matches "Sierra 3500HD"
                                if model_lower.startswith(text_lower + ' ') or model_lower.startswith(text_lower + '-'):
                                    await label.click(timeout=5000)
                                    await asyncio.sleep(2)
                                    logging.error(f"[Carvana] Selected prefix model match: '{text}' (for '{search_model}')")
                                    model_clicked = True
                                    break
                        except Exception as inner_e:
                            continue

                if not model_clicked:
                    logging.error(f"[Carvana] Could not find/click model: {search_model}")
                    # IMPORTANT: Return empty results if we can't select the correct model
                    # Otherwise we'd return all vehicles for the make (trash listings)
                    return []

            except Exception as e:
                logging.error(f"[Carvana] Error selecting model: {e}")
                return []

        # Step 4: Click Trim button and select trims if provided
        # Note: Trim button only appears after a model is selected
        if trims and len(trims) > 0:
            logging.error(f"[Carvana] Looking for Trim filter")
            await asyncio.sleep(2)  # Wait for UI to update

            try:
                # Trim button has same structure as Make & Model button
                trim_button_selectors = [
                    '[data-analytics-id="Filter Menu"][data-analytics-attributes*="Trim"]',
                    '[role="button"]:has-text("Trim")',
                ]

                trim_button_clicked = False
                for selector in trim_button_selectors:
                    try:
                        trim_button = await page.wait_for_selector(selector, timeout=5000)
                        if trim_button:
                            await trim_button.click()
                            await asyncio.sleep(2)
                            logging.error(f"[Carvana] Trim filter opened (selector: {selector})")
                            trim_button_clicked = True
                            break
                    except Exception as inner_e:
                        continue

                if trim_button_clicked:
                    # Get all label elements (the clickable checkboxes)
                    all_label_elements = await page.query_selector_all('label[class*="Checkbox-module_checkbox"]')
                    available_trims = []
                    for label in all_label_elements:
                        try:
                            # Get the span inside the label that contains the text
                            span = await label.query_selector('span[class*="Checkbox-module_label"]')
                            if span:
                                text = (await span.inner_text()).strip()
                                if text:
                                    available_trims.append({'text': text, 'element': label})  # Store label for clicking
                        except:
                            continue

                    logging.error(f"[Carvana] Found {len(available_trims)} available trim options")
                    for t in available_trims[:10]:  # Log first 10 for debugging
                        logging.error(f"[Carvana]   - '{t['text']}'")

                    # Track which trims we've clicked to avoid duplicates
                    clicked_trims = set()

                    # Try to find and click trim options with fuzzy matching
                    for trim in trims:
                        logging.error(f"[Carvana] Looking for trim: {trim}")

                        # Stage 1: Try exact match first (for specific trims like "Denali Ultimate")
                        exact_match = None
                        for available in available_trims:
                            if available['text'].lower() == trim.lower():
                                exact_match = available
                                break

                        if exact_match:
                            try:
                                await exact_match['element'].click()  # Click the label
                                clicked_trims.add(exact_match['text'])
                                await asyncio.sleep(1)
                                logging.error(f"[Carvana] Selected exact trim match: '{exact_match['text']}'")
                            except Exception as e:
                                logging.error(f"[Carvana] Error clicking exact match: {e}")
                            continue

                        # Stage 2: No exact match, try prefix/contains match (e.g., "Denali" matches "Denali 6 1/2 ft")
                        logging.error(f"[Carvana] No exact match for '{trim}', trying partial match...")
                        matched = False
                        for available in available_trims:
                            # Skip if already clicked
                            if available['text'] in clicked_trims:
                                continue

                            # Check if trim name is a prefix or appears at start of available trim
                            available_lower = available['text'].lower()
                            trim_lower = trim.lower()

                            # Prefix match: "Denali" matches "Denali 6 1/2 ft"
                            if available_lower.startswith(trim_lower + ' ') or available_lower.startswith(trim_lower + '-'):
                                try:
                                    await available['element'].click()  # Click the label
                                    clicked_trims.add(available['text'])
                                    await asyncio.sleep(1)
                                    logging.error(f"[Carvana] Selected partial trim match: '{available['text']}' (from '{trim}')")
                                    matched = True
                                except Exception as e:
                                    logging.error(f"[Carvana] Error clicking partial match: {e}")

                        if not matched:
                            logging.error(f"[Carvana] Could not find any match for trim: {trim}")

                # Click outside to close dropdown
                await page.mouse.click(100, 100)
                await asyncio.sleep(2)

            except Exception as e:
                logging.error(f"[Carvana] Error with trim selection: {e}")

        # Wait for results to load
        await asyncio.sleep(5)

        # Check for "No results found" condition
        page_text = await page.inner_text('body')
        no_results_indicators = [
            'No matching vehicles',
            'No results found',
            '0 results',
            'No cars found',
            'Try changing your search',
            'No exact matches'
        ]
        if any(indicator in page_text for indicator in no_results_indicators):
            logging.error(f"[Carvana] No results found - returning empty")
            return []

        # Extract listings
        listings = await page.query_selector_all('a[href*="/vehicle/"]')
        logging.error(f"[Carvana] Found {len(listings)} listing links")

        for i, listing in enumerate(listings[:max_results]):
            try:
                all_text = await listing.inner_text()
                url = await listing.get_attribute('href') or ''
                if url and not url.startswith('http'):
                    url = f"https://www.carvana.com{url}"

                # Extract year
                year_match = re.search(r'\b(\d{4})\b', all_text)
                found_year = year_match.group(1) if year_match else ''

                # Build title from all text
                lines = [line.strip() for line in all_text.split('\n') if line.strip()]

                title = ''
                for line in lines:
                    # Skip non-vehicle lines
                    if re.search(r'^\$\d+', line):
                        continue
                    if re.search(r'\d+k?\s*miles$', line, re.IGNORECASE):
                        continue
                    if re.search(r'^(Estimated|Get it|Free shipping|Cash down|mo|Purchase|Recent|Price Drop|Great Deal|Favorite|On hold|©|Carvana, LLC stock image|Pre-order now|Purchase in progress)', line, re.IGNORECASE):
                        continue
                    if line in ['Audi', 'BMW', 'Chevrolet', 'Ford', 'GMC', 'Honda', 'Toyota', 'Mercedes-Benz', 'Ram', 'Jeep']:
                        continue
                    if line == found_year:
                        continue
                    if len(line) > 10 and not line.startswith('$'):
                        title = line
                        break

                if not title:
                    title = f"{make or ''} {model or ''}".strip()

                # Extract price
                price_match = re.search(r'\$\s*([\d,]+)', all_text)
                price = extract_number(price_match.group(1)) if price_match else 0

                # Extract mileage
                mileage_match = re.search(r'(\d+[,\d]*)\s*k?\s*miles', all_text, re.IGNORECASE)
                mileage = 0
                if mileage_match:
                    mileage = extract_number(mileage_match.group(1))
                    if 'k' in mileage_match.group(0).lower():
                        mileage = mileage * 1000

                # Get image
                img_elem = await listing.query_selector('img')
                image = await img_elem.get_attribute('src') or '' if img_elem else ''

                if price > 0:
                    results.append({
                        'name': title,
                        'price': price,
                        'mileage': mileage,
                        'image': image,
                        'retailer': 'Carvana',
                        'url': url,
                        'location': 'Carvana'
                    })
                    logging.error(f"[Carvana] {title[:40]} - ${price:,} - {mileage:,} mi")

            except Exception as e:
                logging.error(f"[Carvana] Error extracting listing {i}: {e}")
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
        print(json.dumps({"error": "Usage: scrape-carvana-interactive.py <json_filters> [max_results]"}))
        print(json.dumps({"example": 'scrape-carvana-interactive.py \'{"make":"GMC","model":"Sierra 3500","trims":["Denali"]}\' 10'}))
        sys.exit(1)

    try:
        filters = json.loads(sys.argv[1])
        max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

        result = await scrape_carvana_interactive(
            make=filters.get('make'),
            model=filters.get('model'),
            series=filters.get('series'),
            trims=filters.get('trims'),
            year=filters.get('year'),
            max_results=max_results
        )

        if not result:
            print(json.dumps({"error": "No Carvana listings found"}))
        else:
            print(json.dumps(result, indent=2))
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON filters: {e}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())

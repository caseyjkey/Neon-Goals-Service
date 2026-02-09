#!/usr/bin/env python3
"""
Car scraping script using Camoufox (stealth Firefox)
Improved version that:
1. Uses homepage dropdowns to discover make/model entity codes dynamically
2. Builds correct makeModelTrimPaths URL format
3. Supports comprehensive filters (trim, color, drivetrain, fuel type, etc.)

Accepts structured query format (from parse_vehicle_query.py) and
converts it to CarGurus-specific parameters via the adapter function.

Entity code discoveries:
- GMC = m26, Yukon = d130, Sierra 1500 = d116, Sierra 3500HD = d973
- Format: makeModelTrimPaths=m26,m26/d130 for GMC Yukon
- Format with trim: makeModelTrimPaths=m26,m26/d973,m26/d973/Denali+Ultimate

IMPORTANT: Trim is JUST the trim name (no drivetrain suffix!)
- Correct: trim="Denali Ultimate"
- Wrong: trim="Denali Ultimate 4WD" (4WD goes in drivetrain filter!)
- Drivetrain is a separate filter: drivetrain="FOUR_WHEEL_DRIVE"
"""
import asyncio
import json
import os
import sys
import tempfile
import logging
import re
from pathlib import Path
from typing import Optional, Dict, List, Tuple

# Suppress logs to stderr
logging.basicConfig(
    level=logging.ERROR,
    format='%(message)s',
    stream=sys.stderr
)

from camoufox.async_api import AsyncCamoufox
from browserforge.fingerprints import Screen
from dotenv import load_dotenv

# Load environment variables
env_path = Path(__file__).parent.parent / '.env'
load_dotenv(env_path)


# Filter parameter mapping for URL construction
FILTER_PARAM_MAPPING = {
    'yearMin': 'startYear',              # CarGurus uses 'startYear' not 'yearMin'
    'yearMax': 'endYear',                # CarGurus uses 'endYear' not 'yearMax'
    'minPrice': 'minPrice',
    'maxPrice': 'maxPrice',
    'exteriorColor': 'colors',           # CarGurus uses 'colors' not 'exteriorColor'
    'interiorColor': 'interiorColor',
    'drivetrain': 'drivetrain',
    'fuelType': 'fuelType',
    'transmission': 'transmission',
    'mileageMax': 'mileageMax'
}


def adapt_structured_to_cargurus(structured: dict) -> dict:
    """
    Convert structured query format to CarGurus-specific parameters.

    Supports two formats:
    1. New retailer-specific format from LLM: {url_params: {make, model, trim, ...}, path_components: {}}
    2. Legacy generic format: {makes: [], models: [], trims: [], ...}

    CarGurus specifics:
    - Uses entity codes for makes/models (discovered dynamically)
    - Requires makeModelTrimPaths format
    - Parameter names differ (startYear vs yearMin, etc.)
    - Only supports single make/model per search

    Args:
        structured: The structured query dict (either format)

    Returns:
        CarGurus-specific parameter dict for scrape_cars()
    """
    params = {}

    # Check for new retailer-specific format from LLM
    url_params = structured.get('url_params', {})

    if url_params:
        # New LLM format - extract directly from url_params
        if url_params.get('make'):
            params['make'] = url_params['make']
        if url_params.get('model'):
            params['model'] = url_params['model']
        if url_params.get('trim'):
            # Trim may be a list from LLM, extract first element
            trim_val = url_params['trim']
            if isinstance(trim_val, list):
                params['trim'] = trim_val[0] if trim_val else ''
            else:
                params['trim'] = trim_val
        if url_params.get('drivetrain'):
            params['drivetrain'] = url_params['drivetrain']
        if url_params.get('fuelType'):
            params['fuelType'] = url_params['fuelType']
        if url_params.get('exteriorColor'):
            params['exteriorColor'] = url_params['exteriorColor']
        if url_params.get('yearMin'):
            params['yearMin'] = url_params['yearMin']
        if url_params.get('yearMax'):
            params['yearMax'] = url_params['yearMax']
        if url_params.get('year'):
            params['yearMin'] = url_params['year']
        if url_params.get('minPrice') is not None:
            params['minPrice'] = url_params['minPrice']
        if url_params.get('maxPrice') is not None:
            params['maxPrice'] = url_params['maxPrice']
    else:
        # Legacy generic format - convert from old structure
        # CarGurus only supports single make/model (take first if multiple)
        makes = structured.get('makes', [])
        models = structured.get('models', [])

        if makes:
            params['make'] = makes[0]
        if models:
            params['model'] = models[0]

        # Trim (single value for CarGurus)
        if structured.get('trims'):
            params['trim'] = structured['trims'][0]

        # Drivetrain (CarGurus uses specific codes)
        if structured.get('drivetrain'):
            dt = structured['drivetrain']
            # Convert to CarGurus format
            drivetrain_map = {
                'Four Wheel Drive': 'FOUR_WHEEL_DRIVE',
                'All Wheel Drive': 'ALL_WHEEL_DRIVE',
                'Rear Wheel Drive': 'REAR_WHEEL_DRIVE',
                'Front Wheel Drive': 'FRONT_WHEEL_DRIVE'
            }
            params['drivetrain'] = drivetrain_map.get(dt, dt.upper().replace(' ', '_'))

        # Fuel type
        if structured.get('fuelType'):
            ft = structured['fuelType']
            fuel_map = {
                'Gas': 'GASOLINE',
                'Electric': 'ELECTRIC',
                'Hybrid': 'HYBRID',
                'Plug-In Hybrid': 'PLUG_IN_HYBRID',
                'Diesel': 'DIESEL'
            }
            params['fuelType'] = fuel_map.get(ft, ft.upper())

        # Color (CarGurus uses 'colors' parameter)
        if structured.get('exteriorColor'):
            params['exteriorColor'] = structured['exteriorColor']

        # Year range
        if structured.get('yearMin'):
            params['yearMin'] = structured['yearMin']
        elif structured.get('year'):
            params['yearMin'] = structured['year']

        if structured.get('yearMax'):
            params['yearMax'] = structured['yearMax']

        # Price range
        if structured.get('minPrice') is not None:
            params['minPrice'] = structured['minPrice']
        if structured.get('maxPrice') is not None:
            params['maxPrice'] = structured['maxPrice']

    # Location (required for CarGurus) - use from either format
    location = structured.get('location', {})
    params['zip'] = location.get('zip') or '94002'  # Default zip
    params['distance'] = location.get('distance') or 200  # Default distance

    return params


def extract_number(text: str) -> int:
    """Extract number from text like '$20,000' or '20,000 mi'"""
    if not text:
        return 0
    cleaned = re.sub(r'[^\d,.]', '', text)
    cleaned = cleaned.replace(',', '')
    try:
        return int(float(cleaned))
    except (ValueError, AttributeError):
        return 0


async def discover_make_and_model_codes(page, make: str, model: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Discover make and model entity codes by interacting with homepage dropdowns.

    Returns:
        Tuple of (make_code, model_code) or (None, None) if not found
    """
    make_code = None
    model_code = None

    try:
        # Try multiple selectors for the make dropdown
        make_selectors = [
            '[aria-label="Select Make"]',
            'select[name="make"]',
            '#make',
            '.make-select',
            'select[data-test="make-select"]',
        ]

        make_dropdown = None
        for selector in make_selectors:
            try:
                make_dropdown = await page.wait_for_selector(selector, timeout=15000)  # Increased from 5000
                if make_dropdown:
                    logging.error(f"Found make dropdown with selector: {selector}")
                    break
            except:
                continue

        if not make_dropdown:
            logging.error(f"Could not find make dropdown with any selector")
            # Take screenshot for debugging
            try:
                await page.screenshot(path='/tmp/cargurus-no-dropdown.png')
                logging.error("Screenshot saved to /tmp/cargurus-no-dropdown.png")
            except:
                pass
            return None, None

        # Get all make options
        makes = await page.evaluate('''() => {
            // Try multiple selectors
            const selectors = [
                '[aria-label="Select Make"]',
                'select[name="make"]',
                '#make',
                '.make-select',
                'select[data-test="make-select"]',
            ];
            for (const sel of selectors) {
                const dropdown = document.querySelector(sel);
                if (dropdown && dropdown.options) {
                    return Array.from(dropdown.options).map(opt => ({
                        name: opt.textContent.trim(),
                        value: opt.value
                    })).filter(m => m.value !== "");
                }
            }
            return [];
        }''')

        logging.error(f"Found {len(makes)} makes on CarGurus")

        # Find the make code (case-insensitive match)
        make_lower = make.lower()
        for m in makes:
            if m['name'].lower() == make_lower:
                make_code = m['value']
                logging.error(f"Found make: {m['name']} = {make_code}")
                break

        if not make_code:
            logging.error(f"Make '{make}' not found. Available: {[m['name'] for m in makes[:10]]}")
            return None, None

        # Select the make using the same selector strategy
        selected = False
        for selector in make_selectors:
            try:
                await page.select_option(selector, make_code, timeout=5000)
                selected = True
                logging.error(f"Selected make using selector: {selector}")
                break
            except:
                continue

        if not selected:
            logging.error(f"Could not select make")
            return None, None

        await asyncio.sleep(2)  # Wait for models to populate

        # Get all model options for this make
        models = await page.evaluate('''() => {
            const selectors = [
                '[aria-label="Select Model"]',
                'select[name="model"]',
                '#model',
                '.model-select',
                'select[data-test="model-select"]',
            ];
            for (const sel of selectors) {
                const dropdown = document.querySelector(sel);
                if (dropdown && dropdown.options) {
                    return Array.from(dropdown.options).map(opt => ({
                        name: opt.textContent.trim(),
                        value: opt.value
                    })).filter(m => m.value !== "");
                }
            }
            return [];
        }''')

        logging.error(f"Found {len(models)} models for {make}")

        # Find the model code (case-insensitive, partial match)
        model_lower = model.lower()
        for m in models:
            if model_lower in m['name'].lower():
                model_code = m['value']
                logging.error(f"Found model: {m['name']} = {model_code}")
                break

        if not model_code:
            logging.error(f"Model '{model}' not found. Available: {[m['name'] for m in models[:10]]}")
            return None, None

    except Exception as e:
        logging.error(f"Error discovering make/model codes: {e}")
        import traceback
        traceback.print_exc()
        try:
            await page.screenshot(path='/tmp/cargurus-error.png')
            logging.error("Screenshot saved to /tmp/cargurus-error.png")
        except:
            pass
        return None, None

    return make_code, model_code


async def apply_filters_via_ui(page, filters: Dict) -> None:
    """
    Apply additional filters by clicking on sidebar filter accordions.

    This is used for filters that don't have simple URL parameters.
    """
    # Trim filter - uses special format in makeModelTrimPaths
    # Would need to be added as: makeModelTrimPaths=m26,m26/d130,m26/d130/Denali+4WD
    # This is handled in URL building, not here

    # For other filters, we could click the accordions and select options
    # Example for color, drivetrain, etc.
    pass


def build_search_url(
    make_code: str,
    model_code: str,
    zip_code: str,
    distance: int,
    trim: Optional[str] = None,
    **other_filters
) -> str:
    """
    Build the CarGurus search URL with correct makeModelTrimPaths format.

    Args:
        make_code: Entity code for make (e.g., 'm26' for GMC)
        model_code: Entity code for model (e.g., 'd130' for Yukon)
        zip_code: ZIP code for search
        distance: Search radius in miles
        trim: Optional trim name (e.g., 'Denali 4WD')
        **other_filters: Additional filter parameters

    Returns:
        Complete search URL
    """
    base_url = "https://www.cargurus.com/search"

    # Build makeModelTrimPaths
    # Correct format: makeModelTrimPaths={make},{make}/{model}/{trim},{make}/{model}
    # Note: trim path comes BEFORE model path again at the end
    if trim:
        # URL encode the trim name (spaces become + or %20)
        trim_encoded = trim.replace(' ', '+')
        makeModelTrimPaths = f"{make_code},{make_code}/{model_code}/{trim_encoded},{make_code}/{model_code}"
    else:
        makeModelTrimPaths = f"{make_code},{make_code}/{model_code}"

    # Build URL parameters
    params = {
        'zip': zip_code,
        'distance': str(distance),
        'makeModelTrimPaths': makeModelTrimPaths,
        'sourceContext': 'carGurusHomePageModel'
    }

    # Add other filters using the parameter mapping
    for key, url_param in FILTER_PARAM_MAPPING.items():
        if key in other_filters and other_filters[key]:
            value = str(other_filters[key])
            # Convert color values to UPPERCASE for CarGurus
            if url_param == 'colors' or url_param == 'interiorColor':
                value = value.upper()
            params[url_param] = value

    # Build query string
    query_parts = []
    for k, v in params.items():
        # URL encode the value (especially for colors like "BLACK" and trim with spaces)
        import urllib.parse
        if v:
            query_parts.append(f"{k}={urllib.parse.quote_plus(str(v))}")
    return f"{base_url}?{'&'.join(query_parts)}"


async def scrape_cars(search_filters: dict, max_results: int = 10):
    """Scrape car listings from CarGurus using Camoufox

    Args:
        search_filters: Dict with make, model, zip, trim, etc.
        max_results: Maximum number of results to return

    Supported filters:
        - make: Make name (e.g., 'GMC')
        - model: Model name (e.g., 'Yukon')
        - zip: ZIP code (default: '94002')
        - distance: Search radius in miles (default: 200)
        - trim: Trim name ONLY, no drivetrain suffix (e.g., 'Denali Ultimate', 'SLE', 'SLT', 'AT4')
        - yearMin/yearMax: Year range
        - minPrice/maxPrice: Price range
        - exteriorColor/interiorColor: Color codes (BLACK, WHITE, GRAY, etc.)
        - drivetrain: FOUR_WHEEL_DRIVE, ALL_WHEEL_DRIVE, FOUR_BY_TWO (separate from trim!)
        - fuelType: GASOLINE, DIESEL, FLEX_FUEL_VEHICLE, etc.
        - transmission: AUTOMATIC, MANUAL
        - mileageMax: Maximum mileage
    """
    results = []
    browser = None

    # Extract filters with defaults
    make = search_filters.get('make', '')
    model = search_filters.get('model', '')
    zip_code = search_filters.get('zip', '94002')
    distance = search_filters.get('distance', 200)
    # Trim may be a list from LLM, extract first element
    trim_val = search_filters.get('trim', '')
    if isinstance(trim_val, list):
        trim = trim_val[0] if trim_val else ''
    else:
        trim = trim_val

    try:
        # Launch Camoufox in headed mode with full xvfb resolution
        # Use RAM-based profile for faster startup and cleanup
        logging.error(f"Launching Camoufox for: {make} {model}")
        logging.error("Display: {}".format(os.environ.get('DISPLAY', 'not set')))
        browser = await AsyncCamoufox(
            screen=Screen(max_width=1920, max_height=1080),  # Match xvfb resolution
            headless=False,  # Use headed mode with xvfb
            humanize=True,
        ).__aenter__()

        page = await browser.new_page(viewport={'width': 1920, 'height': 1080})
        logging.error("Browser launched, navigating to CarGurus homepage")
        logging.error("Viewport set to 1920x1080")

        # STEP 1: Try to discover make and model entity codes from homepage
        # If that fails, use a direct text search URL instead

        # First, try visiting homepage to discover entity codes
        await page.goto("https://www.cargurus.com", wait_until='domcontentloaded', timeout=90000)
        await asyncio.sleep(15)  # Give CarGurus more time to fully load (was 5s)

        # Take screenshot for debugging
        try:
            await page.screenshot(path='/tmp/cargurus-homepage.png')
            logging.error("Homepage screenshot saved")
        except:
            pass

        # STEP 2: Try to discover make and model entity codes
        make_code = None
        model_code = None

        if make and model:
            make_code, model_code = await discover_make_and_model_codes(page, make, model)

        # If dropdown discovery failed, use search box approach
        if not make_code or not model_code:
            logging.error(f"Could not discover entity codes, trying search box approach")

            try:
                # Look for search input box on the homepage
                search_selectors = [
                    'input[name="searchQuery"]',
                    'input[placeholder*="search" i]',
                    'input[type="search"]',
                    '#search-input',
                    '[data-test="search-input"]',
                ]

                search_input = None
                for selector in search_selectors:
                    try:
                        search_input = await page.wait_for_selector(selector, timeout=15000)  # Increased from 5000
                        if search_input:
                            logging.error(f"Found search input with selector: {selector}")
                            break
                    except:
                        continue

                if not search_input:
                    logging.error("Could not find search input on homepage - likely bot detection")
                    await page.screenshot(path='/tmp/cargurus-no-search.png')
                    return None  # Signal bot detection to worker for VPN retry

                # Enter search query
                search_query = f"{make} {model}"
                await search_input.fill(search_query)
                logging.error(f"Entered search query: {search_query}")
                await asyncio.sleep(1)

                # Submit search (press Enter)
                await search_input.press('Enter')
                logging.error("Submitted search")
                await asyncio.sleep(10)

                # Take screenshot of search results
                await page.screenshot(path='/tmp/cargurus-search-results.png')
                logging.error("Search results screenshot saved")

                # Scroll to bottom to trigger lazy-loading of images
                logging.error("Scrolling to load all images...")
                try:
                    # Scroll to bottom in increments
                    for _ in range(5):
                        await page.evaluate('window.scrollBy(0, window.innerHeight)')
                        await asyncio.sleep(0.5)
                    # Scroll back to top
                    await page.evaluate('window.scrollTo(0, 0)')
                    await asyncio.sleep(2)
                    logging.error("Scrolling complete, images should be loaded")
                except Exception as e:
                    logging.error(f"Scrolling failed: {e}")

                # Check for access restriction
                page_text = await page.inner_text('body')
                if any(indicator in page_text.lower() for indicator in ['access is temporarily restricted', 'bot detection', 'please verify you are human']):
                    logging.error("Bot detection detected - returning None for VPN retry")
                    return None  # Signal bot detection to worker for VPN retry

                # Check for no results
                if any(indicator in page_text for indicator in ['No matching vehicles', 'No results found', '0 results']):
                    logging.error("[CarGurus] No results found")
                    return []

                # Try to find listings
                selectors = [
                    'a[href*="/details/"]',
                    '[data-testid="listing-card"]',
                    'article',
                    '[class*="listing"]',
                ]

                listings = []
                for selector in selectors:
                    listings = await page.query_selector_all(selector)
                    if listings:
                        logging.error(f"Found {len(listings)} potential listings with selector: {selector}")
                        break

                # Extract data from listings
                for i, listing in enumerate(listings[:max_results]):
                    try:
                        all_text = await listing.inner_text()
                        name = f"{make} {model}"
                        name_elem = await listing.query_selector('h4, h3, h2')
                        if name_elem:
                            name = await name_elem.inner_text()

                        price = 0
                        price_match = re.search(r'\$[\d,]+', all_text)
                        if price_match:
                            price = extract_number(price_match.group())

                        mileage = 0
                        mileage_match = re.search(r'([\d,]+)\s*(?:mi|miles)', all_text, re.IGNORECASE)
                        if mileage_match:
                            mileage = extract_number(mileage_match.group(1))

                        image = ''
                        # Try img tag first, then fallback to image tag
                        img_elem = await listing.query_selector('img')
                        if img_elem:
                            image = await img_elem.get_attribute('src') or ''
                        else:
                            # Some listings use <image> instead of <img>
                            image_elem = await listing.query_selector('image')
                            if image_elem:
                                image = await image_elem.get_attribute('src') or ''

                        url = ''
                        tag_name = await listing.evaluate('el => el.tagName')
                        if tag_name == 'A':
                            url = await listing.get_attribute('href') or ''
                        else:
                            link_elem = await listing.query_selector('a[href*="/details/"]')
                            if link_elem:
                                url = await link_elem.get_attribute('href') or ''

                        if url and not url.startswith('http'):
                            url = f"https://www.cargurus.com{url}"

                        location = 'Unknown'
                        location_match = re.search(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})', all_text)
                        if location_match:
                            location = f"{location_match.group(1)}, {location_match.group(2)}"

                        if price > 0 or mileage > 0:
                            results.append({
                                'name': name.strip(),
                                'price': price,
                                'mileage': mileage,
                                'trim': '',
                                'image': image,
                                'retailer': 'CarGurus',
                                'url': url,
                                'location': location
                            })
                            logging.error(f"Extracted: {name[:40]} - ${price} - {mileage} mi")
                    except Exception as e:
                        logging.error(f"Error extracting listing {i}: {e}")
                        continue

                if results:
                    logging.error(f"Successfully extracted {len(results)} listings using search box")
                    return results
                else:
                    logging.error("No listings extracted using search box")
                    return [{"error": f"No listings found for {make} {model}"}]

            except Exception as e:
                logging.error(f"Error using search box approach: {e}")
                import traceback
                traceback.print_exc()
                return [{"error": f"Search box approach failed: {str(e)}"}]

        # STEP 3: Build search URL with correct format (original entity code path)
        other_filters = {k: v for k, v in search_filters.items()
                        if k not in ['make', 'model', 'zip', 'distance', 'trim']}

        search_url = build_search_url(
            make_code=make_code,
            model_code=model_code,
            zip_code=zip_code,
            distance=distance,
            trim=trim,
            **other_filters
        )

        logging.error(f"Navigating to: {search_url}")
        await page.goto(search_url, wait_until='domcontentloaded', timeout=60000)

        # Wait for results page to load
        logging.error("Results page loading, waiting for content...")
        await asyncio.sleep(10)

        try:
            await page.wait_for_load_state('networkidle', timeout=10000)
        except:
            pass

        # Check for access restriction
        page_text = await page.inner_text('body')
        restricted_indicators = [
            'access is temporarily restricted',
            'Access restricted',
            'suspicious activity',
            'bot detection',
            'please verify you are human'
        ]
        if any(indicator in page_text.lower() for indicator in restricted_indicators):
            logging.error("[CarGurus] Access restricted by bot detection! - returning None for VPN retry")
            try:
                await page.screenshot(path='/tmp/cargurus-restricted.png')
            except:
                pass
            return None  # Signal bot detection to worker for VPN retry

        # Check for no results
        no_results_indicators = [
            'No matching vehicles',
            'No results found',
            '0 results',
            'Try changing your search'
        ]
        if any(indicator in page_text for indicator in no_results_indicators):
            logging.error("[CarGurus] No results found")
            return []

        # Try multiple selectors for listings
        selectors = [
            'a[href*="/details/"]',  # CarGurus links to car details
            '[data-testid="listing-card"]',
            'article',
            '[class*="listing"]',
        ]

        listings = []
        for selector in selectors:
            listings = await page.query_selector_all(selector)
            if listings:
                logging.error(f"Found {len(listings)} potential listings with selector: {selector}")
                break

        if not listings:
            logging.error("No listings found with any selector")
            # Take screenshot for debugging
            try:
                await page.screenshot(path='/tmp/cargurus-debug.png')
            except:
                pass

        # Scroll to bottom to trigger lazy-loading of images
        logging.error("Scrolling to load all images...")
        try:
            # Scroll to bottom in increments
            for _ in range(5):
                await page.evaluate('window.scrollBy(0, window.innerHeight)')
                await asyncio.sleep(0.5)
            # Scroll back to top
            await page.evaluate('window.scrollTo(0, 0)')
            await asyncio.sleep(2)
            logging.error("Scrolling complete, images should be loaded")
        except Exception as e:
            logging.error(f"Scrolling failed: {e}")

        # Extract data from listings
        for i, listing in enumerate(listings[:max_results]):
            try:
                # Get all text
                all_text = await listing.inner_text()

                # Extract name from heading or use search criteria
                name = f"{make} {model}"
                name_elem = await listing.query_selector('h4, h3, h2')
                if name_elem:
                    name = await name_elem.inner_text()

                # Extract price
                price = 0
                price_match = re.search(r'\$[\d,]+', all_text)
                if price_match:
                    price = extract_number(price_match.group())

                # Extract mileage
                mileage = 0
                mileage_match = re.search(r'([\d,]+)\s*(?:mi|miles)', all_text, re.IGNORECASE)
                if mileage_match:
                    mileage = extract_number(mileage_match.group(1))

                # Extract image
                image = ''
                # Try img tag first, then fallback to image tag
                img_elem = await listing.query_selector('img')
                if img_elem:
                    image = await img_elem.get_attribute('src') or ''
                else:
                    # Some listings use <image> instead of <img>
                    image_elem = await listing.query_selector('image')
                    if image_elem:
                        image = await image_elem.get_attribute('src') or ''

                # Extract URL
                url = ''
                tag_name = await listing.evaluate('el => el.tagName')
                if tag_name == 'A':
                    url = await listing.get_attribute('href') or ''
                else:
                    link_elem = await listing.query_selector('a[href*="/details/"]')
                    if link_elem:
                        url = await link_elem.get_attribute('href') or ''

                if url and not url.startswith('http'):
                    url = f"https://www.cargurus.com{url}"

                # Extract location
                location = 'Unknown'
                location_match = re.search(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})', all_text)
                if location_match:
                    location = f"{location_match.group(1)}, {location_match.group(2)}"

                # Extract trim from text if available
                trim_found = ''
                trim_match = re.search(r'(Denali|SLE|SLT|AT4|Elevation)\s*\w*', all_text)
                if trim_match:
                    trim_found = trim_match.group(1)

                if price > 0 or mileage > 0:
                    results.append({
                        'name': name.strip(),
                        'price': price,
                        'mileage': mileage,
                        'trim': trim_found,
                        'image': image,
                        'retailer': 'CarGurus',
                        'url': url,
                        'location': location
                    })
                    logging.error(f"Extracted: {name[:40]} - ${price} - {mileage} mi")

            except Exception as e:
                logging.error(f"Error extracting listing {i}: {e}")
                continue

    except Exception as e:
        logging.error(f"Scraping error: {e}")
        import traceback
        traceback.print_exc()

    finally:
        logging.error("Scraping complete, waiting 60 seconds before closing...")
        await asyncio.sleep(10)

        if browser:
            try:
                await browser.close()
            except:
                pass

    return results


async def main():
    """Main entry point"""
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: scrape-cars-camoufox.py <JSON filters or structured> [max_results]",
            "examples": [
                '{"make": "GMC", "model": "Yukon", "zip": "94002", "trim": "Denali Ultimate"}',
                '{"structured": {"makes": ["GMC"], "models": ["Sierra"]}}'  # From parse_vehicle_query.py"
            ]
        }))
        sys.exit(1)

    arg = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    try:
        filters = json.loads(arg) if isinstance(arg, str) else arg

        # Check if this is a structured format from parse_vehicle_query.py
        if 'structured' in filters:
            # Use adapter to convert structured to CarGurus params
            filters = adapt_structured_to_cargurus(filters['structured'])

        # Handle LLM search_query format: {"search_query": "GMC Sierra 3500HD Denali Ultimate", "years": "2023-2024", ...}
        if 'search_query' in filters and 'make' not in filters:
            sq = filters['search_query']
            parts = sq.split()
            # Known trim keywords to split model from trim
            trim_keywords = {'Denali', 'AT4', 'SLE', 'SLT', 'Elevation', 'Pro', 'Base', 'Limited', 'Platinum', 'Canyon'}
            if parts:
                filters['make'] = parts[0]
                model_parts = []
                trim_parts = []
                for part in parts[1:]:
                    if part in trim_keywords or trim_parts:
                        trim_parts.append(part)
                    else:
                        model_parts.append(part)
                if model_parts:
                    filters['model'] = ' '.join(model_parts)
                if trim_parts:
                    filters['trim'] = ' '.join(trim_parts)
            logging.error(f"Parsed search_query: make={filters.get('make')}, model={filters.get('model')}, trim={filters.get('trim')}")

        # Convert "years" format "2023-2024" to yearMin/yearMax
        if 'years' in filters and 'yearMin' not in filters:
            years_str = str(filters.pop('years'))
            if '-' in years_str:
                year_parts = years_str.split('-')
                filters['yearMin'] = int(year_parts[0])
                filters['yearMax'] = int(year_parts[1])

        # Convert string values to int where needed
        if 'distance' in filters:
            filters['distance'] = int(filters['distance'])
        if 'maxPrice' in filters:
            filters['maxPrice'] = int(filters['maxPrice'])
        if 'minPrice' in filters:
            filters['minPrice'] = int(filters['minPrice'])

        result = await scrape_cars(filters, max_results)

        # Handle different return types
        # - None: bot detection (worker will retry with VPN)
        # - []: no results found (valid empty response)
        # - list with items: success
        if result is None:
            print(json.dumps({"error": "Bot detection - retry with VPN"}))
            sys.stdout.flush()
            sys.exit(1)
        elif not result or (isinstance(result, list) and len(result) == 0):
            # No results - return empty list (NOT an error)
            print("[]")
            sys.stdout.flush()
        else:
            # Success - return listings
            output = json.dumps(result, indent=2)
            print(output)
            sys.stdout.flush()
            # Also write to temp file as backup
            with open(f"/tmp/scraper_output_{os.getpid()}.json", "w") as f:
                f.write(output)
                f.flush()
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON filters"}))
        sys.stdout.flush()
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.stdout.flush()
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())

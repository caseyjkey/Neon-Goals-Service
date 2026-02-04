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
import sys
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

    The structured format is the universal format output by parse_vehicle_query.py.
    Each scraper has its own adapter to convert this to scraper-specific params.

    CarGurus specifics:
    - Uses entity codes for makes/models (discovered dynamically)
    - Requires makeModelTrimPaths format
    - Parameter names differ (startYear vs yearMin, etc.)
    - Only supports single make/model per search

    Args:
        structured: The structured query dict with keys like makes, models, trims, etc.

    Returns:
        CarGurus-specific parameter dict for scrape_cars()
    """
    params = {}

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

    # Location (required for CarGurus)
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
        # Wait for make dropdown to be available
        await page.wait_for_selector('[aria-label="Select Make"]', timeout=10000)

        # Get all make options
        makes = await page.evaluate('''() => {
            const dropdown = document.querySelector('[aria-label="Select Make"]');
            if (!dropdown) return [];
            return Array.from(dropdown.options).map(opt => ({
                name: opt.textContent.trim(),
                value: opt.value
            })).filter(m => m.value !== "");
        }''')

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

        # Select the make
        await page.select_option('[aria-label="Select Make"]', make_code)
        await asyncio.sleep(1)  # Wait for models to populate

        # Get all model options for this make
        models = await page.evaluate('''() => {
            const dropdown = document.querySelector('[aria-label="Select Model"]');
            if (!dropdown) return [];
            return Array.from(dropdown.options).map(opt => ({
                name: opt.textContent.trim(),
                value: opt.value
            })).filter(m => m.value !== "");
        }''')

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
            params[url_param] = str(other_filters[key])

    # Build query string
    query_parts = [f"{k}={v}" for k, v in params.items()]
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
    trim = search_filters.get('trim', '')

    try:
        # Launch Camoufox - headless=False to avoid crashes
        logging.error(f"Launching Camoufox for: {make} {model}")
        browser = await AsyncCamoufox(
            headless=False,
            humanize=True,
        ).__aenter__()

        page = await browser.new_page()
        logging.error("Browser launched, navigating to CarGurus homepage")

        # STEP 1: Visit homepage to discover entity codes
        await page.goto("https://www.cargurus.com", wait_until='domcontentloaded', timeout=30000)
        await asyncio.sleep(2)

        # STEP 2: Discover make and model entity codes
        if make and model:
            make_code, model_code = await discover_make_and_model_codes(page, make, model)
            if not make_code or not model_code:
                return [{"error": f"Could not find entity codes for {make} {model}"}]
        else:
            return [{"error": "Make and model are required"}]

        # STEP 3: Build search URL with correct format
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
        await page.goto(search_url, wait_until='domcontentloaded', timeout=30000)

        # Wait for results page to load
        logging.error("Results page loading, waiting for content...")
        await asyncio.sleep(5)

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
            logging.error("[CarGurus] Access restricted by bot detection!")
            try:
                await page.screenshot(path='/tmp/cargurus-restricted.png')
            except:
                pass
            return [{"error": "Access restricted - bot detection"}]

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
                img_elem = await listing.query_selector('img')
                if img_elem:
                    image = await img_elem.get_attribute('src') or ''

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
        await asyncio.sleep(60)

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

        result = await scrape_cars(filters, max_results)

        if not result:
            print(json.dumps({"error": f"No car listings found for {filters}"}))
        else:
            print(json.dumps(result, indent=2))
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON filters"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())

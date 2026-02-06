#!/usr/bin/env python3
"""
CarMax scraper using Camoufox (VISIBLE MODE - headless doesn't work)
Supports multiple makes/models and structured URL building with filter catalog

Accepts structured query format (from parse_vehicle_query.py) and
converts it to CarMax-specific parameters via the adapter function.
"""
import asyncio
import json
import os
import sys
import tempfile
import logging
import re
from pathlib import Path
from typing import List, Dict, Optional

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)

from camoufox.async_api import AsyncCamoufox
from dotenv import load_dotenv

# Import model name mappings
from model_mappings import normalize_models_for_site

env_path = Path(__file__).parent.parent / '.env'
load_dotenv(env_path)

# Filter catalog path
FILTER_CATALOG_PATH = Path(__file__).parent / 'data' / 'carmax-filters.json'

# Cache for filter catalog
_filter_catalog = None


def adapt_structured_to_carmax(structured: dict) -> dict:
    """
    Convert structured query format to CarMax-specific parameters.

    The structured format is the universal format output by parse_vehicle_query.py.
    Each scraper has its own adapter to convert this to scraper-specific params.

    Args:
        structured: The structured query dict with keys like makes, models, trims, etc.

    Returns:
        CarMax-specific parameter dict compatible with build_carmax_url()
    """
    params = {}

    # Make/Model pairs (CarMax supports multiple)
    makes = structured.get('makes', [])
    models = structured.get('models', [])
    if makes and models:
        # Normalize model names for CarMax (e.g., Sierra 3500HD -> Sierra 3500)
        models = normalize_models_for_site(models, 'carmax')
        # Ensure equal length - zip to pairs
        min_len = min(len(makes), len(models))
        params['makes'] = makes[:min_len]
        params['models'] = models[:min_len]

    # Trims (make/model specific)
    if structured.get('trims'):
        params['trims'] = structured['trims']

    # Colors (exterior or interior - CarMax treats both as colors)
    colors = []
    if structured.get('exteriorColor'):
        colors.append(structured['exteriorColor'])
    if structured.get('interiorColor'):
        colors.append(structured['interiorColor'])
    if colors:
        params['colors'] = colors

    # Body type (global filter)
    if structured.get('bodyType'):
        params['body_type'] = structured['bodyType']

    # Fuel type (global filter)
    if structured.get('fuelType'):
        params['fuel_type'] = structured['fuelType']

    # Drivetrain (global filter)
    if structured.get('drivetrain'):
        params['drivetrain'] = structured['drivetrain']

    # Transmission
    if structured.get('transmission'):
        params['transmission'] = structured['transmission']

    # Car size
    if structured.get('carSize'):
        params['car_size'] = structured['carSize']

    # Doors
    if structured.get('doors'):
        params['doors'] = structured['doors']

    # Cylinders
    if structured.get('cylinders'):
        params['cylinders'] = structured['cylinders']

    # Features (array - CarMax supports chaining)
    if structured.get('features'):
        params['features'] = structured['features']

    # Price range
    if structured.get('minPrice') is not None:
        params['min_price'] = structured['minPrice']
    if structured.get('maxPrice') is not None:
        params['max_price'] = structured['maxPrice']

    # Year handling - CarMax doesn't have year filters in URL,
    # but we can note it for post-filtering results
    # (not implemented here)

    return params


def load_filter_catalog() -> dict:
    """Load the CarMax filter catalog."""
    global _filter_catalog
    if _filter_catalog is not None:
        return _filter_catalog

    if FILTER_CATALOG_PATH.exists():
        with open(FILTER_CATALOG_PATH, 'r') as f:
            _filter_catalog = json.load(f)
        return _filter_catalog

    # Return empty catalog if file doesn't exist
    _filter_catalog = {'filters': {}}
    return _filter_catalog


def get_filters_for_model(make: str, model: str) -> dict:
    """Get available filters for a specific make/model."""
    catalog = load_filter_catalog()
    make = make.lower().replace(' ', '-').replace('land-rover', 'land-rover')
    model = model.lower().replace(' ', '-')

    return catalog.get('filters', {}).get(make, {}).get(model, {
        'trims': [],
        'colors': [],
        'drivetrains': [],
        'features': [],
        'fuel_types': []
    })


def slugify(value: str) -> str:
    """Convert a value to URL-friendly slug format."""
    return value.lower().replace(' ', '-').replace('_', '-')


def get_global_filters() -> dict:
    """Get global filter options (agnostic of make/model)."""
    catalog = load_filter_catalog()
    return catalog.get('global_filters', {
        'body_types': [], 'fuel_types': [], 'drivetrains': [],
        'transmissions': [], 'exterior_colors': [], 'interior_colors': [],
        'car_sizes': [], 'doors': [], 'cylinders': [], 'features': []
    })


def build_carmax_url(
    makes: Optional[List[str]] = None,
    models: Optional[List[str]] = None,
    trims: Optional[List[str]] = None,
    colors: Optional[List[str]] = None,
    body_type: Optional[str] = None,
    fuel_type: Optional[str] = None,
    drivetrain: Optional[str] = None,
    transmission: Optional[str] = None,
    car_size: Optional[str] = None,
    doors: Optional[str] = None,
    cylinders: Optional[str] = None,
    features: Optional[List[str]] = None,
    min_price: Optional[int] = None,
    max_price: Optional[int] = None,
    show_reserved: bool = False
) -> str:
    """
    Build a CarMax URL with multiple makes/models and global filters.

    CarMax URL format (filters can be chained in any order):
    /cars/{make}/{model}/{body_type}/{fuel_type}/{feature}/{trim}/{color}?price={min}-{max}&showreservedcars={true|false}

    Examples:
    - Single make/model: /cars/gmc/sierra-3500?showreservedcars=false
    - Multiple makes: /cars/gmc/sierra-3500/ford/f-150?showreservedcars=false
    - With body type: /cars/suv?showreservedcars=false
    - With features: /cars/gmc/sierra-3500/seat-massagers/sunroof?showreservedcars=false
    - Complex: /cars/gmc/sierra-3500/denali/black/four-wheel-drive?price=20000-40000&showreservedcars=false
    """
    parts = ['cars']

    # Add make/model pairs if provided (CarMax supports multiple!)
    if makes and models:
        for make, model in zip(makes, models):
            parts.append(slugify(make))
            parts.append(slugify(model))

    # Add global filters (CarMax allows chaining these)
    if body_type:
        parts.append(slugify(body_type))
    if fuel_type:
        parts.append(slugify(fuel_type))
    if drivetrain:
        parts.append(slugify(drivetrain))
    if transmission:
        parts.append(slugify(transmission))
    if car_size:
        parts.append(slugify(car_size))
    if doors:
        parts.append(slugify(doors))
    if cylinders:
        parts.append(slugify(cylinders))
    if features:
        for feature in features:
            parts.append(slugify(feature))

    # Add trims (make/model specific)
    if trims:
        for trim in trims:
            parts.append(slugify(trim))

    # Add colors (can be exterior or interior)
    if colors:
        for color in colors:
            parts.append(slugify(color))

    # Build URL with query params
    url = f"https://www.carmax.com/{'/'.join(parts)}"

    # Add query parameters
    params = []
    if min_price is not None or max_price is not None:
        min_str = str(min_price) if min_price else ''
        max_str = str(max_price) if max_price else ''
        params.append(f"price={min_str}-{max_str}")

    params.append(f"showreservedcars={'true' if show_reserved else 'false'}")

    if params:
        url += '?' + '&'.join(params)

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


async def scrape_carmax(search_arg: str, max_results: int = 10, search_filters: dict = None):
    results = []

    # IMPORTANT: headless=False because camoufox crashes in headless mode
    browser = await AsyncCamoufox(headless=False, humanize=True).__aenter__()

    try:
        page = await browser.new_page()

        # Build URL based on search filters or use provided URL
        if search_arg.startswith('http'):
            # Direct URL provided
            search_url = search_arg
            logging.error(f"[CarMax] Using structured URL: {search_url}")
        elif search_filters:
            # Build URL from search filters (supports global filters + makes/models)
            makes = search_filters.get('makes', [])
            models = search_filters.get('models', [])

            # Ensure equal length for makes/models if both provided
            if makes and models:
                min_len = min(len(makes), len(models))
                makes = makes[:min_len]
                models = models[:min_len]

            # Extract all filter parameters
            trims = search_filters.get('trims', [])
            colors = search_filters.get('colors', [])
            body_type = search_filters.get('bodyType')
            fuel_type = search_filters.get('fuelType')
            drivetrain = search_filters.get('drivetrain')
            transmission = search_filters.get('transmission')
            car_size = search_filters.get('carSize')
            doors = search_filters.get('doors')
            cylinders = search_filters.get('cylinders')
            features = search_filters.get('features', [])
            min_price = search_filters.get('minPrice')
            max_price = search_filters.get('maxPrice')

            # Build URL with all applicable filters
            search_url = build_carmax_url(
                makes=makes if makes else None,
                models=models if models else None,
                trims=trims if trims else None,
                colors=colors if colors else None,
                body_type=body_type,
                fuel_type=fuel_type,
                drivetrain=drivetrain,
                transmission=transmission,
                car_size=car_size,
                doors=doors,
                cylinders=cylinders,
                features=features if features else None,
                min_price=min_price,
                max_price=max_price,
                show_reserved=False
            )
            logging.error(f"[CarMax] Built URL from filters: {search_url}")
        else:
            # Fallback to text search
            search_url = f"https://www.carmax.com/cars/all?search={search_arg.replace(' ', '+')}"
            logging.error(f"[CarMax] Searching for: {search_arg}")

        await page.goto(search_url, wait_until='domcontentloaded', timeout=60000)

        # Wait for listings to load
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
            logging.error(f"[CarMax] No results found - returning empty")
            return []

        # Find all car tiles using the selector we discovered
        tiles = await page.query_selector_all('.kmx-car-tile')
        logging.error(f"[CarMax] Found {len(tiles)} total listings")

        # Note: The recommendations filter was found to be too aggressive - it filtered all results
        # because the recommendations section wraps all content. For now, return all tiles.
        filtered_tiles = tiles
        logging.error(f"[CarMax] Processing {len(filtered_tiles)} listings")

        # Process filtered tiles
        for i, tile in enumerate(filtered_tiles[:max_results]):
            try:
                # Method 1: Extract from data-clickprops (most reliable for price/stock)
                clickprops = await tile.get_attribute('data-clickprops')
                if clickprops:
                    data = parse_data_clickprops(clickprops)
                    name = data.get('YMM', search_arg)  # Year Make Model (without trim)
                    price = extract_number(data.get('Price', '0'))
                    stock_number = data.get('StockNumber', '')
                else:
                    # Fallback: parse from page elements
                    link_elem = await tile.query_selector('a[href*="/car/"]')
                    name = await link_elem.inner_text() if link_elem else search_arg
                    price = 0
                    stock_number = ''

                # Extract URL from link element if stock_number not available
                url = ''
                if stock_number:
                    url = f"https://www.carmax.com/car/{stock_number}"
                else:
                    # Fallback: get URL directly from link element
                    link_elem = await tile.query_selector('a[href*="/car/"]')
                    if link_elem:
                        url = await link_elem.get_attribute('href') or ''
                        if url and not url.startswith('http'):
                            url = f"https://www.carmax.com{url}"

                # Get the full vehicle name from the tile text
                # The link element has the full name with trim (e.g., "2024 GMC Sierra 3500 Denali Ultimate")
                # But inner_text() might return split text, so we need to clean it up
                all_text = await tile.inner_text()

                # Try to extract the full vehicle name from all_text
                # Look for pattern like "2024 GMC Sierra 3500 Denali Ultimate"
                # This is typically the first meaningful line before the price
                name_match = re.search(r'(20\d{2}\s+.+?)(?=\n|$)', all_text, re.IGNORECASE)
                if name_match:
                    full_name = name_match.group(1).strip()
                    # Clean up the name (remove extra whitespace)
                    full_name = ' '.join(full_name.split())
                    # Use this if it's longer than what we had
                    if len(full_name) > len(name):
                        name = full_name

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
        await asyncio.sleep(2)  # Wait for output to flush
        await browser.close()

    # Limit results to max_results after filtering
    logging.error(f"[CarMax] Returning {len(results)} results (limited to {max_results})")
    return results[:max_results]


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: scrape-carmax.py <query/URL/structured> [max_results]",
            "examples": [
                "scrape-carmax.py 'GMC Sierra under $50000'",
                "scrape-carmax.py 'https://www.carmax.com/cars/gmc/sierra-3500'",
                "scrape-carmax.py '{\"structured\": {...}}'  # From parse_vehicle_query.py"
            ]
        }))
        sys.exit(1)

    query_input = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    # Parse input to determine if it's URL, structured JSON, or plain query
    search_filters = None
    search_arg = query_input

    if query_input.startswith('http'):
        # Direct URL
        search_arg = query_input
    elif query_input.strip().startswith('{'):
        # Structured JSON format from parse_vehicle_query.py
        try:
            structured_data = json.loads(query_input)
            if 'structured' in structured_data:
                # Use adapter to convert structured to CarMax params
                search_filters = adapt_structured_to_carmax(structured_data['structured'])
                search_arg = structured_data.get('query', 'Structured search')
            else:
                # Direct filter dict (backward compatibility)
                search_filters = structured_data
                search_arg = 'Filter search'
        except json.JSONDecodeError:
            search_arg = query_input
    else:
        # Plain text query - could be legacy format or just text
        # Check if it's a legacy JSON filters string
        try:
            filters = json.loads(query_input)
            if isinstance(filters, dict):
                search_filters = filters
                search_arg = 'Filter search'
        except json.JSONDecodeError:
            # Plain text query
            search_arg = query_input

    try:
        result = await scrape_carmax(search_arg, max_results, search_filters)

        if not result:
            print(json.dumps({"error": f"No CarMax listings found for '{search_arg}'"}))
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
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())

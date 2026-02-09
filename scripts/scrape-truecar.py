#!/usr/bin/env python3
"""
TrueCar scraper
First tries GraphQL API with filters, falls back to Camoufox scraping
"""
import asyncio
import json
import os
import sys
import tempfile
import logging
import re
from pathlib import Path
from typing import Optional, Dict, Any

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)

def extract_number(text: str) -> int:
    if not text:
        return 0
    cleaned = re.sub(r'[^\d,.]', '', str(text))
    cleaned = cleaned.replace(',', '')
    try:
        return int(float(cleaned))
    except:
        return 0


def adapt_structured_to_truecar(structured: dict) -> dict:
    """
    Convert structured query format to TrueCar-specific parameters.

    Handles two formats:
    1. LLM retailer-specific format: {url_params, path_components, body_params}
    2. Legacy format: {makes, models, trims, zip, location, year, ...}

    TrueCar specifics:
    - Uses mmt[] format for make/model/trim (make_model-series_trim)
    - Supports yearHigh/yearLow or yearMin/yearMax for year ranges
    - Uses budget for max price
    - Has bodyStyle, drivetrain, fuelType filters

    Args:
        structured: The structured query dict

    Returns:
        TrueCar-specific parameter dict for scrape_truecar()
    """
    params = {}

    # Handle LLM retailer-specific format (new format from parse_vehicle_query.py)
    if 'url_params' in structured or 'path_components' in structured:
        path_components = structured.get('path_components', {})
        url_params = structured.get('url_params', {})

        # Extract make/model/trim from path_components
        make = path_components.get('make', '')
        model = path_components.get('model', '')
        trim = path_components.get('trim', '')

        if make:
            params['make'] = make
        if model:
            params['model'] = model
        if trim:
            params['trims'] = [trim]

        # Extract years from url_params (yearMin/yearMax)
        if url_params.get('yearMin'):
            params['startYear'] = url_params['yearMin']
        if url_params.get('yearMax'):
            params['endYear'] = url_params['yearMax']

        # Extract other params from url_params
        if url_params.get('maxPrice'):
            params['budget'] = url_params['maxPrice']

        return params

    # Handle legacy format {makes, models, trims, zip, location, year, ...}
    # Make (take first if multiple - TrueCar only supports single make)
    if structured.get('makes'):
        params['make'] = structured['makes'][0]

    # Model (take first if multiple)
    if structured.get('models'):
        params['model'] = structured['models'][0]

    # Trims (TrueCar takes single trim as first value)
    if structured.get('trims'):
        params['trims'] = [structured['trims'][0]]

    # Year handling - extract min/max from year dict if it's a range
    if structured.get('year'):
        year = structured['year']
        if isinstance(year, dict):
            # Year range provided - extract min/max
            if year.get('min'):
                params['startYear'] = year['min']
            if year.get('max'):
                params['endYear'] = year['max']
        elif isinstance(year, int):
            # Single year provided
            params['year'] = year
    else:
        # Use yearMin/yearMax as startYear/endYear
        if structured.get('yearMin'):
            params['startYear'] = structured['yearMin']
        if structured.get('yearMax'):
            params['endYear'] = structured['yearMax']

    # Price - TrueCar uses budget for max price
    if structured.get('maxPrice'):
        params['budget'] = structured['maxPrice']

    # Body type
    if structured.get('bodyType'):
        params['bodyStyle'] = structured['bodyType']

    # Drivetrain
    if structured.get('drivetrain'):
        params['drivetrain'] = structured['drivetrain']

    # Fuel type
    if structured.get('fuelType'):
        params['fuelType'] = structured['fuelType']

    return params


async def scrape_truecar_graphql(search_filters: Dict[str, Any], max_results: int = 10) -> list:
    """
    Try TrueCar GraphQL API first (faster if it works)
    """
    try:
        import aiohttp
    except ImportError:
        return None

    results = []
    api_url = "https://www.truecar.com/abp/api/graphql/"

    headers = {
        'accept': 'application/json',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }

    # Build search query from filters
    query_parts = []
    if search_filters.get('make'):
        query_parts.append(search_filters['make'])

    model = search_filters.get('model', '')
    series = search_filters.get('series', '')

    # Use model directly (series will be appended to model_slug below if needed)
    if model:
        query_parts.append(model)

    if search_filters.get('year'):
        query_parts.append(str(search_filters['year']))

    search_query = ' '.join(query_parts) if query_parts else None

    if not search_query:
        return None

    # Simple query format that's more likely to work
    graphql_query = """
    query Search($query: String!) {
      vehicleSearch(query: $query, first: %d) {
        edges {
          node {
            id
            vehicle {
              make { name }
              model { name }
              year
              mileage
            }
            pricing { listPrice }
          }
        }
      }
    }
    """ % max_results

    data = {
        "query": graphql_query,
        "variables": {"query": search_query}
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(api_url, headers=headers, json=data, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    logging.error(f"[TrueCar] GraphQL API returned {resp.status}")
                    return None

                response = await resp.json()

                # Check for errors
                if 'errors' in response:
                    logging.error(f"[TrueCar] GraphQL error: {response['errors'][0]['message']}")
                    return None

                edges = response.get('data', {}).get('vehicleSearch', {}).get('edges', [])
                if not edges:
                    return None

                for edge in edges:
                    node = edge.get('node', {})
                    vehicle = node.get('vehicle', {})

                    title = f"{vehicle.get('year', '')} {vehicle.get('make', {}).get('name', '')} {vehicle.get('model', {}).get('name', '')}"
                    price = node.get('pricing', {}).get('listPrice', 0) or 0
                    mileage = vehicle.get('mileage', 0) or 0

                    results.append({
                        'name': title.strip(),
                        'price': price,
                        'mileage': mileage,
                        'image': '',
                        'retailer': 'TrueCar',
                        'url': f"https://www.truecar.com",
                        'location': 'TrueCar'
                    })

                logging.error(f"[TrueCar] GraphQL returned {len(results)} results")
                return results if results else None

    except Exception as e:
        logging.error(f"[TrueCar] GraphQL failed: {e}")
        return None


async def scrape_truecar_camoufox(search_filters: Dict[str, Any], max_results: int = 10) -> list:
    """
    Fallback to Camoufox browser scraping with TrueCar URL filters
    TrueCar format: /used-cars-for-sale/listings/inventory/?mmt[]=make_model-series_trim&yearHigh=2025&yearLow=2025
    """
    try:
        from camoufox.async_api import AsyncCamoufox
    except ImportError:
        logging.error("[TrueCar] Camoufox not available")
        return []

    results = []

    make = search_filters.get('make', '').lower() if search_filters.get('make') else ''
    model = search_filters.get('model', '') or ''
    series = search_filters.get('series', '')

    # Build model_slug: make_model
    # If series is provided (like "HD"), append it to model
    # Example: "Sierra 3500" + series "HD" -> "sierra-3500hd"
    import re
    model_slug = model.lower().replace(' ', '-') if model else ''

    # Append series if it's a suffix like "HD" and not already in model_slug
    if series and series.upper() not in model_slug.upper():
        series_lower = series.lower()
        # For series like "HD", append directly to the last number
        # sierra-3500 + HD = sierra-3500hd
        model_slug = f'{model_slug}{series_lower}'

    # Build mmt value - make_modelslug
    base_model = f'{make}_{model_slug}' if make and model_slug else ''

    mmt_value = base_model

    # Add trim if specified (e.g., _denali-ultimate)
    if search_filters.get('trims'):
        trims = search_filters.get('trims', [])
        if trims and len(trims) > 0:
            trim = trims[0]
            trim_clean = trim.lower().replace(' ', '-') if trim else ''
            if trim_clean:
                mmt_value = f'{mmt_value}_{trim_clean}'

    # Build URL parameters
    params = []
    if mmt_value:
        params.append(f'mmt[]={mmt_value}')

    # Add search radius (use maximum - 5000 = nationwide)
    params.append('searchRadius=5000')

    # Add location (default to CA for broader results)
    params.append('state=ca')
    params.append('city=south-san-francisco')

    # Add year range - support startYear/endYear for "4 years or newer"
    # If no year specified, use a broad range to get results
    start_year = search_filters.get('startYear')
    end_year = search_filters.get('endYear')
    single_year = search_filters.get('year')

    if single_year:
        params.append(f'yearHigh={single_year}')
        params.append(f'yearLow={single_year}')
    elif start_year and end_year:
        params.append(f'yearHigh={end_year}')
        params.append(f'yearLow={start_year}')
    elif end_year:
        # Only endYear specified (e.g., "2024 or older")
        params.append(f'yearHigh={end_year}')
    # If no year info at all, don't add year filter to get broader results

    # Add price range if budget specified
    budget = search_filters.get('budget')
    if budget:
        params.append(f'price_high={budget}')
        params.append('price_low=2000')

    # Add body style
    body_style = search_filters.get('bodyStyle', '').lower()
    if body_style:
        if 'truck' in body_style or 'pickup' in body_style:
            params.append('bodyStyles[]=truck')
        elif 'suv' in body_style:
            params.append('bodyStyles[]=suv')
        elif 'sedan' in body_style:
            params.append('bodyStyles[]=sedan')

    # Add drivetrain
    drivetrain = search_filters.get('drivetrain', '').upper()
    if drivetrain:
        if '4WD' in drivetrain or 'AWD' in drivetrain:
            params.append('driveTrain[]=4WD')
        elif '2WD' in drivetrain or 'RWD' in drivetrain:
            params.append('driveTrain[]=2WD')

    # Add fuel type
    fuel_type = search_filters.get('fuelType', '').lower()
    if fuel_type:
        if 'diesel' in fuel_type:
            params.append('fuelType[]=Diesel')
        elif 'electric' in fuel_type:
            params.append('fuelType[]=Electric')
        elif 'hybrid' in fuel_type:
            params.append('fuelType[]=Hybrid')

    # Build URL
    if params:
        search_url = f"https://www.truecar.com/used-cars-for-sale/listings/inventory/?{'&'.join(params)}"
    else:
        # Fallback to simple make/model URL
        if make and model:
            search_url = f"https://www.truecar.com/used-cars-for-sale/listings/{make}/{model}/"
        else:
            # Fallback to text search
            query_parts = filter(None, [
                str(search_filters.get('year', '')),
                search_filters.get('make', ''),
                search_filters.get('model', ''),
                search_filters.get('series', '')
            ])
            search_query = '+'.join(query_parts)
            search_url = f"https://www.truecar.com/used-cars-for-sale/listings/?searchQuery={search_query}"

    logging.error(f"[TrueCar] Camoufox: {search_url}")

    browser = await AsyncCamoufox(headless=False, humanize=True).__aenter__()

    try:
        page = await browser.new_page()
        await page.goto(search_url, wait_until='domcontentloaded', timeout=60000)

        # Wait for listing cards first
        try:
            await page.wait_for_selector('[data-test="vehicleListingCard"]', timeout=25000)
        except:
            # Timeout - page might not have loaded properly
            logging.warning(f"[TrueCar] Timeout waiting for listing cards, attempting to continue...")

        # Wait for pricing to load within cards (TrueCar loads pricing dynamically via JS)
        try:
            await page.wait_for_selector('[data-test="vehicleCardPricingPrice"]', timeout=10000)
        except:
            # If pricing doesn't load, continue anyway and try to extract
            logging.warning(f"[TrueCar] Timeout waiting for pricing, attempting extraction anyway...")

        # Check for "No exact matches" condition - don't return similar cars
        # BUT first try to extract listings - only return empty if truly no listings found
        listings = await page.query_selector_all('[data-test="vehicleListingCard"]')
        logging.error(f"[TrueCar] Found {len(listings)} listings")

        if len(listings) == 0:
            # Only check for "no results" text if we found no listings
            try:
                page_text = await page.inner_text('body', timeout=5000)
                if '0 Listings' in page_text or 'No exact matches' in page_text or 'Oops!' in page_text:
                    logging.error(f"[TrueCar] No exact matches found - returning empty results")
                    return []
            except Exception as e:
                logging.warning(f"[TrueCar] Could not read page text: {e}")
            return []

        for i, listing in enumerate(listings[:max_results]):
            try:
                all_text = await listing.inner_text()

                title_elem = await listing.query_selector('h3, h2')
                if title_elem:
                    title = (await title_elem.inner_text()).strip()
                else:
                    year_match = re.search(r'\b(19|20)\d{2}\b', all_text)
                    title = year_match.group(0) if year_match else search_query

                price_elem = await listing.query_selector('[data-test="vehicleCardPricingPrice"]')
                price = 0
                if price_elem:
                    price = extract_number(await price_elem.inner_text())

                mileage_match = re.search(r'(\d+[,\d]*)\s*mi', all_text, re.IGNORECASE)
                mileage = extract_number(mileage_match.group(1)) if mileage_match else 0

                img_elem = await listing.query_selector('img')
                image = await img_elem.get_attribute('src') if img_elem else ''

                link_elem = await listing.query_selector('a[href*="/listing/"]')
                url = ''
                if link_elem:
                    url = await link_elem.get_attribute('href') or ''
                    url = url if url.startswith('http') else f"https://www.truecar.com{url}"

                if price > 0:
                    results.append({
                        'name': title,
                        'price': price,
                        'mileage': mileage,
                        'image': image,
                        'retailer': 'TrueCar',
                        'url': url,
                        'location': 'TrueCar'
                    })
                    logging.error(f"[TrueCar] {title[:30]} - ${price:,}")

            except Exception as e:
                logging.error(f"[TrueCar] Error extracting {i}: {e}")
                continue

    except Exception as e:
        logging.error(f"[TrueCar] Camoufox error: {e}")
    finally:
        await browser.close()

    return results


async def scrape_truecar(search_filters: Optional[Dict[str, Any]] = None, max_results: int = 10) -> list:
    """
    Main entry point - uses Camoufox scraping.

    Note: GraphQL path is disabled because it doesn't provide individual vehicle URLs,
    causing all listings to share the same URL and be filtered as duplicates.
    """
    if not search_filters:
        return []

    # Use Camoufox directly (GraphQL doesn't provide individual URLs)
    return await scrape_truecar_camoufox(search_filters, max_results)


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: scrape-truecar.py <JSON filters or structured> [max_results]",
            "examples": [
                '{"make": "GMC", "model": "Sierra 3500", "trims": ["Denali"]}',
                "'{\"structured\": {...}}'  # From parse_vehicle_query.py"
            ]
        }))
        sys.exit(1)

    arg = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    try:
        search_filters = json.loads(arg)

        # Check if this is a structured format from parse_vehicle_query.py
        if 'structured' in search_filters:
            # Use adapter to convert structured to TrueCar params
            search_filters = adapt_structured_to_truecar(search_filters['structured'])

        # Handle LLM retailer-specific format (plural keys → singular)
        if 'makes' in search_filters and 'make' not in search_filters:
            makes = search_filters.pop('makes', [])
            if makes:
                search_filters['make'] = makes[0]
        if 'models' in search_filters and 'model' not in search_filters:
            models = search_filters.pop('models', [])
            if models:
                search_filters['model'] = models[0]
        if 'yearMin' in search_filters and 'startYear' not in search_filters:
            search_filters['startYear'] = search_filters.pop('yearMin')
        if 'yearMax' in search_filters and 'endYear' not in search_filters:
            search_filters['endYear'] = search_filters.pop('yearMax')
        if 'maxPrice' in search_filters and 'budget' not in search_filters:
            search_filters['budget'] = search_filters.pop('maxPrice')

        result = await scrape_truecar(search_filters, max_results)

        # Handle different return types
        # - None: error (bot detection or other issue)
        # - []: no results found (valid empty response)
        # - list with items: success
        if result is None:
            print(json.dumps({"error": "TrueCar scraping failed"}))
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

#!/usr/bin/env python3
"""
TrueCar scraper
First tries GraphQL API with filters, falls back to Camoufox scraping
"""
import asyncio
import json
import sys
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
    if search_filters.get('model'):
        query_parts.append(search_filters['model'])
    if search_filters.get('year'):
        query_parts.append(str(search_filters['year']))
    if search_filters.get('series'):
        query_parts.append(search_filters['series'])

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

    # Build TrueCar URL with filters using mmt[] parameter
    # mmt format: make_model-series_trim (e.g., gmc_sierra-3500hd_denali-ultimate)
    make = search_filters.get('make', '').lower() if search_filters.get('make') else ''
    model = search_filters.get('model', '').lower().replace(' ', '-') if search_filters.get('model') else ''
    series = search_filters.get('series', '').lower() if search_filters.get('series') else ''

    # Build mmt value with proper underscores
    # Format: make_model or make_model-series or make_model-series_trim
    mmt_parts = [f'{make}_{model}' if make and model else '']

    if series:
        # Append series with hyphen: make_model-series
        mmt_parts[0] = f'{mmt_parts[0]}-{series}'

    # Add first trim if available
    trims = search_filters.get('trims', [])
    if trims and len(trims) > 0:
        trim_slug = trims[0].lower().replace(' ', '-')
        mmt_parts[0] = f'{mmt_parts[0]}_{trim_slug}'

    mmt_value = mmt_parts[0] if mmt_parts[0] else ''

    # Build URL parameters
    params = []
    if mmt_value:
        params.append(f'mmt[]={mmt_value}')

    # Add search radius (required for results to show)
    params.append('searchRadius=5000')

    # Add location (default to CA for broader results)
    params.append('state=ca')
    params.append('city=south-san-francisco')

    # Add year range
    year = search_filters.get('year')
    if year:
        params.append(f'yearHigh={year}')
        params.append(f'yearLow={year}')

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
        await asyncio.sleep(5)

        listings = await page.query_selector_all('[data-test="vehicleListingCard"]')
        logging.error(f"[TrueCar] Found {len(listings)} listings")

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
    Main entry point - tries GraphQL first, falls back to Camoufox
    """
    if not search_filters:
        return []

    # Try GraphQL first (faster)
    if search_filters.get('make') and search_filters.get('model'):
        results = await scrape_truecar_graphql(search_filters, max_results)
        if results:
            return results

    # Fall back to Camoufox
    return await scrape_truecar_camoufox(search_filters, max_results)


async def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: scrape-truecar.py <JSON filters> [max_results]"}))
        sys.exit(1)

    arg = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    try:
        search_filters = json.loads(arg)
        result = await scrape_truecar(search_filters, max_results)

        if not result:
            print(json.dumps({"error": f"No TrueCar listings found"}))
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

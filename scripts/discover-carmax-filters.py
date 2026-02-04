#!/usr/bin/env python3
"""
CarMax Filter Discovery Script
Discovers all valid filter values (trims, colors, drivetrains, etc.) for all makes/models.
Uses Camoufox for browser automation (must run in visible mode).
"""
import asyncio
import json
import sys
import logging
import re
from pathlib import Path
from datetime import datetime
from typing import Dict, Set, List, Tuple
from collections import defaultdict

logging.basicConfig(
    level=logging.ERROR,
    format='%(message)s',
    stream=sys.stderr
)

from camoufox.async_api import AsyncCamoufox
from dotenv import load_dotenv

env_path = Path(__file__).parent.parent / '.env'
load_dotenv(env_path)

# Output file
OUTPUT_FILE = Path(__file__).parent / 'data' / 'carmax-filters.json'

# Known vehicle makes (from CarMax)
KNOWN_MAKES = [
    'acura', 'audi', 'bmw', 'buick', 'cadillac', 'chevrolet', 'chrysler', 'dodge',
    'fiat', 'ford', 'genesis', 'gmc', 'honda', 'hyundai', 'infiniti', 'jaguar',
    'jeep', 'kia', 'land-rover', 'lexus', 'lincoln', 'mazda', 'mercedes-benz',
    'mini', 'mitsubishi', 'nissan', 'ram', 'rivian', 'scion', 'smart', 'subaru',
    'tesla', 'toyota', 'volkswagen', 'volvo'
]

# Common trim patterns to recognize
COMMON_TRIMS = [
    'base', 'le', 'se', 'xle', 'xse', 'limited', 'platinum', 'premium',
    'xl', 'xlt', 'lariat', 'king-ranch', 'raptor', 'tremor',
    'sle', 'slt', 'denali', 'denali-ultimate', 'at4', 'at4x', 'elevation', 'pro',
    'lx', 'ex', 'touring', 'ex-l', 'touring', 'elite',
    'sport', 'rubicon', 'sahara', 'overland', 'summit', 'trailhawk',
    'lx', 'es', 'gs', 'ls', 'nx', 'rx', 'gx', 'tx',
    's', 'se', 'sel', 'titanium', 'sel', 'SES',
    'lx', 'signature', 'premium', 'select', 'reserve',
    'big-horn', 'lone-star', 'longhorn', 'tradesman', 'rebel', 'limited',
    'prime', 'adventure', 'trd-off-road', 'trd-off-road-premium',
    'sv', 'sl', 'platinum', 'platinum-reserve', 'night-edition'
]

# Filter category mappings - these should be excluded from model discovery
DRIVETRAINS = ['four-wheel-drive', 'rear-wheel-drive', 'all-wheel-drive', 'front-wheel-drive', '4x4', '4x2', 'awd', 'fwd', 'rwd']
FUEL_TYPES = ['gas', 'diesel', 'electric', 'hybrid', 'plug-in-hybrid']
COLORS = [
    'black', 'white', 'gray', 'grey', 'silver', 'blue', 'red', 'green',
    'brown', 'gold', 'orange', 'purple', 'beige', 'charcoal', 'tan',
    'pearl', 'metallic'
]
FEATURES = [
    'heated-seats', 'heated-ventilated-seats', 'heated-steering-wheel', 'ventilated-seats',
    'leather-seats', 'memory-seats', 'power-seats', 'massaging-seats', 'seat-massagers',
    'remote-start', 'tow-hitch', 'gooseneck-tow-hitch', 'navigation', 'navigation-system',
    'sunroof', 'moonroof', 'panoramic-sunroof', 'backup-camera', 'surround-camera', '360-camera',
    'blind-spot-monitoring', 'blind-spot', 'lane-keep-assist', 'lane-keep',
    'adaptive-cruise-control', 'adaptive-cruise', 'premium-audio', 'wireless-charging',
    'head-up-display', 'apple-carplay', 'android-auto', 'rear-entertainment-system'
]

# Vehicle types and categories to exclude from model discovery
VEHICLE_TYPES = [
    'suv', 'suv', 'truck', 'pickup-trucks', 'sedans', 'coupes', 'convertibles',
    'hatchbacks', 'wagons', 'minivans', 'vans', 'crossovers', 'luxury-vehicles',
    'sports-cars', 'electric', 'hybrid', 'diesel', 'plug-in-hybrid'
]

# Filter terms that indicate a non-model URL
FILTER_TERMS = DRIVETRAINS + FUEL_TYPES + COLORS + FEATURES + VEHICLE_TYPES + [
    'automatic', 'manual', 'transmission', 'cylinders', 'doors',
    '20-inch-plus-wheels', '18-inch-plus-wheels', 'quad-seats', 'full-roof-rack',
    'soft-top', 'turbo-charged-engine'
]


async def extract_filters_from_page(page, make: str, model: str) -> Dict:
    """Extract filter options from a CarMax make/model page."""
    results = {
        'trims': set(),
        'colors': set(),
        'drivetrains': set(),
        'features': set(),
        'fuel_types': set()
    }

    try:
        # Extract trims from car listing names
        car_links = await page.query_selector_all('a[href*="/car/"]')

        for link in car_links[:50]:  # Limit to first 50 for speed
            try:
                text = await link.inner_text()
                text = text.strip()

                # Check for known trims in the text
                for trim in COMMON_TRIMS:
                    if trim.lower() in text.lower() or trim.replace('-', ' ').lower() in text.lower():
                        results['trims'].add(trim.replace('-', ' ').title())
            except:
                continue

        # Extract from "Shop Similar Cars" section for additional filters
        similar_links = await page.query_selector_all(f'a[href^="/cars/{make}/"]')

        for link in similar_links[:30]:  # Limit for speed
            try:
                href = await link.get_attribute('href')
                if not href:
                    continue

                # Parse URL: /cars/{make}/{model}/{filter}
                parts = [p for p in href.split('/') if p and not p.startswith('?')]
                if len(parts) < 5:
                    continue

                slug = parts[4].lower()

                # Categorize by slug
                if slug in DRIVETRAINS:
                    results['drivetrains'].add(slug)
                elif slug in FUEL_TYPES:
                    results['fuel_types'].add(slug)
                elif slug in COLORS:
                    results['colors'].add(slug)
                elif slug in FEATURES:
                    results['features'].add(slug)
                elif slug.replace('-', '') in [t.replace('-', '') for t in COMMON_TRIMS]:
                    results['trims'].add(slug.replace('-', ' ').title())
            except:
                continue

        # Convert sets to sorted lists
        return {
            'trims': sorted(list(results['trims'])),
            'colors': sorted(list(results['colors'])),
            'drivetrains': sorted(list(results['drivetrains'])),
            'features': sorted(list(results['features'])),
            'fuel_types': sorted(list(results['fuel_types']))
        }

    except Exception as e:
        logging.error(f"Error extracting filters for {make} {model}: {e}")
        return {
            'trims': [],
            'colors': [],
            'drivetrains': [],
            'features': [],
            'fuel_types': []
        }


async def discover_models_for_make(page, make: str) -> List[str]:
    """Discover all models available for a given make."""
    models = set()

    try:
        # Navigate to make page
        url = f"https://www.carmax.com/cars/{make}?showreservedcars=false"
        await page.goto(url, wait_until='domcontentloaded', timeout=30000)
        await asyncio.sleep(2)

        # Find all model links in the "Shop Similar Cars" or other sections
        all_links = await page.query_selector_all('a[href^="/cars/"]')

        for link in all_links[:100]:  # Limit for speed
            try:
                href = await link.get_attribute('href')
                if not href:
                    continue

                # Parse URL: /cars/{make}/{model}
                parts = [p for p in href.split('/') if p and not p.startswith('?')]
                if len(parts) >= 3 and parts[0] == 'cars' and parts[1] == make:
                    model = parts[2]

                    # Skip if it's a number (year), or in filter terms
                    model_lower = model.lower()
                    # Pattern check: exclude feature-like patterns (ends with -seats, -camera, etc.)
                    is_feature_pattern = any([
                        model.endswith('-seats'),
                        model.endswith('-camera'),
                        model.endswith('-charging'),
                        model.endswith('-audio'),
                        model.endswith('-display'),
                        model.endswith('-monitor'),
                        model.endswith('-assist'),
                        model.startswith('20-inch'),
                        model.startswith('18-inch'),
                        model.startswith('navigation'),
                        model.startswith('apple-'),
                        model.startswith('android-')
                    ])
                    if not model.isdigit() and model not in FILTER_TERMS and not is_feature_pattern:
                        # Additional check: model names are typically short (2-20 chars) and contain letters
                        if 2 <= len(model) <= 25 and any(c.isalpha() for c in model):
                            models.add(model)
            except:
                continue

        return sorted(list(models))

    except Exception as e:
        logging.error(f"Error discovering models for {make}: {e}")
        return []


async def discover_filters():
    """Main function to discover all CarMax filters."""
    all_filters = defaultdict(dict)

    browser = None

    try:
        logging.error("Starting CarMax filter discovery...")
        browser = await AsyncCamoufox(
            headless=False,
            humanize=True
        ).__aenter__()

        page = await browser.new_page()

        # For each make, discover models and their filters
        for i, make in enumerate(KNOWN_MAKES, 1):
            logging.error(f"[{i}/{len(KNOWN_MAKES)}] Processing {make}...")

            # Discover models for this make
            models = await discover_models_for_make(page, make)

            if not models:
                logging.error(f"  No models found for {make}, skipping")
                continue

            logging.error(f"  Found {len(models)} models: {', '.join(models[:5])}{'...' if len(models) > 5 else ''}")

            # For each model, extract filters
            for j, model in enumerate(models, 1):
                logging.error(f"    [{j}/{len(models)}] Extracting filters for {make} {model}...")

                url = f"https://www.carmax.com/cars/{make}/{model}?showreservedcars=false"
                await page.goto(url, wait_until='domcontentloaded', timeout=30000)
                await asyncio.sleep(2)

                filters = await extract_filters_from_page(page, make, model)

                # Only store if we found something
                if any(filters.values()):
                    all_filters[make][model] = filters
                else:
                    # Empty entry to show we checked it
                    all_filters[make][model] = {
                        'trims': [], 'colors': [], 'drivetrains': [],
                        'features': [], 'fuel_types': []
                    }

        # Convert defaultdict to regular dict
        final_data = dict(all_filters)

        # Add metadata
        output = {
            'version': '1.0',
            'last_updated': datetime.now().isoformat(),
            'makes_count': len([m for m in final_data.keys() if final_data[m]]),
            'models_count': sum(len(models) for models in final_data.values()),
            'filters': final_data
        }

        # Save to file
        OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(OUTPUT_FILE, 'w') as f:
            json.dump(output, f, indent=2)

        logging.error(f"\nFilter discovery complete!")
        logging.error(f"Total makes: {output['makes_count']}")
        logging.error(f"Total models: {output['models_count']}")
        logging.error(f"Saved to: {OUTPUT_FILE}")
        logging.error(f"File size: {OUTPUT_FILE.stat().st_size / 1024:.1f} KB")

        return output

    except Exception as e:
        logging.error(f"Discovery failed: {e}")
        import traceback
        traceback.print_exc()
        return None

    finally:
        if browser:
            await asyncio.sleep(2)
            try:
                await browser.close()
            except:
                pass


async def main():
    result = await discover_filters()

    if result:
        print(json.dumps({
            "status": "success",
            "makes": result['makes_count'],
            "models": result['models_count'],
            "file": str(OUTPUT_FILE),
            "size_kb": f"{OUTPUT_FILE.stat().st_size / 1024:.1f}"
        }, indent=2))
    else:
        print(json.dumps({"status": "error", "message": "Filter discovery failed"}))


if __name__ == '__main__':
    asyncio.run(main())

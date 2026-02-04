#!/usr/bin/env python3
"""
Vehicle Query Parser

Converts natural language vehicle queries into a structured format
compatible with all car scrapers (CarMax, CarGurus, AutoTrader, TrueCar, Carvana).

The structured output is the single source of truth - each scraper
has its own adapter to convert this to scraper-specific parameters.

Usage:
    python3 parse_vehicle_query.py "GMC Sierra Denali under $50000"
    python3 parse_vehicle_query.py "black Toyota RAV4 with heated seats"
"""
import asyncio
import json
import sys
import re
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    from openai import AsyncOpenAI
except ImportError:
    AsyncOpenAI = None

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)

# Load filter catalog
FILTER_CATALOG_PATH = Path(__file__).parent / 'data' / 'carmax-filters.json'


def load_filter_catalog() -> dict:
    """Load the CarMax filter catalog for available filter options."""
    if FILTER_CATALOG_PATH.exists():
        with open(FILTER_CATALOG_PATH, 'r') as f:
            return json.load(f)
    return {'global_filters': {}, 'filters': {}}


def parse_with_patterns(query: str, catalog: dict) -> dict:
    """
    Parse query using regex patterns (fast, no LLM needed).

    This handles common patterns like:
    - "GMC Sierra Denali under $50000"
    - "2024 black Toyota RAV4 with heated seats"
    - "Ford F-150 or Chevy Silverado"
    """
    query_lower = query.lower()
    result = {
        "query": query,
        "structured": {
            "makes": [],
            "models": [],
            "trims": [],
            "year": None,
            "yearMin": None,
            "yearMax": None,
            "minPrice": None,
            "maxPrice": None,
            "drivetrain": None,
            "fuelType": None,
            "bodyType": None,
            "transmission": None,
            "doors": None,
            "cylinders": None,
            "exteriorColor": None,
            "interiorColor": None,
            "features": [],
            "location": {
                "zip": None,
                "distance": None,
                "city": None,
                "state": None
            }
        }
    }

    global_filters = catalog.get('global_filters', {})

    # Extract price (under $50000, $20000-$40000, etc.)
    price_patterns = [
        r'under\s*\$?(\d+)',
        r'below\s*\$?(\d+)',
        r'less than\s*\$?(\d+)',
        r'max\s*\$?(\d+)',
        r'\$?(\d+)\s*-\s*\$?(\d+)',
        r'between\s*\$?(\d+)\s*and\s*\$?(\d+)',
        r'up to\s*\$?(\d+)'
    ]

    for pattern in price_patterns:
        match = re.search(pattern, query_lower)
        if match:
            if len(match.groups()) == 2 and match.group(2):
                result["structured"]["minPrice"] = int(match.group(1))
                result["structured"]["maxPrice"] = int(match.group(2))
            else:
                result["structured"]["maxPrice"] = int(match.group(1))
            break

    # Extract year
    year_match = re.search(r'\b(20\d{2})\b', query)
    if year_match:
        result["structured"]["year"] = int(year_match.group(1))

    # Extract color
    colors = global_filters.get('exterior_colors', [])
    for color in colors:
        if color.lower() in query_lower:
            result["structured"]["exteriorColor"] = color
            break

    # Extract body type
    body_types = global_filters.get('body_types', [])
    for body_type in body_types:
        if body_type.lower() in query_lower:
            result["structured"]["bodyType"] = body_type
            break

    # Extract drivetrain
    drivetrains = global_filters.get('drivetrains', [])
    for dt in drivetrains:
        if dt.lower() in query_lower:
            result["structured"]["drivetrain"] = dt
            break

    # Extract fuel type
    fuel_types = global_filters.get('fuel_types', [])
    for ft in fuel_types:
        if ft.lower() in query_lower:
            result["structured"]["fuelType"] = ft
            break

    # Extract features
    features = global_filters.get('features', [])
    for feature in features:
        if feature.lower() in query_lower:
            result["structured"]["features"].append(feature)

    # Common make names (capitalized for matching)
    common_makes = {
        'gmc': 'GMC', 'ford': 'Ford', 'chevrolet': 'Chevrolet', 'chevy': 'Chevrolet',
        'toyota': 'Toyota', 'honda': 'Honda', 'jeep': 'Jeep', 'ram': 'Ram',
        'dodge': 'Dodge', 'nissan': 'Nissan', 'bmw': 'BMW', 'mercedes': 'Mercedes',
        'lexus': 'Lexus', 'audi': 'Audi', 'cadillac': 'Cadillac', 'buick': 'Buick',
        'lincoln': 'Lincoln', 'acura': 'Acura', 'infiniti': 'Infiniti',
        'volkswagen': 'Volkswagen', 'volvo': 'Volvo', 'subaru': 'Subaru',
        'mazda': 'Mazda', 'kia': 'Kia', 'hyundai': 'Hyundai', 'mitsubishi': 'Mitsubishi'
    }

    for make_lower, make_proper in common_makes.items():
        if make_lower in query_lower:
            result["structured"]["makes"].append(make_proper)

    # Common model names (simplified - in production would use catalog)
    # This is a basic implementation - production should use the filter catalog
    if 'sierra' in query_lower or 'silverado' in query_lower:
        if '3500' in query_lower or '1500' in query_lower:
            model = 'Sierra 3500' if 'sierra' in query_lower else 'Silverado 1500'
        else:
            model = 'Sierra' if 'sierra' in query_lower else 'Silverado'
        result["structured"]["models"].append(model)
    elif 'f-150' in query_lower or 'f150' in query_lower:
        result["structured"]["models"].append('F-150')
    elif 'rav4' in query_lower:
        result["structured"]["models"].append('RAV4')
    elif 'cr-v' in query_lower or 'crv' in query_lower:
        result["structured"]["models"].append('CR-V')
    elif 'wrangler' in query_lower:
        result["structured"]["models"].append('Wrangler')
    elif 'grand cherokee' in query_lower:
        result["structured"]["models"].append('Grand Cherokee')
    elif 'tacoma' in query_lower:
        result["structured"]["models"].append('Tacoma')
    elif 'tundra' in query_lower:
        result["structured"]["models"].append('Tundra')
    elif 'camry' in query_lower:
        result["structured"]["models"].append('Camry')
    elif 'corvette' in query_lower:
        result["structured"]["models"].append('Corvette')
    elif 'mustang' in query_lower:
        result["structured"]["models"].append('Mustang')

    # Common trims
    trim_patterns = {
        'denali ultimate': 'Denali Ultimate',
        'denali': 'Denali',
        'at4': 'AT4',
        'lariat': 'Lariat',
        'king ranch': 'King Ranch',
        'platinum': 'Platinum',
        'limited': 'Limited',
        'rubicon': 'Rubicon',
        'sahara': 'Sahara',
        'xle': 'XLE',
        'xse': 'XSE'
    }

    for trim_pattern, trim_name in trim_patterns.items():
        if trim_pattern in query_lower:
            result["structured"]["trims"].append(trim_name)

    return result


async def parse_with_llm(query: str, catalog: dict, api_key: str = None) -> dict:
    """
    Parse query using LLM (handles complex natural language).

    Falls back to pattern parsing if OpenAI is not available.
    """
    if not AsyncOpenAI or not api_key:
        logging.error("OpenAI not available, using pattern matching")
        return parse_with_patterns(query, catalog)

    global_filters = catalog.get('global_filters', {})

    system_prompt = f"""You are a vehicle search query parser. Convert natural language queries into a structured JSON format for car scrapers.

Available filter values (use these exact values when found in the query):

Body Types: {', '.join(global_filters.get('body_types', [])[:10])}
Fuel Types: {', '.join(global_filters.get('fuel_types', []))}
Drivetrains: {', '.join(global_filters.get('drivetrains', []))}
Colors: {', '.join(global_filters.get('exterior_colors', [])[:10])}
Features (common): Seat Massagers, Sunroof, Navigation, Heated Seats, Tow Hitch, Remote Start, Backup Camera, Leather Seats, Moonroof, Panoramic Sunroof, Apple CarPlay, Android Auto

Rules:
1. Extract makes/models/trims from the query (handle abbreviations like "chevy" → "Chevrolet")
2. Price: "under $50000" → maxPrice: 50000, "$20000-$40000" → minPrice: 20000, maxPrice: 40000
3. Year: "2024" or "2020+" → yearMin: 2020
4. Multiple makes/models supported - return as arrays
5. If a filter value isn't found, don't include it (null instead of empty string)
6. features should be an array of feature names
7. Return ONLY valid JSON, no explanation

Output format:
{{
  "query": "original query string",
  "structured": {{
    "makes": ["Make1", "Make2"],
    "models": ["Model1"],
    "trims": ["Trim1"],
    "year": null,
    "yearMin": 2020,
    "yearMax": null,
    "minPrice": null,
    "maxPrice": 50000,
    "drivetrain": "Four Wheel Drive",
    "fuelType": null,
    "bodyType": "Pickup Trucks",
    "transmission": null,
    "doors": null,
    "cylinders": null,
    "exteriorColor": "Black",
    "interiorColor": null,
    "features": ["Seat Massagers", "Tow Hitch"],
    "location": {{
      "zip": null,
      "distance": null,
      "city": null,
      "state": null
    }}
  }}
}}"""

    try:
        client = AsyncOpenAI(api_key=api_key)

        response = await client.chat.completions.create(
            model="gpt-4o-mini",  # Fast and cheap
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Parse this vehicle query: {query}"}
            ],
            temperature=0,
            max_tokens=500
        )

        content = response.choices[0].message.content.strip()

        # Remove markdown code blocks if present
        if content.startswith('```'):
            content = content.split('\n', 1)[-1].rsplit('\n', 1)[0]

        result = json.loads(content)
        result["query"] = query  # Ensure original query is preserved

        return result

    except Exception as e:
        logging.error(f"LLM parsing failed: {e}, falling back to pattern matching")
        return parse_with_patterns(query, catalog)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: parse_vehicle_query.py '<vehicle query>' [use_llm=true]"
        }))
        sys.exit(1)

    query = sys.argv[1]
    use_llm = len(sys.argv) > 2 and sys.argv[2].lower() == 'true'

    # Load filter catalog
    catalog = load_filter_catalog()

    # Get OpenAI API key from env if using LLM
    api_key = None
    if use_llm:
        import os
        api_key = os.environ.get('OPENAI_API_KEY')

    # Parse the query
    if use_llm and api_key:
        # Run async LLM parsing
        result = asyncio.run(parse_with_llm(query, catalog, api_key))
    else:
        # Use pattern matching
        result = parse_with_patterns(query, catalog)

    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

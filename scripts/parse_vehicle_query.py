#!/usr/bin/env python3
"""
Vehicle Query Parser - Per-Retailer Filter Mapping

Converts natural language vehicle queries into retailer-specific filter formats
using LLM calls with each retailer's filter JSON as context.

The LLM generates filters in the exact format each scraper expects, minimizing
adapter work. Each retailer gets filters matching their scraper's input format.

Usage:
    python3 parse_vehicle_query.py "GMC Sierra Denali under $50000"
    python3 parse_vehicle_query.py "black Toyota RAV4 with heated seats"
"""
import asyncio
import json
import sys
import os
import logging
from pathlib import Path
from typing import Optional, Dict, Any

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    from openai import AsyncOpenAI
except ImportError:
    AsyncOpenAI = None

logging.basicConfig(level=logging.ERROR, format='%(message)s', stream=sys.stderr)


def load_all_filter_jsons() -> Dict[str, dict]:
    """Load all retailer filter JSON files."""
    data_dir = Path(__file__).parent / 'data'
    retailers = {
        'autotrader': 'autotrader-filters.json',
        'cargurus': 'cargurus-filters.json',
        'carmax': 'carmax-filters.json',
        'carvana': 'carvana-filters.json',
        'truecar': 'truecar-filters.json'
    }

    filters = {}
    for retailer, filename in retailers.items():
        filepath = data_dir / filename
        if filepath.exists():
            with open(filepath, 'r') as f:
                filters[retailer] = json.load(f)
        else:
            logging.error(f"Warning: {filepath} not found")

    return filters


def build_system_prompt(filters: Dict[str, dict]) -> str:
    """Build system prompt with full filter definitions for each retailer."""

    # Build detailed filter context for each retailer
    retailer_context = []

    for retailer, data in filters.items():
        retailer_name = data.get('retailer', retailer.capitalize())

        # Include the FULL filters JSON so LLM can see exact options
        filters_json = json.dumps(data.get('filters', []), indent=2)

        retailer_context.append(f"""
**{retailer_name}** ({retailer})

Full filters definition:
```json
{filters_json}
```

URL format: {data.get('url_format', {})}
""")

    # Build the prompt with expected output formats for each scraper
    return f"""You are a vehicle search filter mapper. Convert natural language queries into retailer-specific filter formats.

Each retailer's scraper expects a different input format. Generate the exact format each scraper expects.

{''.join(retailer_context)}

**SCRAPER INPUT FORMATS (generate exactly these formats):**

1. **autotrader** - Generate a URL string directly:
   - URL format: https://www.autotrader.com/cars-for-sale/{{color}}/{{make}}/{{model}}/{{trim}}?{{params}}
   - IMPORTANT: Color goes FIRST in the path (before make), not as a query parameter
   - Example with color: https://www.autotrader.com/cars-for-sale/black/gmc/sierra-3500/denali-ultimate?startYear=2023&endYear=2024&searchRadius=500&zip=94002
   - Example without color: https://www.autotrader.com/cars-for-sale/gmc/sierra-3500/denali-ultimate?startYear=2023&endYear=2024&searchRadius=500&zip=94002
   - CRITICAL: zip is REQUIRED when using searchRadius - always include both
   - Make/model/trim should be lowercase with hyphens
   - Color should be lowercase (black, white, gray, etc.) - omit if not specified

2. **cargurus** - Generate a dict with these exact keys:
   {{make, model, zip, trim, yearMin, yearMax, minPrice, maxPrice, exteriorColor, interiorColor, drivetrain, fuelType, transmission, mileageMax}}
   - drivetrain values: "FOUR_WHEEL_DRIVE", "ALL_WHEEL_DRIVE", "FOUR_BY_TWO"
   - fuelType values: "GASOLINE", "DIESEL", "FLEX_FUEL_VEHICLE", "ELECTRIC", "HYBRID"
   - transmission values: "AUTOMATIC", "MANUAL"

3. **carmax** - Generate a dict with these exact keys:
   {{makes, models, trims, colors, bodyType, fuelType, drivetrain, transmission, minPrice, maxPrice, carSize, doors, cylinders, features}}
   - makes, models, trims, colors, features are arrays
   - Other values are strings

4. **carvana** - Generate a dict with these exact keys:
   {{make, model, trims, year, drivetrain, exteriorColor, interiorColor, transmission, fuelType, features}}
   - make, model are strings - use EXACT visible label with SPACES (e.g., "Sierra 3500", NOT "Sierra-3500" or "Sierra 3500HD")
   - trims is an array of trim names - scraper will fuzzy match
   - year is an integer (single year, not range)
   - drivetrain, exteriorColor, interiorColor, transmission, fuelType are optional strings
   - features is an optional array of feature names
   - IMPORTANT: NO "series" parameter - the 1500/2500/3500 is part of the model name
   - IMPORTANT: Model names use SPACES not hyphens - "Sierra 3500" NOT "sierra-3500"
   - IMPORTANT: The "HD" suffix appears in vehicle titles but is NOT in the filter model name

5. **truecar** - Generate a dict with these exact keys:
   {{make, model, trims, startYear, endYear, budget, bodyStyle, drivetrain, fuelType}}
   - make, model are strings - USE FULL MODEL NAME (e.g., "Sierra 3500HD" not "Sierra 3500")
   - trims is an array
   - budget = maxPrice
   - CRITICAL: For truck models, include the full model name with suffix (3500HD, 2500HD, 1500)

**CRITICAL - EXACT VALUE MATCHING:**
- Use ONLY the EXACT filter values from each retailer's filters JSON above
- For makes/models/trims, use the "label" field (what users see in UI), NOT the "value" field
- **Check EACH RETAILER'S filter JSON INDIVIDUALLY:**
  - If the retailer has "Denali Ultimate" available → use "Denali Ultimate"
  - If the retailer only has "Denali" available → use "Denali"
  - Different retailers have different trim options - check each one!
- NEVER make up values that don't exist in the retailer's filter JSON
- **NOTE**: Carvana trims are loaded dynamically from the page - the scraper will fuzzy-match trim names
- For year ranges:
  - AutoTrader: startYear + endYear (both required)
  - CarMax: yearMin + yearMax
  - TrueCar: startYear + endYear
  - CarGurus: yearMin + yearMax
  - Carvana: year (single integer)

**OUTPUT FORMAT:**

Return ONLY JSON:
{{
  "query": "original query",
  "retailers": {{
    "autotrader": "https://www.autotrader.com/...",
    "cargurus": {{"make": "GMC", "model": "Sierra 3500", ...}},
    "carmax": {{"makes": ["GMC"], "models": ["Sierra 3500"], ...}},
    "carvana": {{"make": "GMC", "model": "Sierra 3500", ...}},  // Note: SPACES in model, NO HD suffix
    "truecar": {{"make": "GMC", "model": "Sierra 3500HD", ...}}  // Note: Full model name with HD suffix
  }}
}}
"""


async def parse_with_llm(query: str, filters: Dict[str, dict]) -> Dict[str, Any]:
    """Parse query using LLM with retailer-specific filter contexts."""

    system_prompt = build_system_prompt(filters)
    user_prompt = f"""Map this vehicle search query to retailer-specific filters for all 5 retailers:

Query: "{query}"

Provide the complete filter mapping for all retailers."""

    # Check for API keys
    api_key = os.environ.get('OPENAI_API_KEY')
    base_url = None
    model = "gpt-4o-mini"

    if not api_key:
        # Try GLM API
        api_key = os.environ.get('GLM_API_KEY') or os.environ.get('ZHIPU_API_KEY')
        if api_key:
            base_url = os.environ.get('GLM_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4')
            model = os.environ.get('GLM_MODEL', 'glm-4-plus')
        else:
            # Try other providers
            api_key = os.environ.get('DEEPSEEK_API_KEY')
            if api_key:
                base_url = os.environ.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1')
                model = "deepseek-chat"

    if not api_key:
        return {
            "error": "No API key found. Set OPENAI_API_KEY, GLM_API_KEY, or DEEPSEEK_API_KEY environment variable.",
            "query": query,
            "retailers": {}
        }

    try:
        if base_url:
            client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        else:
            client = AsyncOpenAI(api_key=api_key)

        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0,
            max_tokens=3000
        )

        content = response.choices[0].message.content.strip()

        # Remove markdown code blocks if present
        if content.startswith('```'):
            content = content.split('\n', 1)[-1].rsplit('\n', 1)[0]

        result = json.loads(content)
        result["query"] = query

        return result

    except Exception as e:
        logging.error(f"LLM parsing failed: {e}")
        return {
            "error": f"LLM call failed: {str(e)}",
            "query": query,
            "retailers": {}
        }


def parse_with_patterns_fallback(query: str, filters: Dict[str, dict]) -> Dict[str, Any]:
    """Fallback pattern-based parsing if LLM fails."""
    import re

    query_lower = query.lower()

    # Extract basic info with regex
    makes = []
    models = []
    trims = []
    year_min = None
    year_max = None
    max_price = None
    color = None
    drivetrain = None

    # Year extraction
    year_matches = re.findall(r'(20\d{2})', query)
    if year_matches:
        years = sorted(set(int(y) for y in year_matches))
        if len(years) >= 2:
            year_min = min(years)
            year_max = max(years)
        elif len(years) == 1:
            year_min = years[0]
            year_max = years[0]

    # Price extraction
    price_match = re.search(r'under\s*\$?(\d+)', query_lower)
    if price_match:
        max_price = int(price_match.group(1))

    # Color extraction
    colors = ['black', 'white', 'gray', 'silver', 'blue', 'red', 'green', 'brown', 'beige', 'gold']
    for c in colors:
        if c in query_lower:
            color = c.capitalize()
            break

    # Drivetrain extraction
    if '4wd' in query_lower or '4 wd' in query_lower or 'four wheel drive' in query_lower or '4x4' in query_lower:
        drivetrain = 'FOUR_WHEEL_DRIVE'  # For CarGurus
    elif 'awd' in query_lower or 'all wheel drive' in query_lower:
        drivetrain = 'ALL_WHEEL_DRIVE'
    elif '2wd' in query_lower or '2 wd' in query_lower or '4x2' in query_lower:
        drivetrain = 'FOUR_BY_TWO'

    # Common makes
    common_makes = {
        'gmc': 'GMC', 'ford': 'Ford', 'chevrolet': 'Chevrolet', 'chevy': 'Chevrolet',
        'toyota': 'Toyota', 'honda': 'Honda', 'jeep': 'Jeep', 'ram': 'Ram'
    }
    for make_lower, make_proper in common_makes.items():
        if make_lower in query_lower:
            makes.append(make_proper)

    # Trim extraction (common trim levels)
    gmc_trims = ['Denali Ultimate', 'Denali', 'AT4', 'SLE', 'SLT', 'Pro', 'Elevation']
    ford_trims = ['Platinum', 'King Ranch', 'Lariat', 'Limited', 'XLT', 'XL', 'Tremor', 'Raptor']
    chevy_trims = ['High Country', 'LTZ', 'LT', 'Custom', 'WT', 'Trail Boss', 'Z71']
    ram_trims = ['Limited', 'Longhorn', 'Laramie', 'Big Horn', 'Rebel', 'Tradesman', 'TRX']

    all_trims = gmc_trims + ford_trims + chevy_trims + ram_trims
    for trim in all_trims:
        if trim.lower() in query_lower:
            trims.append(trim)
            break  # Only capture first trim found

    # Common models
    if 'sierra' in query_lower:
        models.append('Sierra 3500HD' if '3500' in query_lower or 'hd' in query_lower else 'Sierra')
    elif 'silverado' in query_lower:
        models.append('Silverado')
    elif 'f-150' in query_lower or 'f150' in query_lower:
        models.append('F-150')

    # Build retailer-specific outputs in scraper-specific formats
    retailers = {}

    # AutoTrader - URL string
    # IMPORTANT: Format is /cars-for-sale/{color}/{make}/{model}/{trim}
    # Color comes FIRST in the path, then make, then model, then trim
    make = makes[0].lower() if makes else 'all'
    model = models[0].lower().replace(' ', '-') if models else 'all'
    autotrader_parts = []
    if color:
        autotrader_parts.append(color.lower())
    autotrader_parts.append(make)
    autotrader_parts.append(model)
    if trims:
        # Add trim to path (slugified: lowercase with hyphens)
        autotrader_parts.append(trims[0].lower().replace(' ', '-'))
    autotrader_url = f"https://www.autotrader.com/cars-for-sale/{'/'.join(autotrader_parts)}?searchRadius=500&zip=94002"
    if year_min:
        autotrader_url += f"&startYear={year_min}"
    if year_max:
        autotrader_url += f"&endYear={year_max}"
    if max_price:
        autotrader_url += f"&maxPrice={max_price}"
    retailers['autotrader'] = autotrader_url

    # CarGurus - dict format
    retailers['cargurus'] = {}
    if makes:
        retailers['cargurus']['make'] = makes[0]
    if models:
        retailers['cargurus']['model'] = models[0]
    retailers['cargurus']['zip'] = '94002'
    retailers['cargurus']['distance'] = 200
    if year_min:
        retailers['cargurus']['yearMin'] = str(year_min)
    if year_max:
        retailers['cargurus']['yearMax'] = str(year_max)
    if trims:
        retailers['cargurus']['trim'] = trims[0]
    if color:
        retailers['cargurus']['exteriorColor'] = color
    if drivetrain:
        retailers['cargurus']['drivetrain'] = drivetrain
    if max_price:
        retailers['cargurus']['maxPrice'] = max_price

    # CarMax - dict format with arrays
    retailers['carmax'] = {}
    if makes:
        retailers['carmax']['makes'] = makes
    if models:
        retailers['carmax']['models'] = models
    if trims:
        retailers['carmax']['trims'] = trims
    if color:
        retailers['carmax']['colors'] = [color]
    if year_min:
        retailers['carmax']['yearMin'] = str(year_min)
    if year_max:
        retailers['carmax']['yearMax'] = str(year_max)
    if drivetrain:
        # Convert to CarMax format
        carmax_drivetrain = drivetrain.replace('_', ' ').title()
        retailers['carmax']['drivetrain'] = carmax_drivetrain
    if max_price:
        retailers['carmax']['maxPrice'] = max_price

    # Carvana - dict format (NO series parameter)
    retailers['carvana'] = {}
    if makes:
        retailers['carvana']['make'] = makes[0]
    if models:
        # Use model as-is (contains the series designation like "Sierra 3500")
        retailers['carvana']['model'] = models[0]
    if trims:
        retailers['carvana']['trims'] = trims
    if year_min:
        retailers['carvana']['year'] = year_min
    if drivetrain:
        carvana_drivetrain = drivetrain.replace('_', ' ')
        retailers['carvana']['drivetrain'] = carvana_drivetrain
    if color:
        retailers['carvana']['exteriorColor'] = color

    # TrueCar - dict format
    retailers['truecar'] = {}
    if makes:
        retailers['truecar']['make'] = makes[0]
    if models:
        retailers['truecar']['model'] = models[0]
    if trims:
        retailers['truecar']['trims'] = trims
    if year_min:
        retailers['truecar']['startYear'] = str(year_min)
    if year_max:
        retailers['truecar']['endYear'] = str(year_max)
    if max_price:
        retailers['truecar']['budget'] = max_price
    if drivetrain:
        truecar_drivetrain = drivetrain.replace('_', ' ').replace('Four Wheel Drive', '4WD').replace('All Wheel Drive', 'AWD')
        retailers['truecar']['drivetrain'] = truecar_drivetrain

    return {
        "query": query,
        "retailers": retailers,
        "method": "pattern_fallback"
    }


async def parse_query_async(query: str, use_llm: bool = True) -> Dict[str, Any]:
    """Parse query asynchronously (for use in async contexts)."""
    filters = load_all_filter_jsons()

    if not filters:
        return {
            "error": "No filter JSONs found in data/ directory",
            "query": query,
            "retailers": {}
        }

    if use_llm:
        result = await parse_with_llm(query, filters)
        if 'error' not in result and result.get('retailers'):
            return result
        # Fall back to pattern matching on error
        logging.error("LLM parsing failed, using pattern fallback")
        return parse_with_patterns_fallback(query, filters)
    else:
        return parse_with_patterns_fallback(query, filters)


def parse_query(query: str, use_llm: bool = True) -> Dict[str, Any]:
    """Parse query (synchronous wrapper)."""
    return asyncio.run(parse_query_async(query, use_llm))


def main():
    """Main entry point for CLI usage."""
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: parse_vehicle_query.py '<vehicle query>' [--use-patterns]"
        }, indent=2))
        sys.exit(1)

    query = sys.argv[1]
    use_patterns = '--use-patterns' in sys.argv or '-p' in sys.argv

    result = parse_query(query, use_llm=not use_patterns)

    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

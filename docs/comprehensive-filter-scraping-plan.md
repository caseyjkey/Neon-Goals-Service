# Comprehensive Vehicle Filter Scraping Plan

## Problem Statement

Current filter JSON files have incomplete model and trim data. To support any vehicle search query, we need comprehensive filter options for all makes, models, and trims across all retailers (AutoTrader, CarGurus, CarMax, Carvana, TrueCar).

## Key Challenges

### 1. **Model Naming Variants**
Different retailers use different naming conventions for the same vehicle:
- **TrueCar**: `sierra-3500hd` (HD appended directly)
- **CarMax**: `Sierra 3500` (no HD in basic listing, HD in trim path)
- **CarGurus**: Uses entity codes, requires dynamic discovery
- **AutoTrader**: `sierra-3500` in path, trim in path segment

### 2. **Dynamic vs Static Filters**
- **Static**: Available in filter JSON (Make, Body Type, Colors, Features)
- **Semi-dynamic**: Options exist but depend on make/model selection (Trims, sometimes Models)
- **Fully dynamic**: Loaded from page during search (Carvana trims, some dealer-specific options)

### 3. **Scale**
- ~40 makes (Acura, Audi, BMW, etc.)
- ~10-30 models per make
- ~5-15 trims per model
- ~5 major retailers
- **Potential combinations**: 40 × 20 × 10 × 5 = **40,000+ filter combinations**

## Recommended Approach

### **Phase 1: Model Variants Documentation** (Immediate, Low Effort)

Add a `model_variants` section to each retailer's filter JSON:

```json
{
  "retailer": "TrueCar",
  "model_variants": {
    "note": "Different model naming patterns across the retailer",
    "sierra": {
      "base": "Sierra",
      "variants": {
        "1500": "Sierra 1500",
        "1500HD": "Sierra 1500HD",  // Some retailers use this
        "2500": "Sierra 2500",
        "2500HD": "Sierra 2500HD",
        "3500": "Sierra 3500",
        "3500HD": "Sierra 3500HD"   // Most common for heavy duty
      },
      "url_format_rules": [
        "Use full model name with HD suffix for trucks: {base} {series}",
        "HD series: 1500HD, 2500HD, 3500HD",
        "Light duty: 1500, 2500, 3500"
      ]
    },
    "f-150": {
      "base": "F-150",
      "variants": {
        "standard": "F-150",
        "lightning": "F-150 Lightning",
        "raptor": "F-150 Raptor"
      }
    }
  }
}
```

**Update LLM prompt** to reference model variants:
```
**CRITICAL - Model Naming for TrueCar:**
- Use FULL model name with suffix: "Sierra 3500HD", "Silverado 2500HD", "F-150"
- Check model_variants in filter JSON for correct naming pattern
- When user says "Sierra 3500", interpret as "Sierra 3500HD" for truck models
```

### **Phase 2: Strategic Scraping** (Targeted, Medium Effort)

Instead of scraping ALL combinations, focus on high-value vehicles:

#### Priority Matrix:
```
High Priority (Top 20 makes × Top 5 models × Popular trims):
- Makes: Ford, Chevrolet, GMC, Toyota, Honda, Ram, Jeep, etc.
- Models: F-150, Silverado, Sierra, RAV4, CR-V, Wrangler, etc.
- Trims: Base, mid-tier, top-tier (XL→Lariat→Platinum for F-150)

Medium Priority:
- Luxury vehicles (BMW, Mercedes, Lexus)
- EVs (Tesla Model 3/Y, Rivian, Lightning)
- Trucks/HD trucks (Sierra 3500HD, Silverado 2500HD)

Low Priority:
- Discontinued models
- Low-volume luxury (<1000 listings nationwide)
- Niche vehicles (smart cars, etc.)
```

#### Scraping Strategy per Retailer:

**AutoTrader** (URL-based):
- Scrape model browse pages: `/cars/ford/f-150/`
- Extract trim options from sidebar
- Store in `autotrader-filters.json`

**CarGurus** (Entity codes):
- Scrape homepage to discover make/model entity codes
- Use search box to discover model options
- Map entity codes to display names
- Store in `cargurus-filters.json`

**CarMax** (Path-based):
- Navigate to `/cars/{make}/`
- Extract models from dropdown/links
- For each model, extract available trims
- Store in `carmax-filters.json`

**TrueCar** (MMT format):
- Scrape `/used-cars-for-sale/listings/{make}/`
- Extract model options from filters
- Note the URL naming pattern (hd appended, etc.)
- Store in `truecar-filters.json`

**Carvana** (Dynamic):
- Trims loaded per-search
- Store common trim patterns in JSON
- Scraper does fuzzy matching at runtime
- No need for comprehensive trim list

### **Phase 3: LLM Prompt Enhancement** (Immediate, Low Effort)

Update `parse_vehicle_query.py` prompt with model mapping logic:

```python
**MODEL NAME MAPPING:**
- For heavy-duty trucks, user may say "Sierra 3500" but mean "Sierra 3500HD"
- Map common abbreviations:
  - Sierra 3500 → Sierra 3500HD (for trucks)
  - Silverado 2500 → Silverado 2500HD (for trucks)
  - F-150 → F-150 (no HD variant for light duty)

- Check each retailer's model_variants in their filter JSON
- Use the URL that appears in that retailer's search URLs
```

### **Phase 4: Automation Script** (Optional, Higher Effort)

Create `scripts/scrape-retailer-filters.py`:

```python
#!/usr/bin/env python3
"""
Comprehensive filter scraper for vehicle retailers

For each retailer:
1. Load list of makes to scrape (priority makes)
2. For each make, discover available models
3. For each model, discover available trims
4. Build/update filter JSON with discovered options
5. Store with timestamp and source URL
"""

import asyncio
import json
from pathlib import Path

# Priority makes covering 80% of searches
PRIORITY_MAKES = [
    "Ford", "Chevrolet", "GMC", "Toyota", "Honda",
    "Jeep", "Ram", "Nissan", "Dodge", "BMW"
]

# Truck models that need special HD handling
TRUCK_MODELS = {
    "GMC": ["Sierra 1500", "Sierra 2500HD", "Sierra 3500HD"],
    "Chevrolet": ["Silverado 1500", "Silverado 2500HD", "Silverado 3500HD"],
    "Ford": ["F-150", "F-250", "F-350"],
    "Ram": ["1500", "2500", "3500"]
}

async def scrape_retailer_filters(retailer: str, makes: list):
    """Scrape filters for a specific retailer"""
    # Implementation per retailer
    pass

async def main():
    # Run all scrapers in parallel
    results = await asyncio.gather(
        scrape_retailer_filters("autotrader", PRIORITY_MAKES),
        scrape_retailer_filters("carmax", PRIORITY_MAKES),
        scrape_retailer_filters("truecar", PRIORITY_MAKES),
        scrape_retailer_filters("cargurus", PRIORITY_MAKES),
    )
```

## Implementation Priority

### **Immediate** (Do Now):
1. ✅ Fix TrueCar model naming (completed)
2. Add `model_variants` section to all filter JSONs
3. Update LLM prompt with model mapping rules

### **Short-term** (Next Sprint):
1. Scrape top 10 makes × top 3 models × all trims
2. Add discovered data to filter JSONs
3. Test with real user queries

### **Long-term** (Ongoing):
1. Periodic re-scraping (filters change quarterly)
2. Add new makes/models as they're released
3. Monitor for retailer UI changes

## Success Metrics

- **Coverage**: Support for top 20 makes × top 5 models = 100 model/trim combinations
- **Accuracy**: LLM generates correct filter values 95%+ of time
- **Maintenance**: Filter JSONs updated quarterly or when retailer UI changes
- **Performance**: Scraper finds 10+ results for common queries within 30 seconds

## File Structure

```
scripts/data/
├── autotrader-filters.json      # Add model_variants section
├── cargurus-filters.json         # Already has good trim data
├── carmax-filters.json           # Add model_variants section
├── carvana-filters.json          # Dynamic, minimal updates
├── truecar-filters.json          # Add model_variants section
└── model-mappings.json           # NEW: Cross-retailer model name mappings
    {
      "canonical_name": "GMC Sierra 3500HD",
      "autotrader": "sierra-3500",
      "cargurus": "Sierra 3500HD",
      "carmax": "Sierra 3500",
      "truecar": "sierra-3500hd",
      "carvana": "Sierra 3500",
      "common_variants": [
        "Sierra 3500 HD",
        "Sierra 3500HD",
        "3500HD"
      ]
    }
```

## Next Steps

1. Review and approve this plan
2. Add `model_variants` section to each filter JSON
3. Create `scripts/scrape-retailer-filters.py` automation script
4. Run initial scrape for priority makes/models
5. Test with real user queries
6. Set up quarterly re-scraping schedule

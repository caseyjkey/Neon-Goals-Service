"""
Model name mappings for car scrapers.

Some websites use different model names for the same vehicle.
For example, "Sierra 3500HD" might be listed as "Sierra 3500" on some sites.

This module provides mapping functions for scrapers to normalize model names.
"""

# Maps models to their canonical names for sites that don't distinguish
# Key: Site name (or 'default' for sites that don't have HD variants)
# Value: dict mapping 'HD' variant models to their non-HD equivalents
SITE_MODEL_MAPPINGS = {
    # Sites that don't have Sierra 3500HD, use Sierra 3500 instead
    'carmax': {
        'Sierra 3500HD': 'Sierra 3500',
        'sierra-3500hd': 'sierra-3500',
    },
    'carvana': {
        'Sierra 3500HD': 'Sierra 3500',
        'sierra-3500hd': 'sierra-3500',
    },
    # Default mapping for sites that don't distinguish HD variants
    'default': {
        # GM Trucks
        'Sierra 1500HD': 'Sierra 1500',
        'Sierra 2500HD': 'Sierra 2500',
        'Sierra 3500HD': 'Sierra 3500',
        'Silverado 1500HD': 'Silverado 1500',
        'Silverado 2500HD': 'Silverado 2500',
        'Silverado 3500HD': 'Silverado 3500',
        # Ford trucks (some sites distinguish, some don't)
        'F-150 HD': 'F-150',
        'F-250 HD': 'F-250',
        'F-350 HD': 'F-350',
        # RAM trucks
        'Ram 1500 Classic': 'Ram 1500',
        'Ram 2500 Classic': 'Ram 2500',
        'Ram 3500 Classic': 'Ram 3500',
    }
}


def normalize_model_for_site(model: str, site: str) -> str:
    """
    Normalize a model name for a specific site.

    If the site has specific mappings, use those. Otherwise, use default mappings.
    Sites that have both variants (AutoTrader, TrueCar, CarGurus) receive the original model.

    Args:
        model: The model name to normalize (e.g., "Sierra 3500HD")
        site: The site name (e.g., "carmax", "carvana", "autotrader")

    Returns:
        The normalized model name for that site.

    Examples:
        >>> normalize_model_for_site("Sierra 3500HD", "carmax")
        "Sierra 3500"
        >>> normalize_model_for_site("Sierra 3500HD", "autotrader")
        "Sierra 3500HD"  # AutoTrader has both, no mapping needed
    """
    site_key = site.lower().replace('-', '').replace('_', '')

    # If site has both variants, don't normalize - return original
    if site_key in SITES_WITH_BOTH_VARIANTS:
        return model

    # Check if site has specific mappings
    if site_key in SITE_MODEL_MAPPINGS:
        mappings = SITE_MODEL_MAPPINGS[site_key]
    else:
        mappings = SITE_MODEL_MAPPINGS['default']

    # Check both original model and slugified version
    slugified = model.lower().replace(' ', '-').replace('_', '-')

    if model in mappings:
        return mappings[model]
    if slugified in mappings:
        return mappings[slugified]

    # No mapping found, return original
    return model


def normalize_models_for_site(models: list, site: str) -> list:
    """
    Normalize a list of model names for a specific site.

    Args:
        models: List of model names to normalize
        site: The site name

    Returns:
        List of normalized model names
    """
    return [normalize_model_for_site(m, site) for m in models]


# Sites that support both Sierra 3500 and Sierra 3500HD
# (no mapping needed, use original model name)
SITES_WITH_BOTH_VARIANTS = {
    'autotrader',
    'truecar',
    'cargurus',
    # Note: CarMax does NOT have separate sierra-3500-hd pages
    # It only has sierra-3500, so HD models are normalized to non-HD
}


def should_normalize_model(model: str, site: str) -> bool:
    """
    Check if a model should be normalized for a given site.

    Sites that have both variants (AutoTrader, TrueCar, CarGurus) should
    receive the original model name to get accurate results.

    Args:
        model: The model name
        site: The site name

    Returns:
        True if model should be normalized, False otherwise
    """
    site_key = site.lower().replace('-', '').replace('_', '')

    # If site has both variants, don't normalize
    if site_key in SITES_WITH_BOTH_VARIANTS:
        return False

    # Check if model has HD variant that needs mapping
    slugified = model.lower().replace(' ', '-').replace('_', '-')
    default_mappings = SITE_MODEL_MAPPINGS['default']

    return model in default_mappings or slugified in default_mappings

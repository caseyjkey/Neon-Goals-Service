import subprocess
import sys
import os
import logging
from typing import Optional, Dict, Any
from fastapi import FastAPI, BackgroundTasks, Request, HTTPException
from fastapi.responses import JSONResponse
import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Scraper Worker", version="0.1.0")

# Base directory for scrapers (relative to worker dir)
SCRAPER_BASE_DIR = "/home/alpha/Development/Neon-Goals-Service"
SCRIPTS_BASE_DIR = os.path.join(SCRAPER_BASE_DIR, "scripts")

# VPN setup
try:
    sys.path.insert(0, SCRIPTS_BASE_DIR)
    from vpn_manager import create_vpn_manager
    VPN_AVAILABLE = True
    _vpn_manager = None
except ImportError:
    VPN_AVAILABLE = False
    _vpn_manager = None


def get_vpn_manager():
    """Get or create the global VPN manager instance."""
    global _vpn_manager
    if _vpn_manager is None and VPN_AVAILABLE:
        _vpn_manager = create_vpn_manager(total_configs=5, config_prefix="v")
    return _vpn_manager

# Scraper script mapping
SCRAPER_SCRIPTS: Dict[str, str] = {
    "cargurus-camoufox": "scrape-cars-camoufox.py",
    "carmax": "scrape-carmax.py",
    "autotrader": "scrape-autotrader.py",
    "truecar": "scrape-truecar.py",
    "carvana": "scrape-carvana-interactive.py",
    # KBB deprecated - uses same Cox Automotive API as AutoTrader
}

# Note: All scrapers now rely on worker for VPN retry on bot detection
# Individual scrapers return None on bot detection, worker retries with VPN


def run_scraper_and_callback(
    scraper_name: str,
    query: str,
    vehicle_filters: Optional[Dict[str, Any]],
    job_id: str,
    callback_url: str
) -> None:
    """
    Run the scraper in a Kitty window and send results back via callback.

    This function runs in a background task after the HTTP response is sent.
    """
    try:
        logger.info(f"Starting scraper: {scraper_name} for job {job_id}")

        # Get the script path
        script_name = SCRAPER_SCRIPTS.get(scraper_name)
        if not script_name:
            raise ValueError(f"Unknown scraper: {scraper_name}")

        script_path = os.path.join(SCRIPTS_BASE_DIR, script_name)

        if not os.path.exists(script_path):
            raise FileNotFoundError(f"Script not found: {script_path}")

        # Build the command using xvfb-run for virtual display
        # This creates a virtual X server with proper resolution (1920x1080x24)
        # which helps avoid bot detection
        python_bin = "/home/alpha/.pyenv/versions/3.12.0/bin/python3.12"

        # Different scrapers expect different parameter formats
        import json as json_mod

        if scraper_name == "carvana" and vehicle_filters:
            # Carvana interactive expects {"structured": {...}} format for filter selection
            filters_json = json_mod.dumps({"structured": vehicle_filters})
            command = [
                "xvfb-run", "--server-args=-screen 0 1920x1080x24",
                python_bin, script_path, filters_json, "5"
            ]
        elif scraper_name in ["cargurus-camoufox", "truecar", "carmax", "autotrader"] and vehicle_filters:
            # CarGurus, TrueCar, CarMax, AutoTrader expect {"structured": {...}} format
            filters_json = json_mod.dumps({"structured": vehicle_filters})
            command = [
                "xvfb-run", "--server-args=-screen 0 1920x1080x24",
                python_bin, script_path, filters_json, "5"
            ]
        else:
            # Fallback to plain query string for scrapers without structured support
            command = [
                "xvfb-run", "--server-args=-screen 0 1920x1080x24",
                python_bin, script_path, f"'{query}'", "5"
            ]

        logger.info(f"Running command: {' '.join(command)}")

        # Run the scraper and capture output
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout (60s wait + scraping)
            env={
                **os.environ,
                "XAUTHORITY": os.environ.get("XAUTHORITY", "/home/alpha/.Xauthority"),
            }
        )

        # Wait a moment for scraper to finish writing to temp file
        import time
        time.sleep(2)

        if result.returncode != 0:
            error_msg = result.stderr or "Unknown error"
            logger.error(f"Scraper failed: {error_msg}")

            # Send error callback
            requests.post(
                callback_url,
                json={
                    "jobId": job_id,
                    "scraper": scraper_name,
                    "status": "error",
                    "error": error_msg,
                    "data": None
                },
                timeout=10
            )
            return

        # Parse the JSON output
        try:
            listings = result.stdout.strip()
            if not listings:
                # Try to read from temp file as fallback
                import glob
                temp_files = glob.glob("/tmp/scraper_output_*.json")
                if temp_files:
                    # Get the most recently modified file
                    latest_file = max(temp_files, key=os.path.getmtime)
                    with open(latest_file, 'r') as f:
                        listings = f.read().strip()
                    logger.info(f"Recovered output from temp file: {latest_file}")
                    # Clean up temp file
                    os.remove(latest_file)

            if not listings:
                raise ValueError("Empty output from scraper")

            data = eval(listings)  # Safe here as we control the scraper output

            if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict) and "error" in data[0]:
                raise ValueError(data[0]["error"])

            logger.info(f"Scraper returned {len(data)} listings")

            # Send success callback
            requests.post(
                callback_url,
                json={
                    "jobId": job_id,
                    "scraper": scraper_name,
                    "status": "success",
                    "error": None,
                    "data": data
                },
                timeout=10
            )

        except Exception as e:
            logger.error(f"Failed to parse scraper output: {e}")

            # Send error callback
            requests.post(
                callback_url,
                json={
                    "jobId": job_id,
                    "scraper": scraper_name,
                    "status": "error",
                    "error": str(e),
                    "data": None
                },
                timeout=10
            )

    except subprocess.TimeoutExpired:
        error_msg = f"Scraper timeout after 180 seconds"
        logger.error(error_msg)

        requests.post(
            callback_url,
            json={
                "jobId": job_id,
                "scraper": scraper_name,
                "status": "error",
                "error": error_msg,
                "data": None
            },
            timeout=10
        )

    except Exception as e:
        logger.error(f"Failed to run scraper: {e}")

        try:
            requests.post(
                callback_url,
                json={
                    "jobId": job_id,
                    "scraper": scraper_name,
                    "status": "error",
                    "error": str(e),
                    "data": None
                },
                timeout=10
            )
        except Exception as callback_error:
            logger.error(f"Failed to send error callback: {callback_error}")


@app.get("/health")
async def health_check():
    """Health check endpoint for systemd monitoring."""
    return {"status": "healthy", "service": "scraper-worker"}


@app.post("/run/{scraper_name}")
async def trigger_scraper(
    scraper_name: str,
    request: Request,
    background_tasks: BackgroundTasks
):
    """
    Trigger a scraper to run in a Kitty terminal window.

    The scraper runs asynchronously and calls back with results when complete.
    """
    # Validate scraper name
    if scraper_name not in SCRAPER_SCRIPTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown scraper: {scraper_name}. Available: {list(SCRAPER_SCRIPTS.keys())}"
        )

    # Get request body
    body = await request.json()

    job_id = body.get("jobId")
    query = body.get("query")
    vehicle_filters = body.get("vehicleFilters")

    if not job_id:
        raise HTTPException(status_code=400, detail="Missing required field: jobId")

    if not query:
        raise HTTPException(status_code=400, detail="Missing required field: query")

    # Build callback URL from origin IP
    origin_ip = request.client.host
    callback_url = f"http://{origin_ip}:3001/scrapers/callback"

    logger.info(f"Dispatching scraper: {scraper_name} for job {job_id}")
    logger.info(f"Query: {query}")
    logger.info(f"Callback URL: {callback_url}")

    # Add background task to run scraper
    background_tasks.add_task(
        run_scraper_and_callback,
        scraper_name,
        query,
        vehicle_filters,
        job_id,
        callback_url
    )

    return {
        "status": "dispatched",
        "jobId": job_id,
        "scraper": scraper_name,
        "message": f"Scraper {scraper_name} is running in background"
    }


@app.post("/run-all")
async def trigger_all_scrapers(
    request: Request,
    background_tasks: BackgroundTasks
):
    """
    Run all vehicle scrapers in parallel and combine results into one callback.

    This is the preferred method for vehicle searches as it aggregates results
    from all sources (CarGurus, CarMax, AutoTrader, TrueCar, Carvana).
    """
    # Get request body
    body = await request.json()

    job_id = body.get("jobId")
    query = body.get("query")
    vehicle_filters = body.get("vehicleFilters")

    if not job_id:
        raise HTTPException(status_code=400, detail="Missing required field: jobId")

    if not query:
        raise HTTPException(status_code=400, detail="Missing required field: query")

    # Build callback URL from origin IP
    origin_ip = request.client.host
    callback_url = f"http://{origin_ip}:3001/scrapers/callback"

    logger.info(f"Dispatching ALL scrapers for job {job_id}")
    logger.info(f"Query: {query}")
    logger.info(f"Callback URL: {callback_url}")

    # Add background task to run all scrapers
    background_tasks.add_task(
        run_all_scrapers_and_callback,
        query,
        vehicle_filters,
        job_id,
        callback_url
    )

    return {
        "status": "dispatched",
        "jobId": job_id,
        "scrapers": list(SCRAPER_SCRIPTS.keys()),
        "message": f"Running all {len(SCRAPER_SCRIPTS)} scrapers in background"
    }


def run_all_scrapers_and_callback(
    query: str,
    vehicle_filters: Optional[Dict[str, Any]],
    job_id: str,
    callback_url: str
) -> None:
    """
    Run all scrapers in parallel and combine results into one callback.
    """
    import asyncio
    import concurrent.futures

    all_results = []
    errors = []

    logger.info(f"Starting all scrapers for job {job_id}")

    # Run all scrapers sequentially (one at a time) for better debugging
    for scraper_name in SCRAPER_SCRIPTS.keys():
        logger.info(f"Starting {scraper_name}...")
        # Add breathing room between scraper launches
        import time
        time.sleep(2)
        try:
            result = run_single_scraper(
                scraper_name,
                query,
                vehicle_filters,
                job_id
            )
            if result and len(result) > 0:
                all_results.extend(result)
                logger.info(f"✅ {scraper_name}: {len(result)} listings")
            else:
                logger.warn(f"⚠️ {scraper_name}: No results")
        except Exception as e:
            error_msg = f"{scraper_name}: {str(e)}"
            errors.append(error_msg)
            logger.error(f"❌ {error_msg}")

    logger.info(f"Total listings from all scrapers: {len(all_results)}")

    # Cleanup: Disable ALL VPNs after all scrapers finish
    # This returns to residential IP for next job
    vpn = get_vpn_manager()
    if vpn:
        logger.info("Cleaning up ALL VPNs after job finished, returning to residential IP...")
        vpn.cleanup_all()

    # Send combined callback
    try:
        if len(all_results) > 0:
            requests.post(
                callback_url,
                json={
                    "jobId": job_id,
                    "scraper": "all",
                    "status": "success",
                    "error": None,
                    "data": all_results
                },
                timeout=10
            )
            logger.info(f"✅ Sent combined callback with {len(all_results)} listings")
        else:
            # No results from any scraper
            error_message = f"No listings found. Errors: {'; '.join(errors) if errors else 'All scrapers returned empty'}"
            requests.post(
                callback_url,
                json={
                    "jobId": job_id,
                    "scraper": "all",
                    "status": "error",
                    "error": error_message,
                    "data": None
                },
                timeout=10
            )
            logger.error(f"❌ Sent error callback: {error_message}")

    except Exception as callback_error:
        logger.error(f"Failed to send callback: {callback_error}")


def run_single_scraper(
    scraper_name: str,
    query: str,
    vehicle_filters: Optional[Dict[str, Any]],
    job_id: str,
    use_vpn: bool = False
) -> list:
    """
    Run a single scraper and return its results (without callback).

    Used by run_all_scrapers_and_callback to run scrapers in parallel.
    Handles bot detection and automatically retries with VPN rotation.
    """
    max_vpn_retries = 3
    vpn = get_vpn_manager() if VPN_AVAILABLE else None

    for attempt in range(max_vpn_retries + 1):
        should_use_vpn = use_vpn or (attempt > 0 and vpn)

        if attempt > 0 and vpn:
            logger.info(f"{scraper_name}: Bot detected, rotating VPN (attempt {attempt}/{max_vpn_retries})...")
            vpn.rotate_vpn()
            import time
            time.sleep(3)  # Give VPN time to settle

        try:
            logger.info(f"Starting scraper: {scraper_name}" + (f" (VPN: {vpn.current_interface})" if should_use_vpn else ""))

            # Get the script path
            script_name = SCRAPER_SCRIPTS.get(scraper_name)
            if not script_name:
                raise ValueError(f"Unknown scraper: {scraper_name}")

            script_path = os.path.join(SCRIPTS_BASE_DIR, script_name)

            if not os.path.exists(script_path):
                raise FileNotFoundError(f"Script not found: {script_path}")

            # Build the command using xvfb-run for virtual display
            # This creates a virtual X server with proper resolution (1920x1080x24)
            # which helps avoid bot detection
            python_bin = "/home/alpha/.pyenv/versions/3.12.0/bin/python3.12"

            # Different scrapers expect different parameter formats
            import json as json_mod

            if scraper_name == "carvana" and vehicle_filters:
                # Carvana interactive expects {"structured": {...}} format for filter selection
                filters_json = json_mod.dumps({"structured": vehicle_filters})
                command = [
                    "xvfb-run", "--server-args=-screen 0 1920x1080x24",
                    python_bin, script_path, filters_json, "5"
                ]
            elif scraper_name in ["cargurus-camoufox", "truecar", "carmax", "autotrader"] and vehicle_filters:
                # CarGurus, TrueCar, CarMax, AutoTrader expect {"structured": {...}} format
                filters_json = json_mod.dumps({"structured": vehicle_filters})
                command = [
                    "xvfb-run", "--server-args=-screen 0 1920x1080x24",
                    python_bin, script_path, filters_json, "5"
                ]
            else:
                # Fallback to plain query string for scrapers without structured support
                command = [
                    "xvfb-run", "--server-args=-screen 0 1920x1080x24",
                    python_bin, script_path, f"'{query}'", "5"
                ]

            logger.info(f"Running command: {' '.join(command)}")

            # Run the scraper and capture output
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout (60s wait + scraping) per scraper
                env={
                    **os.environ,
                    "DISPLAY": os.environ.get("DISPLAY", ":0"),
                    "XAUTHORITY": os.environ.get("XAUTHORITY", "/home/alpha/.Xauthority"),
                }
            )

            # Wait a moment for scraper to finish writing to temp file
            import time
            time.sleep(2)

            if result.returncode != 0:
                error_msg = result.stderr or "Unknown error"
                logger.error(f"Scraper {scraper_name} failed: {error_msg}")

                # Check for bot detection indicators in stderr
                bot_indicators = ["403", "forbidden", "access denied", "bot detected", "blocked"]
                if any(indicator.lower() in error_msg.lower() for indicator in bot_indicators):
                    if attempt < max_vpn_retries and vpn:
                        logger.warning(f"{scraper_name}: Bot detection detected, will retry with VPN...")
                        continue  # Retry with VPN
                    return []

                return []

            # Parse the JSON output
            listings = result.stdout.strip()
            if not listings:
                logger.warn(f"Empty output from {scraper_name}")
                # Try to read from temp file as fallback
                try:
                    import glob
                    temp_files = glob.glob("/tmp/scraper_output_*.json")
                    if temp_files:
                        # Get the most recently modified file
                        latest_file = max(temp_files, key=os.path.getmtime)
                        with open(latest_file, 'r') as f:
                            listings = f.read().strip()
                        logger.info(f"Recovered output from temp file for {scraper_name}: {latest_file}")
                        # Clean up temp file
                        os.remove(latest_file)
                except Exception as e:
                    logger.warn(f"Could not read from temp file: {e}")

                if not listings:
                    return []

            data = eval(listings)  # Safe here as we control the scraper output

            # Check for bot detection in scraper output
            if data is None:
                logger.warning(f"{scraper_name}: Returned None (bot detection)")
                if attempt < max_vpn_retries and vpn:
                    continue  # Retry with VPN
                return []

            if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
                if "error" in data[0]:
                    error = data[0]["error"]
                    logger.error(f"{scraper_name} returned error: {error}")

                    # Check for bot detection in error message
                    bot_indicators = ["403", "forbidden", "bot", "blocked", "access denied", "restricted"]
                    if any(indicator.lower() in error.lower() for indicator in bot_indicators):
                        if attempt < max_vpn_retries and vpn:
                            logger.warning(f"{scraper_name}: Bot detection in error, will retry with VPN...")
                            continue  # Retry with VPN
                    return []

            logger.info(f"{scraper_name} returned {len(data) if data else 0} listings")
            return data if data else []

        except subprocess.TimeoutExpired:
            logger.error(f"{scraper_name} timeout after 300 seconds")
            return []
        except Exception as e:
            logger.error(f"Failed to run {scraper_name}: {e}")
            return []

    # All retries exhausted
    logger.error(f"{scraper_name}: All {max_vpn_retries + 1} attempts failed")
    return []


@app.get("/")
async def root():
    """Root endpoint with service information."""
    return {
        "service": "Scraper Worker",
        "version": "0.1.0",
        "available_scrapers": list(SCRAPER_SCRIPTS.keys()),
        "endpoints": {
            "health": "/health",
            "run_scraper": "/run/{scraper_name}",
            "run_all": "/run-all",
            "docs": "/docs"
        }
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)

import subprocess
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
SCRAPER_BASE_DIR = "/home/alpha/Development/neon-goals-service"
SCRIPTS_BASE_DIR = os.path.join(SCRAPER_BASE_DIR, "scripts")

# Scraper script mapping
SCRAPER_SCRIPTS: Dict[str, str] = {
    "cargurus-camoufox": "scrape-cars-camoufox.py",
    "carmax": "scrape-carmax.py",
    "autotrader": "scrape-autotrader.py",
    "kbb": "scrape-kbb.py",
    "truecar": "scrape-truecar.py",
    "carvana": "scrape-carvana-interactive.py",
    "browser-use": "scrape-cars.py",
}


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

        # Build the command for Kitty with instance-group and window class
        # --class tags the window so i3 can recognize it
        # --instance-group allows multiple Kitty windows to share the same process group
        command = [
            "kitty",
            "--class", "scraper-window",  # Tag window for i3 recognition
            "--single-instance",
            "--instance-group", "scrapers",
            "python3", script_path, query, "5"  # 5 = max results
        ]

        # Add vehicle filters as JSON argument if provided
        if vehicle_filters:
            command.append(str(vehicle_filters))

        logger.info(f"Running command: {' '.join(command)}")

        # Run the scraper and capture output
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=180,  # 3 minute timeout
            env={
                **os.environ,
                "DISPLAY": os.environ.get("DISPLAY", ":0"),
                "XAUTHORITY": os.environ.get("XAUTHORITY", "/home/alpha/.Xauthority"),
            }
        )

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
            "docs": "/docs"
        }
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)

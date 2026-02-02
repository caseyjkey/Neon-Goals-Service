# Neon Goals Service

NestJS backend service for goal tracking and car listing scraping.

## Features

- 🎯 Goal tracking with GitHub OAuth
- 🚗 Real-time car scraping from multiple sources
- 🦊 Camoufox-based scraping (free, stealth browser)
- 🔄 Automated candidate acquisition via cron jobs

## Supported Car Listing Sites

### Working with Camoufox (Free)
- ✅ **CarGurus** - uses camoufox
- ✅ **CarMax** - uses camoufox
- ✅ **KBB (Kelley Blue Book)** - uses camoufox
- ✅ **TrueCar** - uses camoufox
- ✅ **Carvana** - uses camoufox
- ❌ CarFax - not a listing marketplace (vehicle history reports only)

### Requires Browser-Use (AI, ~$1.60/scrape)
- ⚠️ **AutoTrader** - detects camoufox
- ⚠️ **Edmunds** - detects camoufox
- ⚠️ **Cars.com** - detects camoufox

## Setup

### Prerequisites
- Node.js 18+
- Python 3.12+
- PostgreSQL
- Camoufox: `pip install -U camoufox[geoip]`

### Installation

```bash
# Install dependencies
npm install

# Install Python dependencies
pip install -U camoufox[geoip]
python3 -m camoufox fetch

# Setup database
npx prisma migrate dev

# Configure environment
cp .env.example .env
# Edit .env with your credentials
```

### Environment Variables

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/neon_goals
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GITHUB_CALLBACK_URL=http://localhost:3001/auth/github/callback
```

## Running Locally

```bash
# Development mode (with VPN for IP-based scraping)
npm run start:dev

# Production mode
npm run build
npm run start:prod
```

## Car Scraping Scripts

### CarGurus
```bash
python3 scripts/scrape-cars-camoufox.py "honda civic" 5
```

### CarMax
```bash
python3 scripts/scrape-carmax.py "honda civic" 5
```

### KBB (Kelley Blue Book)
```bash
python3 scripts/scrape-kbb.py "honda civic" 5
```

### TrueCar
```bash
python3 scripts/scrape-truecar.py "honda civic" 5
```

### Carvana
```bash
python3 scripts/scrape-carvana.py "honda civic" 5
```

### Browser-Use (fallback for blocked sites)
```bash
python3 scripts/scrape-cars.py "honda civic" 3
```

### AutoTrader (Chrome CDP or Camoufox)
```bash
# Requires Chrome with remote debugging enabled:
# google-chrome --remote-debugging-port=9222

python3 scripts/scrape-autotrader.py "GMC Sierra Denali" 5
```

## Testing Scrapers

A test script is included to verify all scrapers are working correctly:

```bash
# Run all scraper tests
python3 scripts/test-scrapers.py
```

The test script will:
- Test each scraper with a sample query
- Report the number of results found
- Show a sample result from each scraper
- Provide a summary of pass/fail/empty results

**Test output:**
```
============================================================
Car Scraper Test Suite
============================================================

Testing: AutoTrader (CDP) - GMC Sierra Denali...
  ✓ PASS - Found 5 results
    Sample: New 2025 GMC Sierra 3500 Denali - $89,415

Testing: CarMax - GMC Sierra...
  ✓ PASS - Found 3 results
    Sample: 2023 GMC Sierra 1500 Denali - $65,998

...

============================================================
Summary:
============================================================
  Passed: 3
  Empty:  1
  Failed: 0
  Skipped: 0
  Total:  4
```

## Production Deployment

### Important: Camoufox Display Requirements

**Camoufox requires a display to run** (headless mode crashes). For production servers without displays:

#### Option 1: Xvfb (Virtual Display)

Install Xvfb:
```bash
# Ubuntu/Debian
sudo apt-get install xvfb

# Start Xvfb (using 1366x768 for laptop compatibility)
Xvfb :99 -screen 0 1366x768x24 &
export DISPLAY=:99
```

Run scrapers with virtual display:
```bash
DISPLAY=:99 python3 scripts/scrape-carmax.py "honda civic" 5
```

#### Option 2: Docker with Xvfb

```dockerfile
FROM node:18

# Install Xvfb for camoufox
RUN apt-get update && apt-get install -y xvfb

# Your app setup...

# Run with virtual display
CMD ["sh", "-c", "Xvfb :99 -screen 0 1366x768x24 & export DISPLAY=:99 && npm run start:prod"]
```

#### Option 3: Systemd Service

```ini
[Unit]
Description=Neon Goals Service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/neon-goals-service
Environment="DISPLAY=:99"
ExecStartPre=/usr/bin/Xvfb :99 -screen 0 1366x768x24 &
ExecStart=/usr/bin/npm run start:prod
Restart=always

[Install]
WantedBy=multi-user.target
```

### Current Setup (Development)

For now, the service runs **locally** with visible browser windows. This is fine for:
- Development and testing
- Manual scraping
- Low-volume usage

Production deployment with Xvfb can be configured later when automating at scale.

## Architecture

```
src/
├── modules/
│   ├── auth/          # GitHub OAuth
│   ├── goals/         # Goal CRUD
│   ├── scraper/       # Car scraping service
│   └── users/         # User management
├── config/            # Database config
└── main.ts            # App entry point

scripts/
├── scrape-cars-camoufox.py   # CarGurus (camoufox)
├── scrape-carmax.py          # CarMax (camoufox)
├── scrape-kbb.py             # KBB (camoufox)
├── scrape-truecar.py         # TrueCar (camoufox)
├── scrape-carvana.py         # Carvana (camoufox)
└── scrape-cars.py            # Multi-site (browser-use, AI)
```

## API Endpoints

- `GET /auth/github` - GitHub OAuth login
- `GET /auth/github/callback` - OAuth callback
- `GET /goals` - List user goals
- `POST /goals` - Create goal
- `PUT /goals/:id` - Update goal
- `DELETE /goals/:id` - Delete goal
- `POST /goals/:id/deny-candidate` - Deny a candidate
- `POST /goals/:id/restore-candidate` - Restore denied candidate

## Cron Jobs

The scraper service runs automated jobs:
- **Daily**: Refresh active goal candidates
- **On-demand**: Process pending scrape jobs

## Cost Optimization

**Free** (with camoufox):
- CarGurus, CarMax, KBB, TrueCar, Carvana: $0/scrape

**Paid** (with browser-use):
- AutoTrader, Edmunds, Cars.com: ~$1.60/scrape (only when needed)

**Strategy**: Use camoufox for all major sites (free), fallback to browser-use only for sites that detect camoufox.

## Troubleshooting

### "Target page closed" error
- **Cause**: Camoufox crashes in headless mode
- **Fix**: Set `headless=False` or use Xvfb

### IP banned / CAPTCHA
- **Cause**: Too many requests from same IP
- **Fix**: Use VPN or rotate IPs

### Browser window doesn't appear
- **Cause**: No X display available
- **Fix**: Check `$DISPLAY` environment variable or use Xvfb

## License

MIT

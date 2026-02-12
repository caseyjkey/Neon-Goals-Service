# Neon Goals Service

NestJS backend service for tracking financial, action, and item goals scraping. Distributed architecture!
Integrate your specialized goal agents into frameworks such as OpenClaw, Clawdbot, or Nanobot to build your persona.

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
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/neon_goals

# GitHub OAuth
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GITHUB_CALLBACK_URL=http://localhost:3001/auth/github/callback

# OpenAI (for AI chat features)
OPENAI_API_KEY=your_openai_api_key

# Agent API Key (for agent-to-agent communication)
# Generate with: openssl rand -base64 32
AGENT_API_KEY=your_generated_api_key_here
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

## Authentication

The API supports two authentication methods for accessing protected endpoints. Both methods provide equal access to endpoints but differ in user context.

### 1. JWT Authentication (User Access)

For user-facing requests, authenticate via GitHub OAuth or email/password login.

#### How JWT Works

1. **Login**: User authenticates via OAuth or email/password
2. **Token Issuance**: Server issues a JWT token valid for 7 days
3. **Token Storage**: Client stores the token (localStorage, cookies, etc.)
4. **Authenticated Requests**: Include token in `Authorization: Bearer <token>` header

#### JWT Login Flow

```bash
# Option 1: GitHub OAuth
GET https://your-domain.com/auth/github

# Option 2: Email/Password Login
POST https://your-domain.com/auth/login
{
  "email": "user@example.com",
  "password": "SecurePassword123"
}

# Response includes JWT token:
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "user_id",
    "name": "User Name",
    "email": "user@example.com"
  }
}
```

#### Using JWT for Authenticated Requests

```bash
# Include JWT token in Authorization header
curl -X GET https://your-domain.com/goals \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# The token identifies the user, so endpoints return user-specific data
curl -X GET https://your-domain.com/chats \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
# Returns: User's chats with their messages
```

#### JWT Authorization Behavior

- **User Context**: JWT tokens contain user ID, email, name
- **Data Scope**: Endpoints return data specific to the authenticated user
- **Token Expiration**: 7 days from issuance
- **Refresh**: Re-login to get a new token after expiration

---

### 2. API Key Authentication (Agent Access)

For agent-to-agent communication, webhooks, and automated integrations.

#### How API Key Works

1. **Key Generation**: Generate a secure random key (32-byte base64)
2. **Configuration**: Add key to server's `AGENT_API_KEY` environment variable
3. **Authenticated Requests**: Include key in `X-API-Key` header
4. **Agent Context**: Server identifies requests as agent-originated

#### Generate and Configure API Key

```bash
# Step 1: Generate a secure random key
openssl rand -base64 32
# Output: Ce4QAMETH3m1pBf9yt8TCZY6ZkF8KQy0R+JbQH3K3Pk=

# Step 2: Add to .env file
echo "AGENT_API_KEY=Ce4QAMETH3m1pBf9yt8TCZY6ZkF8KQy0R+JbQH3K3Pk=" >> .env

# Step 3: Restart server to load new environment variable
npm run start:dev
```

#### Using API Key for Authenticated Requests

```bash
# Include API key in X-API-Key header
curl -X GET https://your-domain.com/chats \
  -H "X-API-Key: Ce4QAMETH3m1pBf9yt8TCZY6ZkF8KQy0R+JbQH3K3Pk="

# Query goals as an agent
curl -X GET https://your-domain.com/goals \
  -H "X-API-Key: Ce4QAMETH3m1pBf9yt8TCZY6ZkF8KQy0R+JbQH3K3Pk="

# Send message to overview specialist
curl -X POST https://your-domain.com/ai/overview/chat \
  -H "X-API-Key: Ce4QAMETH3m1pBf9yt8TCZY6ZkF8KQy0R+JbQH3K3Pk=" \
  -H "Content-Type: application/json" \
  -d '{"message": "What should I work on today?"}'
```

#### API Key Authorization Behavior

- **Agent Context**: API key authenticates as a generic agent (userId: "agent")
- **Data Scope**: Endpoints return agent-specific data (empty/neutral state)
  - `/chats` returns empty structure (no user history)
  - `/goals` returns empty array (agent has no goals)
- **No Expiration**: API keys don't expire unless changed in server configuration
- **Shared Access**: All API key users share the same "agent" identity

#### When to Use API Keys

- **Automated Scripts**: Scheduled tasks, cron jobs
- **Webhook Integration**: External services triggering actions
- **Agent-to-Agent**: Multiple AI agents communicating
- **Testing**: Automated tests that don't require user accounts

---

### Authorization Comparison

| Aspect | JWT Authentication | API Key Authentication |
|--------|-------------------|------------------------|
| **User Identity** | Specific user (with id, email, name) | Generic agent (userId: "agent") |
| **Data Access** | User's own data only | Agent-neutral/empty data |
| **Use Case** | Interactive user sessions | Automated agents, scripts |
| **Token Source** | Login endpoint | Environment variable |
| **Expiration** | 7 days | No expiration (unless changed) |
| **Header Name** | `Authorization: Bearer <token>` | `X-API-Key: <key>` |
| **Rate Limits** | Per-user | Per-agent |

---

### Protected Endpoints

All endpoints listed below accept **either** JWT **or** API Key authentication:

#### Chat Endpoints
| Endpoint | Description | JWT Returns | API Key Returns |
|----------|-------------|-------------|-----------------|
| `GET /chats` | Structured chat list | User's chats | Empty structure |
| `GET /chats/overview` | Get overview chat | User's overview chat | New agent chat |
| `GET /chats/category/:categoryId` | Get category specialist chat | User's category chat | New agent chat |
| `POST /chats/:id/messages` | Add message to chat | Adds to user's chat | Adds to agent's chat |
| `PUT /chats/:chatId/messages/:messageId` | Edit message | Edits user's message | Edits agent's message |

#### Goal Endpoints
| Endpoint | Description | JWT Returns | API Key Returns |
|----------|-------------|-------------|-----------------|
| `GET /goals` | List goals | User's goals | Empty array |
| `GET /goals/:id` | Get goal details | User's goal (if owned) | 403 Forbidden |
| `POST /goals/item` | Create item goal | Creates for user | Creates for agent |
| `POST /goals/finance` | Create finance goal | Creates for user | Creates for agent |
| `POST /goals/action` | Create action goal | Creates for user | Creates for agent |
| `PATCH /goals/:id` | Update goal | Updates user's goal (if owned) | 403 Forbidden |
| `DELETE /goals/:id` | Delete goal | Deletes user's goal (if owned) | 403 Forbidden |

#### AI Specialist Endpoints
| Endpoint | Description | JWT Context | API Key Context |
|----------|-------------|-------------|-----------------|
| `POST /ai/overview/chat` | Overview specialist chat | User's goal context | Agent context |
| `POST /ai/specialist/category/:categoryId/chat` | Category specialist chat | User's category goals | Agent context |
| `POST /ai/overview/chat/stream` | Streaming overview chat | User's goal context | Agent context |

---

### Error Responses

#### No Authentication Provided
```json
{
  "message": "No authentication provided",
  "error": "Unauthorized",
  "statusCode": 401
}
```

#### Invalid JWT Token
```json
{
  "message": "Invalid or expired JWT token",
  "error": "Unauthorized",
  "statusCode": 401
}
```

#### Invalid API Key
```json
{
  "message": "Invalid API key",
  "error": "Unauthorized",
  "statusCode": 401
}
```

#### Accessing Other User's Data (JWT)
```json
{
  "message": "Goal not found",
  "error": "NotFound",
  "statusCode": 404
}
```
Note: For security, the API returns "not found" rather than "access denied" when accessing other users' resources.

## API Endpoints

### Authentication
- `GET /auth/github` - GitHub OAuth login
- `GET /auth/github/callback` - OAuth callback
- `POST /auth/login` - Email/password login
- `POST /auth/register` - Register new user

### Goals
- `GET /goals` - List user goals
- `GET /goals/:id` - Get single goal
- `POST /goals/item` - Create item goal
- `POST /goals/finance` - Create finance goal
- `POST /goals/action` - Create action goal
- `PATCH /goals/:id` - Update goal
- `DELETE /goals/:id` - Delete goal
- `POST /goals/:id/deny-candidate` - Deny a candidate
- `POST /goals/:id/restore-candidate` - Restore denied candidate

### Chats (Agent Discovery)
- `GET /chats` - Structured chat list for agents
- `GET /chats/overview` - Get or create overview chat
- `GET /chats/category/:categoryId` - Get or create category specialist chat
- `POST /chats/:id/messages` - Add message to chat
- `PUT /chats/:chatId/messages/:messageId` - Edit message

### AI Specialists
- `POST /ai/overview/chat` - Non-streaming overview chat
- `POST /ai/overview/chat/stream` - Streaming overview chat (SSE)
- `POST /ai/overview/chat/stop` - Stop active stream
- `POST /ai/specialist/category/:categoryId/chat` - Non-streaming specialist chat
- `POST /ai/specialist/category/:categoryId/chat/stream` - Streaming specialist chat (SSE)
- `POST /ai/specialist/category/:categoryId/chat/stop` - Stop specialist stream

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

# Neon Goals Service - Development Guide

## Overview

NestJS backend service for the Neon Goals application. Provides REST APIs for user authentication, goal management, AI chat features, and vehicle scraping across multiple retailers.

---

## Table of Contents

- [Authentication](#authentication)
- [Vehicle Scraping Architecture](#vehicle-scraping-architecture)
- [AI Agent Integration](#ai-agent-integration)
- [API Endpoints](#api-endpoints)
- [Database Schema](#database-schema)
- [Development](#development)

---

## Authentication

### Supported Methods

1. **GitHub OAuth** - Production authentication method
2. **Email/Password** - Additional authentication (requires email verification)
3. **Demo Mode** - Local-only development (no backend call)

### Email/Password Flow

1. User registers → verification token generated
2. User receives email with verification link (TODO: Mailgun integration)
3. User verifies email → can now login
4. Login returns JWT token (7-day expiration)

### Test User

For development and testing, a pre-verified test user is created via seed script:

| Credential | Value |
|------------|-------|
| Email | `test@example.com` |
| Password | `Test@1234` |
| Name | `Test User` |

**Note**: Credentials are stored in `.env` as `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, `TEST_USER_NAME`.

### Password Requirements

- Minimum 8 characters
- At least 1 uppercase letter (A-Z)
- At least 1 lowercase letter (a-z)
- At least 1 number (0-9)
- At least 1 special character (!@#$%^&* etc.)

---

## Vehicle Scraping Architecture

### System Overview

The vehicle scraping system uses a **hybrid approach** combining:
1. **LLM-based filter generation** - Converts natural language to retailer-specific filters
2. **Multi-retailer scrapers** - Separate scrapers for AutoTrader, CarGurus, CarMax, Carvana, TrueCar
3. **Worker-based execution** - Scrapers run asynchronously on a worker service
4. **VPN rotation** - Bot detection handling with automatic retry

### Filter Strategy

#### Deprecated: `searchFilters` (Generic Format)

The old generic filter format has been deprecated for vehicles. Example:
```json
{
  "makes": ["GMC"],
  "models": ["Sierra 3500HD"],
  "trims": ["Denali Ultimate"],
  "yearMin": 2023,
  "yearMax": 2024
}
```

#### Current: `retailerFilters` (Retailer-Specific)

Each retailer has its own filter format stored in separate JSON files:

| Retailer | Filter JSON | Location |
|----------|-------------|----------|
| AutoTrader | `autotrader-filters.json` | `scripts/data/` |
| CarMax | `carmax-filters.json` | `scripts/data/` |
| Carvana | `carvana-filters.json` | `scripts/data/` |
| CarGurus | `cargurus-filters.json` | `scripts/data/` |
| TrueCar | `truecar-filters.json` | `scripts/data/` |

**Key insight:** Each retailer's JSON defines:
- Available filters and their valid values
- URL structure (path-based vs query parameters)
- Value formats (labels vs internal codes)
- Interactive vs URL-based search

### LLM Filter Generation

#### Python Script: `parse_vehicle_query.py`

**Location:** `/home/trill/Development/neon-goals-service/scripts/parse_vehicle_query.py`

**Process:**
1. User provides natural language query (e.g., "2023-2024 GMC Sierra 3500HD Denali Ultimate black 4WD under $100000 within 500 miles of 94002")
2. Script loads all 5 retailer filter JSONs as context
3. LLM generates retailer-specific filters for each retailer
4. Returns structured output:

```json
{
  "query": "original query string",
  "retailers": {
    "autotrader": {
      "url": "https://www.autotrader.com/cars-for-sale/gmc/sierra-3500hd/denali-ultimate?startYear=2023&endYear=2024",
      "filters": {
        "url_params": {"startYear": "2023", "endYear": "2024"},
        "body_params": {},
        "path_components": {"make": "gmc", "model": "sierra-3500hd", "trim": "denali-ultimate"}
      }
    },
    "carmax": {
      "filters": {
        "makes": ["GMC"],
        "models": ["Sierra 3500 HD"],
        "trims": ["Denali Ultimate"],
        "yearMin": 2023,
        "yearMax": 2024
      }
    }
    // ... other retailers
  }
}
```

**Important Rules for LLM Prompt:**
- AutoTrader requires BOTH `startYear` AND `endYear` for year ranges
- CarMax uses `yearMin`/`yearMax`
- TrueCar uses `yearMin`/`yearMax`
- CarGurus uses `years` format (e.g., "2023-2024")
- Carvana is interactive-only, uses display label matching

### Worker Architecture

#### Location: `worker/main.py`

The worker runs on a separate server (typically `gilbert`) and:

1. **Receives scrape jobs** via API callback
2. **Runs scrapers sequentially** for each retailer
3. **Handles bot detection** with VPN retry logic
4. **Returns consolidated results** to the backend

#### Scraper Execution Order:

```
1. cargurus-camoufox (interactive)
2. carmax (URL-based)
3. autotrader (URL-based)
4. truecar (URL-based)
5. carvana (interactive)
```

#### Scraper Scripts Used by Worker

| Retailer | Script Used | Status | Notes |
|----------|-------------|--------|-------|
| **AutoTrader** | `scrape-autotrader.py` | ✅ Working | Uses Playwright, URL-based filtering |
| **CarGurus** | `scrape-cars-camoufox.py` | ✅ Working | Interactive filter selection, Camoufox |
| **CarMax** | `scrape-carmax.py` | ⚠️ Issues | URL correct but returns wrong vehicles |
| **Carvana** | `scrape-carvana-interactive.py` | ⚠️ Partial | Interactive, can't find Sierra 3500HD/Denali Ultimate |
| **TrueCar** | `scrape-truecar.py` | ⚠️ No Results | URL format or inventory issue |

**Testing Query:** "2023-2024 black gmc sierra 3500HD denali ultimate within 500 miles of 94002 under 100000"

**Test Results (2025-02-07):**
- AutoTrader: 7 GMC Sierra 3500 results (2024, $79k-$86k) ✅
- CarGurus: 9 GMC Sierra 3500HD + 1 false positive (Chevy) ✅
- CarMax: Returns wrong vehicles (Ford Fusion, VW Jetta, etc.) ❌
- Carvana: Returns mixed results (Sierra 1500, not 3500HD) ❌
- TrueCar: "No exact matches found" ❌

#### Bot Detection Handling

**Symptom:** "Could not find search box", "Access restricted", or empty results

**Solution:** Scrapers return `None` on bot detection, triggering VPN rotation:

```python
# scrape-cars-camoufox.py
if not search_input:
    logging.error("Could not find search input - likely bot detection")
    return None  # Triggers VPN retry in worker
```

**Worker Retry Logic:**
- Max 3 VPN retries per scraper
- Uses VPN service to rotate IP addresses
- Scraper is re-run with new IP

### Scraping Flow

```
User creates vehicle goal
    ↓
Backend calls parse_vehicle_query.py
    ↓
retailerFilters stored in ItemGoalData
    ↓
ScrapeJob created (status: pending)
    ↓
Worker polls for pending jobs
    ↓
Worker dispatches to /run-all endpoint
    ↓
Each scraper runs with retailer-specific filters
    ↓
Results aggregated and sent to /callback endpoint
    ↓
Backend stores candidates in ItemGoalData
    ↓
Frontend displays results
```

---

## AI Agent Integration

### Agent Proposal System

Agents can propose changes to goals through structured commands. The system supports:

#### Proposal Types

| Type | Description | Buttons |
|------|-------------|---------|
| `confirm_edit_cancel` | Editable proposals (title, filters, etc.) | Confirm, Edit, Cancel |
| `accept_decline` | Binary choices (refresh, archive) | Accept, Decline |

#### Command Format

Commands are embedded in AI responses using this format:

```
CREATE_GOAL: {"type":"item","title":"2023-2024 GMC Sierra 3500HD","budget":100000,"category":"vehicle","searchTerm":"...","proposalType":"confirm_edit_cancel","awaitingConfirmation":true}
```

#### Available Commands

| Command | Description | Proposal Type |
|---------|-------------|---------------|
| `CREATE_GOAL` | Create a new goal | `confirm_edit_cancel` |
| `CREATE_SUBGOAL` | Create a subgoal under existing goal | `confirm_edit_cancel` |
| `UPDATE_TITLE` | Change goal title (updates searchTerm for items) | `confirm_edit_cancel` |
| `UPDATE_FILTERS` | Update vehicle search filters | `confirm_edit_cancel` |
| `UPDATE_PROGRESS` | Update goal completion percentage | `confirm_edit_cancel` |
| `ADD_TASK` | Add task to action goal | `confirm_edit_cancel` |
| `REMOVE_TASK` | Remove task from action goal | `confirm_edit_cancel` |
| `TOGGLE_TASK` | Toggle task completion | `confirm_edit_cancel` |
| `REFRESH_CANDIDATES` | Trigger new scrape for item goal | `accept_decline` |
| `ARCHIVE_GOAL` | Archive a goal | `confirm_edit_cancel` |

### Chat Modes

#### 1. Overview Chat (`/ai/overview`)

**Context:** All user goals
**Use Case:** General goal management, creating new goals, prioritizing

**Agent Capabilities:**
- Create goals of any type
- Create subgoals
- Update progress
- Archive goals
- Provide guidance across all goals

#### 2. Category Specialist Chat (`/ai/category/{categoryId}`)

**Categories:** `items`, `finances`, `actions`

**Context:** Goals within a specific category

**Items Specialist:**
- Vehicle search assistance
- Product comparison
- Price tracking advice
- Feature analysis

#### 3. Goal View Chat (`/ai/goal/{goalId}/chat`)

**Context:** Single specific goal

**For Item Goals:**
- Update search term (via UPDATE_TITLE)
- Refresh candidates (via REFRESH_CANDIDATES)
- Modify filters (via UPDATE_FILTERS)

**For Action Goals:**
- Add/remove tasks
- Toggle task completion
- Update progress

**For Finance Goals:**
- Update targets
- Track contributions

### System Prompts

**Overview Chat:** `src/modules/ai/openai.service.ts` → `getOverviewSystemPrompt()`
- Full goal context
- All command types
- Subgoal creation

**Goal View Chat:** `src/modules/ai/openai.service.ts` → `getGoalViewSystemPrompt()`
- Single goal context
- Specialist prompt for items
- Goal-specific commands

**Category Specialist:** `src/modules/ai/specialist-prompts.ts` → `SPECIALIST_PROMPTS`
- Category-specific expertise
- Specialized commands
- In-depth domain knowledge

---

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | Register new user (returns verification token) |
| POST | `/auth/verify-email` | Verify email with token |
| POST | `/auth/resend-verification` | Resend verification email |
| POST | `/auth/login` | Login with email/password |
| GET | `/auth/github` | Initiate GitHub OAuth |
| GET | `/auth/github/callback` | GitHub OAuth callback |
| POST | `/auth/demo` | Create demo user |
| GET | `/auth/me` | Get current user profile |
| POST | `/auth/logout` | Logout |

### Goals

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/goals` | Get all goals for authenticated user |
| GET | `/goals/:id` | Get specific goal by ID |
| POST | `/goals` | Create new goal |
| PATCH | `/goals/:id` | Update goal |
| DELETE | `/goals/:id` | Delete goal |
| POST | `/goals/:id/archive` | Archive a goal |
| GET | `/goals/:id/subgoals` | Get subgoals for a goal |
| POST | `/goals/:id/subgoals` | Create subgoal under goal |

### Item Goals (Vehicles)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/goals/:id/candidates/refresh` | Trigger new scrape for item goal |
| PATCH | `/goals/:id/search-term` | Update search term (regenerates retailerFilters) |
| GET | `/goals/:id/candidates` | Get candidates for item goal |
| POST | `/goals/:id/candidates/:candidateId/select` | Select a candidate |
| GET | `/goals/:id/scrape-status` | Get scrape job status |

### Scraping

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/scraper/dispatch` | Dispatch scrape job to worker |
| POST | `/scraper/callback/:jobId` | Worker callback with results |
| GET | `/scraper/job/:jobId` | Get scrape job status |
| GET | `/scraper/run-all` | Run all scrapers (for worker) |

### AI Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ai/overview/chat` | Send message to overview chat |
| POST | `/ai/category/:categoryId/chat` | Send message to category specialist |
| POST | `/ai/goal/:goalId/chat` | Send message to goal view chat |
| GET | `/ai/goal/:goalId/chat` | Get goal chat history |
| POST | `/ai/command/confirm` | Confirm pending proposal |
| POST | `/ai/command/cancel` | Cancel pending proposal |
| POST | `/ai/command/edit` | Edit pending proposal |

### Plaid Integration (Finance)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/plaid/create-link-token` | Create Plaid link token |
| POST | `/plaid/exchange-public-token` | Exchange public token for access token |
| GET | `/plaid/accounts` | Get linked accounts |
| POST | `/plaid/sync/:goalId` | Sync finance goal with Plaid |

### Rate Limiting

All auth endpoints have rate limiting via NestJS Throttler:
- Register/Login: 5 requests per 15 minutes
- Email verification: 10 requests per hour
- Resend verification: 3 requests per hour
- Password reset: 3 requests per hour

---

## Database Schema

### Key Tables

#### Goal
```prisma
model Goal {
  id          String    @id
  type        GoalType
  title       String
  status      GoalStatus
  userId      String
  createdAt   DateTime
  updatedAt   DateTime

  itemData       ItemGoalData?
  financeData    FinanceGoalData?
  actionData     ActionGoalData?
  subgoals       Goal[]
  parentGoalId   String?
  parentGoal     Goal?     @relation("Subgoals")
}
```

#### ItemGoalData
```prisma
model ItemGoalData {
  goalId             String   @id
  searchTerm         String
  retailerFilters    Json?
  searchFilters      Json?     // Deprecated
  candidates         Json[]
  selectedCandidateId String?
  shortlistedCandidates String[]
  statusBadge        String
  retailerName       String
  retailerUrl        String

  goal               Goal     @relation(fields: [goalId], references: [id])
}
```

#### ScrapeJob
```prisma
model ScrapeJob {
  id           String     @id
  goalId       String
  status       JobStatus
  attempts     Int
  error        String?
  createdAt    DateTime
  updatedAt    DateTime

  goal         Goal       @relation(fields: [goalId], references: [id])
}
```

### Seed Script

```bash
npm run prisma:seed
```

Creates:
- Casey Key user with sample goals
- Test user with email/password authentication

---

## Development

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Python 3.12+ (for scrapers)
- npm or yarn

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy environment variables:
   ```bash
   cp .env.example .env
   ```

3. Update `.env` with your values

4. Run database migrations:
   ```bash
   npm run prisma:migrate dev
   ```

5. Seed the database:
   ```bash
   npm run prisma:seed
   ```

6. Start the development server:
   ```bash
   npm run start:dev
   ```

The API will be available at `http://localhost:3001`

**IMPORTANT: Dev Server Management**
- The dev server has **hot reload enabled** - code changes auto-apply without restarting
- **DO NOT kill/restart the dev server** if port 3001 is already in use
- If the dev server is already running, just make your code changes - they will auto-apply
- Restarting the server hides logs from your terminal, making debugging harder

### Worker Setup

The scraper worker runs on a separate machine (gilbert):

```bash
# On gilbert
cd /path/to/neon-goals-service/worker
python3 main.py
```

Worker environment variables:
- `NEON_GOALS_API_URL`: Backend API URL
- `VPN_ENABLED`: Enable/disable VPN rotation

### Testing

```bash
# Run unit tests
npm run test

# Run e2e tests
npm run test:e2e

# Run with coverage
npm run test:cov
```

### Useful Commands

```bash
# Generate Prisma client
npm run prisma:generate

# Open Prisma Studio (DB GUI)
npm run prisma:studio

# Format code
npm run format

# Lint code
npm run lint

# Parse vehicle query (test LLM filter generation)
cd scripts
python3 parse_vehicle_query.py "2023-2024 GMC Sierra 3500HD Denali Ultimate black 4WD under $100000"
```

---

## Security Considerations

1. **Password hashing** - bcrypt with 10 salt rounds
2. **JWT expiration** - 7 days
3. **HTTPS only** - Never send credentials in URL params
4. **Rate limiting** - Prevents brute force attacks
5. **Email enumeration protection** - Always return success on resend
6. **Input validation** - Both frontend and backend
7. **Environment variables** - Never commit credentials to Git

---

## Project Structure

```
src/
├── common/                    # Shared utilities
│   ├── guards/               # Auth guards, JWT validation
│   └── decorators/           # Custom decorators
├── modules/
│   ├── auth/                 # Authentication module
│   ├── goals/                # Goals CRUD operations
│   ├── ai/                   # AI chat integration
│   │   ├── openai.service.ts # OpenAI API wrapper
│   │   ├── goal-command.service.ts # Command execution
│   │   └── specialist-prompts.ts # Agent prompts
│   ├── scraper/              # Vehicle scraping
│   │   ├── scraper.service.ts # Scraper orchestration
│   │   └── vehicle-filter.service.ts # Filter generation
│   └── plaid/                # Finance integration
└── main.ts                   # Application entry point

scripts/
├── parse_vehicle_query.py    # LLM filter generation
├── scrape-cars-camoufox.py   # CarGurus scraper
├── scrape-autotrader.py      # AutoTrader scraper
├── scrape-carmax.py          # CarMax scraper
├── scrape-carvana.py         # Carvana scraper
├── scrape-truecar.py         # TrueCar scraper
├── data/                     # Retailer filter JSONs
│   ├── autotrader-filters.json
│   ├── carmax-filters.json
│   ├── carvana-filters.json
│   ├── cargurus-filters.json
│   └── truecar-filters.json
└── worker/
    └── main.py               # Worker orchestration
```

---

## Frontend

The frontend is located at `/home/trill/Development/neon-goals-ui` and runs on port 8081 by default.

---

## Troubleshooting

### Scraping Issues

**Problem:** AutoTrader returns no results
- **Cause:** Missing `startYear` parameter
- **Fix:** Ensure LLM prompt includes both `startYear` AND `endYear` for year ranges

**Problem:** CarGurus returns "Could not find search box"
- **Cause:** Bot detection
- **Fix:** Scraper should return `None` to trigger VPN retry

**Problem:** Results don't match search criteria
- **Cause:** Incorrect retailer-specific filter format
- **Fix:** Check retailer filter JSON for valid values

### Agent Proposal Issues

**Problem:** No action buttons appear
- **Cause:** `proposalType` not set on message
- **Fix:** Ensure store includes `proposalType` when creating messages

**Problem:** Agent creates action-based titles (e.g., "Buy a GMC...")
- **Cause:** System prompt missing title format guidance
- **Fix:** Item goal titles should be item name only

---

## TODO

- [ ] Mailgun integration for email verification
- [ ] Add more retailers to scraping system
- [ ] Implement webhook support for external integrations
- [ ] Add analytics tracking for scraper success rates

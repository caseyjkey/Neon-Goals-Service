# Universal Product Link Extraction - Design Document

**Date:** 2026-02-22
**Status:** Approved for Implementation

## Overview

Feature to extract product information (name, price, image) from arbitrary e-commerce URLs and create Item Goals. Users can provide multiple URLs via AI chat to create Group Goals with multiple product subgoals.

## User Flow

```
User chats: "Create a group goal for a vape kit:
            https://site1.com/vape-pen
            https://site2.com/battery
            https://site3.com/charger"

AI detects URLs → Creates extraction jobs → Streams progress:
  "🔗 url1: Navigating..."
  "🔗 url1: Taking screenshot..."
  "✅ Vape Pen Pro - $45"
  "✅ 18650 Battery - $12"
  "✅ USB Charger - $8"

→ Creates Group Goal "Vape Kit" with 3 Item Goal subgoals
→ Each item has: name, price, original image URL, source link
```

## Architecture

### Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `ProductExtractionService` | Backend (NestJS) | Orchestrate jobs, manage SSE, create goals |
| `ExtractionJob` | Backend (Prisma) | Track extraction status per URL |
| `extract_product.py` | Worker (Python) | Spawn Claude agent, stream progress |
| Claude Agent | Worker | Navigate, analyze, extract product data |

### Data Flow

```
┌─────────────┐           ┌──────────────┐           ┌─────────────┐
│   Backend   │ ──job───▶ │    Worker    │ ──spawn──▶│   Claude    │
│   (NestJS)  │           │  (FastAPI)   │           │    Agent    │
│             │           │              │           │             │
│  - Detect   │ ◀─stream─ │  - Execute   │ ◀─output─ │  - Navigate │
│    URLs     │           │    CLI       │           │  - Handle   │
│  - SSE      │           │  - Parse     │           │    popups   │
│  - Create   │           │    JSON      │           │  - Analyze  │
│    goals    │           │              │           │  - Extract  │
└─────────────┘           └──────────────┘           └─────────────┘
```

## Extraction Algorithm

### Agent Prompt

```
You are a product data extractor. Your task is to extract product information from a given URL.

URL: {url}

Steps:
1. Use chrome-devtools MCP to navigate to the URL
2. Handle any popups, cookie banners, age verification, or modals by dismissing them
3. Wait for the page to fully load (images visible)
4. Take a screenshot of the page
5. Analyze the screenshot to identify:
   - The main product name
   - The price
   - The main product image (not thumbnails, not related products)
6. Extract the main product image URL from the DOM
7. Return ONLY valid JSON, no other text

Return format:
{
  "success": true,
  "name": "Product Name Here",
  "price": 45.00,
  "imageUrl": "https://...",
  "currency": "USD"
}

If extraction fails:
{
  "success": false,
  "error": "Description of what went wrong"
}
```

### Worker Execution (Streaming)

```python
# extract_product.py
import subprocess
import json
import requests

def extract_product(url: str, callback_url: str, job_id: str) -> dict:
    prompt = f"""..."""  # Agent prompt with URL injected

    process = subprocess.Popen(
        [
            "claude", "-p",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "-p", prompt
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "CLAUDE_CONFIG_DIR": "/home/alpha/.claude-zhipu"}
    )

    final_result = None

    # Stream output in real-time
    for line in process.stdout:
        chunk = json.loads(line)

        # Send progress updates to backend
        if chunk.get("type") == "assistant":
            send_progress(callback_url, job_id, {
                "status": "processing",
                "message": chunk.get("content", "")[:100]
            })

        elif chunk.get("type") == "tool_use":
            send_progress(callback_url, job_id, {
                "status": "processing",
                "message": f"Using {chunk.get('name')}"
            })

        elif chunk.get("type") == "result":
            final_result = chunk.get("result")

    return final_result

def send_progress(callback_url: str, job_id: str, data: dict):
    requests.post(f"{callback_url}/progress", json={"jobId": job_id, **data})
```

## Backend Integration

### New Prisma Model

```prisma
model ExtractionJob {
  id          String   @id @default(uuid())
  url         String
  status      JobStatus @default(pending)
  result      Json?    // { name, price, imageUrl, currency }
  error       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  userId      String
  user        User     @relation(fields: [userId], references: [id])
}
```

### ProductExtractionService

```typescript
// src/modules/extraction/product-extraction.service.ts

@Injectable()
export class ProductExtractionService {

  async extractFromUrls(urls: string[], userId: string): Promise<string> {
    const groupId = uuid();

    for (const url of urls) {
      // Create extraction job
      const job = await this.prisma.extractionJob.create({
        data: { url, status: 'pending', userId }
      });

      // Dispatch to worker
      await this.workerClient.post('/extract', {
        jobId: job.id,
        url,
        callbackUrl: `${this.backendUrl}/extraction/callback`
      });
    }

    return groupId;
  }

  async handleProgress(jobId: string, data: { status: string; message: string }) {
    this.eventEmitter.emit('extraction:progress', { jobId, ...data });
  }

  async handleCallback(jobId: string, result: ExtractionResult) {
    // Update job
    await this.prisma.extractionJob.update({
      where: { id: jobId },
      data: { status: 'completed', result }
    });

    // Emit completion event
    this.eventEmitter.emit('extraction:complete', { jobId, result });
  }
}
```

### SSE Endpoint

```typescript
// GET /extraction/stream/:groupId

@Sse('stream/:groupId')
async streamExtractions(@Param('groupId') groupId: string) {
  return new Observable((subscriber) => {
    const handler = (data) => subscriber.next({ data: JSON.stringify(data) });

    this.eventEmitter.on('extraction:progress', handler);
    this.eventEmitter.on('extraction:complete', handler);

    // Cleanup on disconnect
    return () => {
      this.eventEmitter.off('extraction:progress', handler);
      this.eventEmitter.off('extraction:complete', handler);
    };
  });
}
```

### AI Chat Integration

```typescript
// In openai.service.ts

async handleChat(message: string, userId: string) {
  const urls = this.extractUrls(message);

  if (urls.length > 0) {
    const groupId = await this.extractionService.extractFromUrls(urls, userId);

    return {
      response: `Extracting product info from ${urls.length} links...`,
      extractionStream: `/extraction/stream/${groupId}`,
      urlCount: urls.length
    };
  }

  // ... normal chat handling
}

private extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s]+/g;
  return text.match(urlRegex) || [];
}
```

## Goal Creation

After all extractions complete, create Group Goal with Item Goal subgoals:

```typescript
async createGoalsFromExtractions(
  groupId: string,
  groupName: string,
  extractions: ExtractionResult[],
  userId: string
) {
  // 1. Create Group Goal
  const groupGoal = await this.prisma.goal.create({
    data: {
      type: 'group',
      title: groupName,
      status: 'active',
      userId,
    }
  });

  // 2. Create Item Goal for each extracted product
  for (const extraction of extractions) {
    if (!extraction.success) continue;

    const { name, price, imageUrl } = extraction.result;

    await this.prisma.goal.create({
      data: {
        type: 'item',
        title: name,
        status: 'active',
        userId,
        parentGoalId: groupGoal.id,

        itemData: {
          create: {
            searchTerm: name,
            productImage: imageUrl,
            bestPrice: price,
            currency: 'USD',
            retailerUrl: extraction.url,
            retailerName: new URL(extraction.url).hostname,
            statusBadge: 'in_stock',
            candidates: [{
              id: uuid(),
              name,
              price,
              image: imageUrl,
              url: extraction.url,
              retailer: new URL(extraction.url).hostname,
            }],
            selectedCandidateId: uuid(),
          }
        }
      }
    });
  }

  return groupGoal;
}
```

## Worker Setup (Gilbert)

### Prerequisites

1. **Claude CLI installed**
   ```bash
   # Install Claude CLI
   npm install -g @anthropic-ai/claude-code
   ```

2. **Config from `~/.claude-zhipu/`**
   - Copy MCP server configs
   - Copy API settings (anthropic base URL, model)
   - Ensure chrome-devtools MCP is configured

3. **Happier fork cloned**
   ```bash
   git clone <happier-fork-url> /home/alpha/.claude-zhipu
   ```

4. **Zsh alias (`cz`) copied**

### New Worker Endpoint

```python
# worker/main.py

@app.post("/extract")
async def extract_product(request: Request, background_tasks: BackgroundTasks):
    body = await request.json()

    job_id = body.get("jobId")
    url = body.get("url")
    callback_url = body.get("callbackUrl")

    if not all([job_id, url, callback_url]):
        raise HTTPException(status_code=400, detail="Missing required fields")

    background_tasks.add_task(run_extraction, job_id, url, callback_url)

    return {"status": "dispatched", "jobId": job_id}
```

## Implementation Checklist

### Backend (NestJS)
- [ ] Create `ExtractionJob` Prisma model
- [ ] Create `ProductExtractionService`
- [ ] Add SSE endpoint `/extraction/stream/:groupId`
- [ ] Add callback endpoint `/extraction/callback`
- [ ] Add progress endpoint `/extraction/progress`
- [ ] Integrate URL detection in AI chat
- [ ] Implement goal creation from extraction results

### Worker (Python)
- [ ] Add `/extract` endpoint to `worker/main.py`
- [ ] Create `extract_product.py` script
- [ ] Wire up streaming to callback

### Gilbert Setup
- [ ] Install Claude CLI
- [ ] Copy `~/.claude-zhipu/` config
- [ ] Clone happier fork
- [ ] Copy `cz` alias
- [ ] Test agent extraction manually

### Frontend (React)
- [ ] Handle SSE connection for extraction progress
- [ ] Display extraction progress in chat
- [ ] Show created goals after completion

## Testing

### Manual Test

```bash
# On gilbert, test agent extraction directly
claude -p --output-format stream-json "Extract product data from https://www.amazon.com/dp/EXAMPLE. Use chrome-devtools to navigate. Return JSON: {name, price, imageUrl}"
```

### E2E Test Flow

1. Send chat message with URLs
2. Verify SSE receives progress updates
3. Verify goals are created with correct data
4. Verify Group Goal contains all Item Goals

# AGENTS.md - Agent Communication Guide

This document explains how agents communicate with the Neon Goals Service — both internally (OpenClaw sessions) and externally (via API).

---

## Table of Contents

- [Internal Communication (OpenClaw)](#internal-communication-openclaw)
- [External Communication (HTTP API)](#external-communication-http-api)
- [Agent Discovery Protocol](#agent-discovery-protocol)
- [Best Practices](#best-practices)

---

## Internal Communication (OpenClaw)

Agents running within OpenClaw can interact with the Neon Goals Service using the **sessions_send** tool to spawn specialized sub-agents that work with goal data.

### Agent Types

| Agent | Purpose | Entry Point |
|-------|---------|-------------|
| **Overview Agent** | General goal management, creating goals, prioritization | `POST /ai/overview/chat` |
| **Category Specialist** | Domain-specific assistance (items, finances, actions) | `POST /ai/category/:categoryId/chat` |
| **Goal View Agent** | Deep dive into a specific goal's details and candidates | `POST /ai/goal/:goalId/chat` |

### Spawning a Sub-Agent

When you need AI assistance with goals, spawn a sub-agent with the appropriate context:

```python
# Example: Spawn an agent to help with vehicle search
sessions_spawn(
    task="Help me find a 2023-2024 GMC Sierra 3500HD Denali Ultimate under $100000 within 500 miles of 94002. Use the goal management system.",
    label="neon-vehicle-search",
    mode="session",  # Persistent session for multi-turn conversations
    timeoutSeconds=300
)
```

### Internal Agent Context

OpenClaw agents have access to:
- **User context** (if running in a main session with an authenticated user)
- **API authentication** via stored JWT tokens (from user login)
- **Tool access** to make HTTP requests to the service

#### Reading User Goals (Internal)

```python
# From an OpenClaw agent with user context
import requests

# Get JWT token from environment or session storage
jwt_token = os.getenv('NEON_GOALS_JWT')

headers = {
    'Authorization': f'Bearer {jwt_token}'
}

# Fetch user goals
response = requests.get('https://goals.keycasey.com/api/goals', headers=headers)
goals = response.json()
```

#### Sending Messages to AI Specialists (Internal)

```python
# Chat with the overview agent
response = requests.post(
    'https://goals.keycasey.com/api/ai/overview/chat',
    headers={'Authorization': f'Bearer {jwt_token}'},
    json={'message': 'What should I work on today?'}
)

reply = response.json()['reply']
```

---

## External Communication (HTTP API)

Agents running outside OpenClaw (or in isolated sessions) use **API Key authentication** to communicate with the service.

### Authentication Methods

| Method | Header | Use Case |
|--------|--------|----------|
| **JWT** | `Authorization: Bearer <token>` | User-authenticated requests |
| **API Key** | `X-API-Key: <key>` | Agent-to-agent communication |

### API Key Setup

The service uses a single `AGENT_API_KEY` environment variable for agent authentication. All API key requests share the same generic "agent" identity (`userId: "agent"`).

#### Generating an API Key

```bash
# Generate a secure 32-byte base64 key
openssl rand -base64 32
# Example output: Ce4QAMETH3m1pBf9yt8TCZY6ZkF8KQy0R+JbQH3K3Pk=

# Add to .env
echo "AGENT_API_KEY=Ce4QAMETH3m1pBf9yt8TCZY6ZkF8KQy0R+JbQH3K3Pk=" >> .env
```

#### Making Authenticated Requests

```python
import requests

headers = {
    'X-API-Key': 'Ce4QAMETH3m1pBf9yt8TCZY6ZkF8KQy0R+JbQH3K3Pk=',
    'Content-Type': 'application/json'
}

# Get chat structure (agent discovery)
response = requests.get('https://goals.keycasey.com/api/chats', headers=headers)
chats = response.json()

# Send message to overview specialist
response = requests.post(
    'https://goals.keycasey.com/api/ai/overview/chat',
    headers=headers,
    json={'message': 'What are the best practices for goal setting?'}
)

reply = response.json()['reply']
```

### Agent-Scoped Data Access

**Important:** API Key authentication provides a neutral "agent" context:

| Endpoint | JWT Returns | API Key Returns |
|----------|-------------|-----------------|
| `GET /goals` | User's goals | `[]` (empty array) |
| `GET /chats` | User's chat history | Empty structure |
| `GET /chats/overview` | User's overview chat | New agent chat |
| `POST /goals/item` | Creates for user | Creates for agent (userId: "agent") |

**Design Pattern:** Agents use API keys to:
- Chat with AI specialists (expertise without user data)
- Create goals in their own context (for automation workflows)
- Trigger scraping jobs (refresh candidates)

---

## Agent Discovery Protocol

The `/api/chats` endpoint provides a structured view of available specialist agents for automated discovery.

### Chat Structure

```json
{
  "overview": {
    "id": "overview-chat-id",
    "title": "Overview",
    "description": "General goal management assistant",
    "categoryId": null,
    "messages": []
  },
  "categories": [
    {
      "id": "items",
      "title": "Items",
      "description": "Product search and comparison specialist",
      "chat": {
        "id": "items-chat-id",
        "messages": []
      }
    },
    {
      "id": "finances",
      "title": "Finances",
      "description": "Financial planning and tracking specialist",
      "chat": {
        "id": "finances-chat-id",
        "messages": []
      }
    },
    {
      "id": "actions",
      "title": "Actions",
      "description": "Task and project management specialist",
      "chat": {
        "id": "actions-chat-id",
        "messages": []
      }
    }
  ]
}
```

### Discovering Specialists

```python
# Fetch available specialists
response = requests.get('https://goals.keycasey.com/api/chats', headers=headers)
chats = response.json()

# List all categories
for category in chats['categories']:
    print(f"{category['title']}: {category['description']}")

# Send message to a specific specialist
items_chat_id = chats['categories'][0]['chat']['id']
response = requests.post(
    f'https://goals.keycasey.com/api/chats/{items_chat_id}/messages',
    headers=headers,
    json={'content': 'How do I compare vehicle specs?'}
)
```

---

## Agent Proposal System

AI agents can propose goal changes through structured commands embedded in their responses.

### Command Format

Commands use a colon-separated prefix with JSON payload:

```
COMMAND_NAME: {"param1": "value1", "param2": "value2"}
```

### Proposal Types

| Type | Buttons | Use Case |
|------|---------|----------|
| `confirm_edit_cancel` | Confirm, Edit, Cancel | Editable proposals (title, filters, progress) |
| `accept_decline` | Accept, Decline | Binary choices (refresh, archive) |

### Available Commands

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

### Command Examples

#### Create a Goal

```
CREATE_GOAL: {"type":"item","title":"2023-2024 GMC Sierra 3500HD","budget":100000,"category":"vehicle","searchTerm":"2023-2024 GMC Sierra 3500HD Denali Ultimate black 4WD under $100000","proposalType":"confirm_edit_cancel","awaitingConfirmation":true}
```

#### Refresh Candidates

```
REFRESH_CANDIDATES: {"goalId":"goal-123","proposalType":"accept_decline","awaitingConfirmation":true}
```

#### Update Progress

```
UPDATE_PROGRESS: {"goalId":"goal-123","progress":65,"proposalType":"confirm_edit_cancel","awaitingConfirmation":true}
```

### Executing Commands

```python
# Confirm a proposal
response = requests.post(
    'https://goals.keycasey.com/api/ai/command/confirm',
    headers=headers,
    json={'pendingCommand': 'CREATE_GOAL: {...}'}
)

# Cancel a proposal
response = requests.post(
    'https://goals.keycasey.com/api/ai/command/cancel',
    headers=headers,
    json={'pendingCommand': 'CREATE_GOAL: {...}'}
)

# Edit a proposal (returns current values for editing)
response = requests.post(
    'https://goals.keycasey.com/api/ai/command/edit',
    headers=headers,
    json={'pendingCommand': 'CREATE_GOAL: {...}'}
)
edited_fields = response.json()
```

---

## Best Practices

### Internal (OpenClaw) Agents

1. **Use JWT authentication** when user context is available
2. **Spawn sub-agents** for specialized tasks (e.g., vehicle search)
3. **Respect user data boundaries** — don't share data across sessions
4. **Use streaming responses** for long-running AI tasks (`/chat/stream` endpoints)

### External Agents

1. **Use API Key authentication** for agent-to-agent communication
2. **Expect neutral data context** — API keys return empty/agent-specific data
3. **Leverage specialist agents** for domain expertise without needing user data
4. **Handle proposals asynchronously** — agents can suggest changes, user confirms later

### Agent Discovery

1. **Query `/api/chats`** to discover available specialists
2. **Check chat history** to avoid repeating conversations
3. **Use category-specific endpoints** for focused assistance (`/api/category/:categoryId/chat`)

### Error Handling

```python
# Handle authentication errors
if response.status_code == 401:
    if 'Invalid API key' in response.json()['message']:
        # Check AGENT_API_KEY configuration
        pass
    elif 'Invalid or expired JWT token' in response.json()['message']:
        # Re-authenticate user
        pass

# Handle proposal errors
if response.status_code == 400:
    error = response.json()
    if 'pendingCommand' in error:
        # Another command is already pending
        pass
```

---

## Example Workflows

### Workflow 1: Agent-Assisted Vehicle Search (Internal)

```python
# 1. Get user's goals
goals_response = requests.get('/api/goals', headers=jwt_headers)
goals = goals_response.json()

# 2. Spawn a specialist to help with vehicle search
sessions_spawn(
    task="Review the user's vehicle goals and suggest improvements. "
         "Use the goal management system to create or update goals.",
    label="vehicle-specialist"
)

# 3. Specialist discovers vehicle goal and proposes filters
# Agent sends: "I found your GMC Sierra goal. Want me to refine the search?"
# With command: UPDATE_FILTERS: {...}

# 4. User confirms
requests.post('/api/ai/command/confirm', headers=jwt_headers, json={...})

# 5. Trigger refresh
requests.post(f'/api/goals/{goal_id}/candidates/refresh', headers=jwt_headers)
```

### Workflow 2: External Automation Agent

```python
# 1. Agent discovers overview specialist
chats = requests.get('/api/chats', headers=api_key_headers).json()
overview_chat_id = chats['overview']['id']

# 2. Agent asks for goal-setting best practices
response = requests.post(
    f'/api/chats/{overview_chat_id}/messages',
    headers=api_key_headers,
    json={'content': 'What are the SMART goal criteria?'}
)

# 3. Agent uses advice to create structured content
# (No user data needed — pure AI expertise)
```

### Workflow 3: Webhook Integration

```python
# External service triggers goal creation via webhook
def handle_webhook(event):
    # Create goal in agent context
    response = requests.post(
        'https://goals.keycasey.com/api/goals/item',
        headers={'X-API-Key': AGENT_API_KEY, 'Content-Type': 'application/json'},
        json={
            'title': event['item_name'],
            'category': 'product',
            'searchTerm': f"{event['item_name']} under {event['budget']}"
        }
    )
    return response.json()
```

---

## Troubleshooting

### "Invalid API Key"
- Verify `AGENT_API_KEY` is set in service's `.env`
- Ensure header name is `X-API-Key` (not `Authorization`)
- Restart service after changing `.env`

### Empty Chat History
- Expected behavior for API Key authentication
- Agents start fresh conversations each time

### Proposal Buttons Not Appearing
- Check `proposalType` is included in command JSON
- Verify `awaitingConfirmation: true` is set
- Ensure frontend is polling for pending proposals

### 403 Forbidden on Goal Access
- API keys cannot access user-specific goals
- Use JWT authentication for user data
- Create agent-scoped goals with API key (userId: "agent")

---

## Summary

| Aspect | Internal (OpenClaw) | External (HTTP) |
|--------|-------------------|----------------|
| **Auth** | JWT token | API Key (`X-API-Key`) |
| **User Context** | Available | Not available (agent-only) |
| **Goal Access** | User's goals | Agent's goals (empty by default) |
| **Chat History** | Persisted per user | Fresh per request |
| **Use Case** | User assistance, personalization | Automation, webhooks, AI expertise |

For more details on API endpoints, see [README.md](./README.md) and [CLAUDE.md](./CLAUDE.md).

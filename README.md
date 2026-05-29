# cursor-agent-api-proxy

[![npm version](https://img.shields.io/npm/v/cursor-agent-api-proxy)](https://www.npmjs.com/package/cursor-agent-api-proxy)
[![npm downloads](https://img.shields.io/npm/dm/cursor-agent-api-proxy)](https://www.npmjs.com/package/cursor-agent-api-proxy)
[![license](https://img.shields.io/npm/l/cursor-agent-api-proxy)](./LICENSE)

[中文文档](./README.zh-CN.md)

OpenAI-compatible API proxy for the Cursor CLI. Lets any OpenAI client use your Cursor subscription.

## Prerequisites

- Node.js 20+
- Active [Cursor](https://cursor.com) subscription (Pro / Business)

## Install

**1. Install the Cursor CLI and log in:**

```bash
# macOS / Linux
curl https://cursor.com/install -fsS | bash

# Windows PowerShell
irm 'https://cursor.com/install?win32=true' | iex
```

```bash
agent login          # opens browser, sign in with your Cursor account
agent --list-models  # verify it works
```

> **Headless?** Skip `agent login`, generate a key at [cursor.com/settings](https://cursor.com/settings) and `export CURSOR_API_KEY=<key>`.

**2. Install and start the proxy:**

```bash
npm install -g cursor-agent-api-proxy
cursor-agent-api          # starts in background on http://localhost:4646
cursor-agent-api status   # check if running
```

**3. Verify:**

```bash
curl http://localhost:4646/health
```

**Other commands:**

```bash
cursor-agent-api stop           # stop
cursor-agent-api restart        # restart
cursor-agent-api start 8080     # start on a custom port
cursor-agent-api run            # run in foreground (for debugging)
```

Logs: `~/.cursor-agent-api/server.log`

## Use with OpenClaw

### First-time setup (onboarding wizard)

If you haven't set up [OpenClaw](https://docs.openclaw.ai) yet, run the onboarding wizard:

```bash
openclaw onboard
```

When the wizard asks you to configure **Model/Auth**:

1. Provider type → choose **Custom Provider** (OpenAI-compatible)
2. Base URL → `http://localhost:4646/v1`
3. API Key → type `not-needed` (if you ran `agent login`)
4. Default model → `auto` (or any model from `agent --list-models`)

### Existing setup (edit config)

Already have OpenClaw running? Edit the config file directly:

```json5
{
  env: {
    // "not-needed" = already logged in via agent login
    // or set your Cursor API Key here to forward it per-request
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:4646/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/auto" },
    },
  },
}
```

## Models

Model IDs match `agent --list-models` output directly:

```bash
auto                  # auto-select
gpt-5.2               # GPT-5.2
gpt-5.3-codex         # GPT-5.3 Codex
opus-4.6-thinking     # Claude Opus 4.6 (thinking)
sonnet-4.5-thinking   # Claude Sonnet 4.5 (thinking)
gemini-3-pro          # Gemini 3 Pro
```

Full list: `curl http://localhost:4646/v1/models` or `agent --list-models`.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List models |
| `/v1/chat/completions` | POST | Chat completion (supports `stream: true`) |

## Configuration

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `PORT` | `4646` | Listen port (or `cursor-agent-api start 8080`) |
| `CURSOR_API_KEY` | - | Alternative to `agent login` |

## Auto-start (boot)

To start the proxy automatically on system boot:

```bash
cursor-agent-api install    # register as system service
cursor-agent-api uninstall  # remove
```

- macOS → LaunchAgent
- Windows → Task Scheduler
- Linux → systemd user service

## Other Clients

<details>
<summary>Python (openai SDK)</summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4646/v1",
    api_key="not-needed",
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

</details>

<details>
<summary>Continue.dev</summary>

```json
{
  "models": [{
    "title": "Cursor",
    "provider": "openai",
    "model": "auto",
    "apiBase": "http://localhost:4646/v1",
    "apiKey": "not-needed"
  }]
}
```

</details>

<details>
<summary>curl</summary>

```bash
curl -X POST http://localhost:4646/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

</details>

## How it Works

```
Client  →  POST /v1/chat/completions (OpenAI format)
        →  cursor-agent-api-proxy
        →  spawn agent CLI (stream-json)
        →  Cursor subscription
        →  AI response → OpenAI format → Client
```

## Multi-Account Support

Manage multiple Cursor subscriptions behind a single proxy instance. Select an account via the `X-Cursor-Account` request header.

### Configuring Accounts

**Method 1: Config file (recommended)**

Edit `~/.cursor-agent-api/accounts.json`:

```json
{
  "accounts": {
    "personal": {
      "name": "Personal Account",
      "api_key": "sk-xxx",
      "default": true
    },
    "work": {
      "name": "Work Account",
      "api_key": "sk-yyy"
    }
  },
  "default": "personal"
}
```

- `api_key` is optional. Omit to use `agent login` global auth.
- `default: true` marks the default account.

**Method 2: REST API**

```bash
# Add/update an account
curl -X POST http://localhost:4646/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{"id":"personal","name":"Personal Account","api_key":"sk-xxx","default":true}'

# List accounts
curl http://localhost:4646/v1/accounts

# Delete an account
curl -X DELETE http://localhost:4646/v1/accounts/personal
```

### Using Multiple Accounts

Add the `X-Cursor-Account` header to select the account:

```bash
# Use personal account
curl -X POST http://localhost:4646/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Cursor-Account: personal" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'

# Use work account
curl -X POST http://localhost:4646/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Cursor-Account: work" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

### Account Status

```bash
curl http://localhost:4646/health
# Response includes an `accounts` field with total count, default, and list.
```

### API Endpoints Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (includes account info) |
| `/v1/models` | GET | List models |
| `/v1/chat/completions` | POST | Chat completion (supports `stream: true`) |
| `/v1/accounts` | GET | List all accounts |
| `/v1/accounts` | POST | Add/update an account |
| `/v1/accounts/:id` | DELETE | Delete an account |

## Contributing

```bash
git clone https://github.com/tageecc/cursor-agent-api-proxy.git
cd cursor-agent-api-proxy
pnpm install && pnpm run build
pnpm start
```

## License

MIT

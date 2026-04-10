# copilot-cli

Standalone local server that exposes GitHub Copilot as a REST API — like **Ollama** for Copilot.

Runs at `http://localhost:18966` and is auto-detected by the app settings.

## Quick Start

```bash
# Install
cd copilot-cli
npm install

# First time — authenticate with GitHub
npm run dev          # follow the device-code link printed in terminal

# Start the server (keep running)
npm run dev
```

## Endpoints

| Method | Path               | Description                |
|--------|--------------------|----------------------------|
| GET    | `/status`          | Health + auth check       |
| GET    | `/models`          | List available models     |
| POST   | `/chat/completions`| Chat (poll-based, returns `runId`) |
| POST   | `/chat/stream`     | Chat (SSE streaming)      |
| GET    | `/run/:runId`      | Poll for run result       |

## How It Works

1. Uses `@github/copilot-sdk` which reads the auth token from `gh copilot` (GitHub CLI)
2. Manages a persistent `CopilotClient` session (no 3-5s startup per request)
3. Session mutex ensures one LLM call at a time (SDK limitation)
4. Auto-retry on auth errors and stuck sessions

## API Examples

### Check status
```bash
curl http://localhost:18966/status
# {"status":"ok","authenticated":true}
```

### List models
```bash
curl http://localhost:18966/models
# {"models":[{"id":"gpt-4o","name":"GPT-4o",...}, ...]}
```

### Chat (streaming)
```bash
curl -N -X POST http://localhost:18966/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"Hello!"}]}'
```

### Chat (poll-based)
```bash
# Submit
curl -X POST http://localhost:18966/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"Hello!"}]}'
# {"runId":"abc-123","status":"queued"}

# Poll
curl http://localhost:18966/run/abc-123
# {"runId":"abc-123","status":"completed","result":{"content":"Hi there!","model":"gpt-4o",...}}
```

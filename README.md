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

| Method | Path                    | Description                                |
|--------|-------------------------|--------------------------------------------|
| POST   | `/v1/chat/completions`  | **OpenAI-compatible** chat (stream & non-stream) |
| GET    | `/status`               | Health + auth check                        |
| GET    | `/models`               | List available models                      |
| POST   | `/chat/completions`     | Chat (poll-based, returns `runId`)         |
| POST   | `/chat/stream`          | Chat (SSE streaming, legacy format)        |
| GET    | `/run/:runId`           | Poll for run result                        |

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

### OpenAI-compatible chat (non-streaming)
```bash
curl -X POST http://localhost:18966/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
# {"id":"chatcmpl-...","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"Hi!"},"finish_reason":"stop"}],...}
```

### OpenAI-compatible chat (streaming)
```bash
curl -N -X POST http://localhost:18966/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
# data: {"id":"chatcmpl-...","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}
# data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"Hi!"},"finish_reason":null}]}
# data: {"id":"chatcmpl-...","choices":[{"delta":{},"finish_reason":"stop"}]}
# data: [DONE]
```

## Tool Calling (OpenAI-compatible)

The `/v1/chat/completions` endpoint supports the standard OpenAI/Anthropic tool calling
pattern. Tools are executed **client-side** — no callback server needed.

### Step 1: Send request with tool definitions

```bash
curl -X POST http://localhost:18966/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "What is the weather in London?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }]
  }'
```

Response (model wants to call a tool):
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"London\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

### Step 2: Execute tool locally, send results back

```bash
curl -X POST http://localhost:18966/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [
      {"role": "user", "content": "What is the weather in London?"},
      {"role": "assistant", "content": null, "tool_calls": [{"id": "call_abc123", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"London\"}"}}]},
      {"role": "tool", "tool_call_id": "call_abc123", "content": "14°C, overcast"}
    ],
    "tools": [...]
  }'
```

Response (final answer):
```json
{
  "choices": [{
    "message": { "role": "assistant", "content": "The weather in London is 14°C and overcast." },
    "finish_reason": "stop"
  }]
}
```

### Run the demo

```bash
npx tsx examples/openai-tool-calling-demo.ts
```

### Legacy endpoints

The original `/chat/stream` and `/chat/completions` endpoints still work with
the callback-based tool calling pattern. See [tool-calling-demo.ts](examples/tool-calling-demo.ts).

### Chat (legacy streaming)
```bash
curl -N -X POST http://localhost:18966/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"Hello!"}]}'
```

### Chat (legacy poll-based)
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

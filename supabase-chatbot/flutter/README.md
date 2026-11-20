# Supabase chatbot — Flutter client

## Overview

A small Flutter app for the **supabase-chatbot** example: users sign in with
Supabase Auth and chat with an agent served by [`graphrt serve`](https://github.com/BimaPangestu28/graphrt).
The agent reads the user's own data through Supabase RPCs, called with the
user's JWT, so row level security decides what it can see.

```
Flutter app ──(Supabase Auth, anon key)──────────────► Supabase
     │  POST /v1/workflows/agent/runs                      ▲
     │  X-User-Authorization: Bearer <access token>        │ RPC as the user
     └────────────► graphrt serve (--verify-jwt) ──────────┘
                    SSE: response / node_progress / run_*
```

The backend (workflow, migration, serve flags) lives in the graphrt repo at
`examples/supabase-chatbot/`.

## Features

- Email + password sign-in / sign-up with `supabase_flutter`.
- Streams the reply from serve's SSE and renders `response` text as it arrives,
  with a "Looking up your data…" indicator while the agent calls tools
  (`node_progress` `tool_call` / `tool_result`).
- Chat history in `chat_sessions` / `chat_messages` (via the
  `start_chat_session`, `add_chat_message`, `list_chat_messages` RPCs). The last
  16 complete messages are sent as `sys.history`.
- Resilience:
  - **Expired token** (401): refreshes the Supabase session and retries once;
    if it is refused again, asks the user to sign in again.
  - **Rate limited** (429 + `Retry-After`): waits that long and retries
    (gives up and tells the user when it is over 60 s). 429 without
    `Retry-After`, 408/5xx and network errors: exponential backoff with jitter
    (0.5 s, 1 s, 2 s … max 8 s), 4 attempts in total.
  - **Connection dropped mid-stream** (or 90 s of silence): the partial text
    stays on screen, marked "Connection lost", with a **Retry** button.
    A started run is never re-sent automatically, since it may already have
    called tools.
  - 400 / 413 / 415 and `run_failed` (for example `invalid_input`) are shown
    as errors and not retried. Messages are capped at 4000 characters and the
    body at 60 KiB (oldest history dropped first) before sending.
- Two runtime dependencies: `supabase_flutter` and `http`.

## Prerequisites

- Flutter 3.47+ (Dart 3.13+, see `pubspec.yaml`).
- A Supabase project with the migration from
  `graphrt/examples/supabase-chatbot/supabase/migrations` applied and email
  auth enabled.
- `graphrt serve` running the `examples/supabase-chatbot` workflow with
  `--input-header user_jwt=X-User-Authorization --verify-jwt user_jwt`
  (see that folder's README).

## Configuration

The app only ever holds **public** values. It needs no LLM key, no Supabase
service role / secret key and no graphrt serve API key: serve authenticates
each request with the user's own Supabase access token.

| Name | Required | Description |
|---|---|---|
| `SUPABASE_URL` | yes | `https://<project>.supabase.co` |
| `SUPABASE_ANON_KEY` | yes | The anon / publishable key (`sb_publishable_…`). The app refuses to start with a secret / service role key. |
| `SERVE_URL` | yes | Base URL of `graphrt serve`, e.g. `https://chat.example.com` or `http://10.0.2.2:8080` (Android emulator → host). A path prefix is kept. |
| `WORKFLOW_NAME` | no | Served workflow name, default `agent` (the file stem of `agent.yaml`). |

Values are compiled in with `--dart-define`. The easiest way is a JSON file:

```sh
cp config.example.json config.json   # git-ignored; edit the values
```

Plain `http://` is allowed only for local development: Android debug builds
permit cleartext traffic and iOS allows local networking. Use `https` in
production.

## Installation

```sh
cd supabase-chatbot/flutter
flutter pub get
```

## Quick Start

```sh
flutter run --dart-define-from-file=config.json
```

Sign up (or sign in), then ask e.g. "What did I write in my diary this week?".

## Usage

- **New chat** (top bar) starts a new session; the first message creates it
  (titled after that message). On start the app opens your newest session.
- **Retry** appears under a reply that was cut off or failed.
- **Sign out** returns to the login screen.

Build a release:

```sh
flutter build apk --release --dart-define-from-file=config.json
flutter build ipa --release --dart-define-from-file=config.json
```

## Project layout

```
lib/
  main.dart                       app, auth gate, config error screen
  src/app_config.dart             --dart-define config + validation
  src/auth/supabase_access_token.dart  access token, refresh on demand
  src/serve/sse_parser.dart       text/event-stream parser
  src/serve/run_update.dart       SSE event → answer delta / tool activity / end
  src/serve/run_request.dart      run body, history and size limits
  src/serve/retry_policy.dart     what to retry, and how long to wait
  src/serve/serve_client.dart     POST + stream with retries
  src/chat/chat_history_store.dart  Supabase sessions / messages
  src/chat/chat_controller.dart   chat state (ChangeNotifier)
  src/ui/                         login and chat screens
test/                             unit tests (no network)
```

## Tests

```sh
flutter test
flutter analyze
```

The tests cover the SSE parser (recorded serve stream, arbitrary chunk
boundaries, CR/LF variants, split UTF-8), the retry policy, the serve client
against a scripted fake server (401 → refresh → retry, 429 `Retry-After`,
backoff, plain-text 413, mid-stream drops) and the chat controller (partial
text kept, retry, history saved and sent).

## API reference (serve contract)

`POST {SERVE_URL}/v1/workflows/{WORKFLOW_NAME}/runs`

- Headers: `Content-Type: application/json`,
  `X-User-Authorization: Bearer <Supabase access token>`. No `Authorization`.
- Body:
  `{"stream": true, "inputs": {"message": "…", "session_id": "…"}, "sys": {"history": [{"role": "user|assistant", "content": "…"}], "today": "YYYY-MM-DD"}}`
- Response: SSE. `response` events (`{node_id, text, is_final}`) are
  concatenated; the run ends with `run_succeeded`, `run_failed` (`error`),
  `run_aborted` or `run_paused`.
- Errors: 401 JSON `{"error"}` (token), 429 + `Retry-After` (per-user rate
  limit), 400 / 413 / 415 plain text.

## Contributing

Keep it small: no new dependency without a strong reason. Run `dart format`,
`flutter analyze` and `flutter test` before opening a PR.

## License

Apache-2.0, see [LICENSE](../../LICENSE).

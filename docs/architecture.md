# Architecture

The runtime is a short, explicit turn coordinator. There is no message broker, generic workflow engine, or background agent. Start with `src/runtime/runtime.ts`, then the provider interface and calculator.

## Request flow

1. The WebSocket server validates a text frame against a strict client schema. A connection owns one session. Concurrent requests and resets during cognition return `BUSY`.
2. The runtime creates a correlation ID and persists `chat.received`, `cognition.started`, and `memory.read` in order. Lifecycle events are also structured JSON logs and UI packets.
3. An explicit `Remember that [the] <key> is <value>.` message writes a fact through the application rule. The model has no memory-write output. Ordinary messages reach the provider with the generic instruction, the current message, at most 12 prior messages, the bounded fact set, and one tool definition.
4. The provider returns a validated response or tool proposal. Provider latency appears on `cognition.completed`. Failure or deadline produces a fixed `runtime.error` code and unlocks the session; failed turns do not enter context.
5. For a tool proposal, the runtime emits `tool.requested`; the executor validates the name and strict operand schema before invoking the calculator. A structured outcome emits `tool.completed`. The runtime renders the number or error directly; there is no second model call or retry loop.
6. Successful turns add a user/assistant pair to RAM and trim to 12 messages. `response.completed` persists before the separate response packet reaches the UI.

## Event model

`src/events/types.ts` defines discriminated event payloads. Events carry UUIDs, UTC timestamps, session IDs, and correlation IDs. SQLite assigns an insertion sequence; tests assert ordering by that sequence rather than relying on timestamps. The store writes an event before the runtime publishes it. A new session has a separate correlation ID, and every turn shares one correlation ID across its lifecycle events.

The event table contains counts, provider latency, capability outcomes, and fixed codes, never user messages, memory values, prompts, or raw provider exceptions. It persists across database reopen and can be inspected through `MemoryStore.events(sessionId)`. The UI holds the latest 200 events for the current session, newest first. There is no replay API. Fact updates and event writes are separate SQLite statements; they are not a transactional workflow journal.

## Provider boundary

`LLMProvider.generate(request)` is the only provider contract. The fake adapter is deterministic and recognizes the documented demo inputs. It has no external dependencies or credentials. The optional OpenAI-compatible adapter uses native `fetch`, a fixed configured HTTPS endpoint, JSON object responses, bounded body reads, and the runtime's abort signal. Neither adapter executes a tool. Untrusted proposals still pass the capability gate.

The cognition helper slices context and builds the generic request. All stored facts are relevant to this deliberately small demo: the set is capped at 32, and the fake adapter looks up the project codename by key. There is no ranking or retrieval infrastructure. The optional provider reads those facts as data. Runtime decisions and resource limits do not depend on trusting model instructions.

## Persistent and transient state

SQLite uses WAL, a busy timeout, parameterized SQL, and numbered migrations via `PRAGMA user_version`. Facts have stable IDs, normalized keys, values, and creation/update timestamps; an upsert preserves identity and creation time. The store refuses a future schema version. The default database is `data/runtime.sqlite` and Git ignores it.

Session context is an in-memory array owned by one socket. Resetting creates a new ID and empty context; reconnecting also starts fresh. Facts are shared across the local demo and survive either operation and server restarts. The UI's memory snapshot refreshes on session start/reset and explicit writes in that connection. Disconnects release the socket session once any active turn completes. Graceful shutdown stops ingestion, drains bounded in-flight turns, and closes SQLite.

## Bounded capability execution

Exactly one production executor exists: `calculator`. Its schema requires two finite numbers in ±10¹² and one of four operators. Unexpected fields and unknown names fail closed. There is no `eval`, expression parser, plugin registry, or dynamic loading. Division by zero fails with a structured code.

The executor has a 100 ms asynchronous deadline. A timeout bounds waiting; it cannot preempt CPU-blocking JavaScript. The production calculator does one fixed arithmetic operation, so its work is intrinsically bounded. An injected executor is only a test seam for failure/deadline checks, not a user-configurable plugin.

The provider has a separate 10-second deadline and body-size cap. Connections are capped at 32, frames at 8 KiB, messages at 2,000 characters and 20 frames per 10-second window, and queued socket output at 64 KiB. These are small-demo limits, not a deployment security or availability model.

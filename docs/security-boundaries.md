# Security boundaries

This is an independent public reference implementation with a deliberately narrow model capability surface. It has no dependency on private repositories, credentials, prompts, production memory, or operator infrastructure.

## Model capabilities

The model can propose only a response or tool request. A proposal is untrusted: the runtime checks the output schema, the executor checks the tool name, and a strict schema checks operands before execution. Exactly one tool can run per turn. The tool result becomes the final reply without a recursive model loop.

The runtime does not give the model:

- shell access;
- filesystem access;
- arbitrary HTTP requests;
- process or subprocess execution;
- dynamically loaded tools;
- browser access;
- production credentials.

The application itself writes its SQLite database and serves built UI files. The optional provider adapter makes configured HTTPS requests. These application operations are not model tools, and provider output cannot select paths, URLs, or credentials. Static asset reads remain inside the build directory. The calculator accepts numbers and an enum, never executable expressions.

## Memory and privacy

Only the explicit user message grammar can write facts. A provider cannot write, delete, rank, or maintain memory. Keys and values have bounded lengths; the store caps facts at 32. SQL parameters keep values separate from statements. Facts are intentionally shared by all local demo connections, without tenant separation.

Use synthetic facts only. SQLite is not encrypted. The browser displays conversation and fact values, and the optional API receives bounded conversation and facts. Lifecycle logs/events contain counts and outcome metadata; calculator results are visible numbers. They exclude conversation text, fact values, prompts, API keys, environment dumps, provider bodies, and raw error messages. Chat text is never persisted in the event table. The database and `.env` are ignored by Git.

## Transport and resource limits

The runtime binds to `127.0.0.1`, accepts only local Hosts, and requires the exact same HTTP Origin for browser requests. Non-browser local clients may omit Origin. This mitigates unsolicited browser access and DNS rebinding; it does not authenticate local processes. Do not expose it publicly by changing the binding or bypassing the checks.

WebSocket ingress validates strict client actions, rejects binary and malformed messages, bounds frame/message size, caps connection and message counts, and disallows concurrent turns per session. Slow clients are closed when their send queue exceeds the configured cap. Heartbeats clear dead sockets. Built static responses include a restrictive CSP and `nosniff`.

Provider output is schema-validated, limited to 64 KiB, and subject to a deadline. Redirects are refused. Errors use fixed public codes, so provider exceptions cannot leak a key, endpoint, prompt, or response body. The optional provider URL is operator configuration, never model-controlled. The default fake provider makes no requests.

The calculator has a bounded operation count and asynchronous timeout. Timeouts do not kill CPU-blocking functions; the single fixed operation avoids that requirement. No generalized executor is exposed.

## Release and operational limits

There is no authentication, tenant isolation, encrypted storage, event retention daemon, distributed runtime, production moderation framework, or crash-recovery workflow. Event history grows on disk and is intended for short local demonstrations. Delete the ignored `data/` directory while stopped to clear demo facts and events. Public deployment would require a separate operational/security design.

Before publishing source, run the four documented checks and inspect tracked files for secrets, private URLs/usernames, copied private implementation details, and machine-specific paths. The repository includes placeholders only and is not automatically pushed. Live commercial-provider compatibility must be checked against an explicitly configured endpoint.

# Server changes

## 0.1.0-dev.12 — 2026-10-20

- Correct native Inverna position framing and authenticate the sender slot.
- Preserve omitted trainer names and propagate name, look, outfit and art changes.
- Prevent world allocation while the host remains in Inverna.
- Add optional six-letter community friend codes; existing configs keep them off.
- Add signed owned PTTR pack publication, persistent selection and native gallery routes.
- Run all backend test files in CI; all 40 checks pass.

The user confirmed native gameplay, friend battles and trading with matching
prepared 0.1.7 clients on the combined backend. The separate source gameplay
client is still being rebuilt. Public matchmaking, unattended game simulation,
cross-server federation and complete interruption recovery remain unfinished.

Back up mutable data and keep accounts, keys, saves and journals when replacing
server files. This source package requires Node.js 24.12 or newer and includes
vendored dependencies; it contains no game executable or assets.

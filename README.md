# Pokemon Platinum Together Open Sourced - Server

Compatible private accounts, unique usernames, friends, parties, relay routing,
chat, owner-signed mail and SQLite world/save storage. Original game assets and
official backend code are not included. Native unattended simulation is unfinished.

## Download

**[Download the shared server / relay source â€” dev11 preview](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-server/releases/download/v0.1.0-dev.11/PokemonPlatinumTogetherOpenSourced-Server-dev11.zip)**

Extract the ZIP, install Node.js 24.12 or newer, and follow [Setup and tests](#setup-and-tests)
and the [complete hosting guide](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher/blob/main/PrivateServer/docs/server-hosting.md).
The package includes vendored dependencies, config examples and tests. Enroll the
owner locally before exposing the listener. Keep generated account/data files private.

[Release notes and SHA-256 checksum](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-server/releases/tag/v0.1.0-dev.11).
[All five projects and downloads](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher#downloads).
The public dev11 build is the **Latest release** and remains a **development preview**.
For Windows apps and bundled runtimes, use the [full Windows bundle](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher#downloads).

## Related projects

- [Launcher, mail app and full documentation](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher)
- [Server and relay backend](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-server)
- [Map Studio and trainer sprite tools](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-editors)

## Setup and tests

Use Node 24.12 or newer. The vendored `ws` dependency keeps its MIT license.

```powershell
node --test test/backend.test.mjs
node main.mjs enroll --data ./Data --name HostName --url http://127.0.0.1:8788 --out ./Data/host.json
node main.mjs serve --data ./Data --port 8788 --bind 127.0.0.1 --url http://127.0.0.1:8788
```

Enrollment is one-time; keep the generated profile private. Never commit `Data`.

- [Complete server hosting guide](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher/blob/main/PrivateServer/docs/server-hosting.md)
- [Players, names and invites](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher/blob/main/PrivateServer/docs/players.md)
- [Owner mail and gifts](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher/blob/main/PrivateServer/docs/mail-and-gifts.md)
- [Backups, updates and troubleshooting](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher/blob/main/PrivateServer/docs/maintenance.md)
- [Tested features and remaining native work](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher/blob/main/PrivateServer/docs/status.md)

Developed with OpenAI Codex assistance. GPL-3.0-or-later; vendored third-party code
keeps its own license. The original game authors retain credit for their game.


## Server files and hosting roles

The backend is independent of the launcher. Configuration lives in `server.json`.
Server administration uses the host CLI. The launcher no longer contains ban,
plugin or network-setting panels.

```sh
node main.mjs init-config
node main.mjs check-config
node --test test/backend.test.mjs test/config.test.mjs
node main.mjs serve --config server.json
```

Read [all config keys and precedence](docs/server-config.md) and
[bans, local owner commands and the plugin API](docs/moderation-and-plugins.md).
The example config contains no account credentials. Never commit your actual
server.json or Data directory. Use separate data/config directories for each server.

`inverna` enables city/social protocols and rejects realm allocation; `world`
enables realm storage/party protocols and rejects city entry. `combined` retains
legacy development behavior. Native world simulation and federation between
separate role deployments are still unfinished.

The sibling hosting projects `pokemon-platinum-together-open-sourced-inverna-server` and
`pokemon-platinum-together-open-sourced-world-server` contain provider, Docker, Linux service, Windows,
relay and backup instructions. These are development source previews.
They both use this shared engine rather than maintaining incompatible copies.

## Joined-world history

Authenticated launcher clients use `private.worlds.list` over the signed lobby
connection. History is scoped to the current account. A realm invitation or
allocated ticket does not create history: realm/relay authentication must succeed.
Realm entries disappear from the returned history after membership is revoked.
History survives server restart. Protocol authentication does not prove native
gameplay has loaded successfully; that remains a separate release check.


### Native co-op relay entry (0.1.5)

The combined role advertises `player_worlds` for the tested manual relay path.
The Inverna and persistent-world roles keep that capability disabled.
The host uses **Host my world â†’ Use Relay**. The guest first loads a local world,
joins the host's code through Friends, then selects **Menu â†’ Party â†’ Join World**.
Two unmodified local clients completed this sequence and repeated it after backend
restart. Party membership alone does not create the native pending world request;
never invent an unsolicited guest allocation to skip that check.
Automatic shortcut handoff, remote gameplay, Soul Link startup, cross-map
independence and unattended simulation remain incomplete.


## Dev11 interoperability checks

All 28 backend tests pass locally with the bundled Node 24 runtime. Relay tests
authenticate and route both an older fixture build and the official 0.1.7 gameplay
release ID. They check world/session/seat/epoch/roster fields, native ready limits,
wrong-build refusal without consuming a valid ticket, replay rejection and binary
forwarding. These are protocol tests, not an ordinary two-player 0.1.7 gameplay
pass. See the launcher status page for remaining native acceptance checks.

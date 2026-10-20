# Plat Together Server

Compatible private accounts, unique usernames, friends, parties, relay routing,
chat, owner-signed mail and SQLite world/save storage. Original game assets and
official backend code are not included. Native unattended simulation is unfinished.

## Related projects

- [Launcher, mail app and full documentation](https://github.com/dr4lera/plat-together-open-sourced)
- [Server and relay backend](https://github.com/dr4lera/plat-together-server)
- [Map Studio and trainer sprite tools](https://github.com/dr4lera/plat-together-map-studio)

## Setup and tests

Use Node 24.12 or newer. The vendored `ws` dependency keeps its MIT license.

```powershell
node --test test/backend.test.mjs
node main.mjs enroll --data ./Data --name HostName --url http://127.0.0.1:8788 --out ./Data/host.json
node main.mjs serve --data ./Data --port 8788 --bind 127.0.0.1 --url http://127.0.0.1:8788
```

Enrollment is one-time; keep the generated profile private. Never commit `Data`.

- [Complete server hosting guide](https://github.com/dr4lera/plat-together-open-sourced/blob/main/PrivateServer/docs/server-hosting.md)
- [Players, names and invites](https://github.com/dr4lera/plat-together-open-sourced/blob/main/PrivateServer/docs/players.md)
- [Owner mail and gifts](https://github.com/dr4lera/plat-together-open-sourced/blob/main/PrivateServer/docs/mail-and-gifts.md)
- [Backups, updates and troubleshooting](https://github.com/dr4lera/plat-together-open-sourced/blob/main/PrivateServer/docs/maintenance.md)
- [Tested features and remaining native work](https://github.com/dr4lera/plat-together-open-sourced/blob/main/PrivateServer/docs/status.md)

Developed with OpenAI Codex assistance. GPL-3.0-or-later; vendored third-party code
keeps its own license. The original game authors retain credit for their game.

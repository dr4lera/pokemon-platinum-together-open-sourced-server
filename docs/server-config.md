# Server configuration

Server settings live in `Server/server.json`, independently of launcher preferences.
Create it once with `node Server/main.mjs init-config`. Creation refuses to replace
an existing file. Validate edits with `node Server/main.mjs check-config`, then
restart the backend with `node Server/main.mjs serve --config Server/server.json`.
Explicit `--data`, `--port`, `--bind` and `--url` CLI flags override file values.
An explicit missing config is an error. Without a config, legacy CLI startup works.

| Setting | Meaning |
| --- | --- |
| `schema` | Must be `1`. |
| `name` | Public server name, 1-80 printable characters. |
| `role` | `inverna`, `world`, or legacy `combined`. |
| `data` | Private SQLite database, identity and receipts directory. |
| `network.bind` | Numeric IPv4/IPv6 listener. `127.0.0.1` is local; `0.0.0.0` listens on all IPv4 interfaces. |
| `network.port` | TCP port, 1-65535. |
| `network.publicUrl` | HTTP(S) origin players can reach; no path, credentials or query. `null` advertises loopback for local use. |
| `network.trustedLoopbackProxy` | Accept Cloudflare client IP only from a loopback TCP peer. Enable only for your own local Cloudflare tunnel. |
| `logging.enabled` | Write local event metadata to `events.jsonl`. |
| `plugins.enabled` | Global plugin switch. False prevents all plugin imports, including reload. |
| `plugins.directory` | Folder containing per-plugin directories and manifests. |

Relative paths resolve against the config file, independent of the current working
directory. Plugin directory and data directory are separate explicit paths. Unknown
keys, invalid types and malformed files fail startup rather than silently using defaults.
No password, identity seed or mail key belongs in this config.

## Inverna, world and server

The server is the process. Inverna is the shared lobby/town. A co-op world is a
separate gameplay/save space. The Inverna role exposes city/social features and
rejects realm allocation. The world role exposes realm storage and party protocols
and rejects city entry. The combined role preserves development compatibility.
Roles do not turn unfinished native features into working game modes.

Separate deployments currently have separate identities and name databases.
Federated account transfer, cross-server party handoff and native unattended world
simulation are unfinished. Do not copy one live database into both deployments.

## Bans and plugins

Bans are durable database records, managed using the local owner CLI, not launcher
settings. See [moderation and plugins](moderation-and-plugins.md). Plugin manifests
choose individual enabled modules; server config can disable the whole subsystem.
Story/map execution is still pending a native adapter; invented config keys cannot
enable it. Save snapshots and story state already stored by the realm protocol
remain in the world's server database.

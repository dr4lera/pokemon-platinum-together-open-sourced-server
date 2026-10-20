# Server administration: bans and plugins

Run these commands on the hosting machine. Administration requires the first
account's signing key and a fresh local challenge. Remote guests cannot ban users
or reload modules. Keep the owner profile outside public repositories.

```sh
node Server/main.mjs moderate --profile Data/launcher-player.json --action list-players --out players.json
node Server/main.mjs moderate --profile Data/launcher-player.json --action ban-user --target PlayerName --reason "Server rule violation"
node Server/main.mjs moderate --profile Data/launcher-player.json --action unban-user --target PlayerName
node Server/main.mjs moderate --profile Data/launcher-player.json --action ban-ip --target 192.0.2.10 --reason "Server rule violation"
node Server/main.mjs moderate --profile Data/launcher-player.json --action unban-ip --target 192.0.2.10
node Server/main.mjs moderate --profile Data/launcher-player.json --action list-bans --out bans.json
```

Output files refuse replacement. Read or move an earlier result before reusing its
name. User bans bind to stable account IDs, survive renames/restarts and disconnect
matching lobby, realm and relay connections. The owner remains available for recovery.
IP bans accept exact IPv4/IPv6 addresses; equivalent forms normalize. CIDR ranges
are not implemented. Shared networks can share one IP. Back up the stopped database.

For a local Cloudflare proxy, set `network.trustedLoopbackProxy` in server config.
Forwarded client headers from non-loopback peers are ignored. Owner-signed local
control still permits removing an accidental IP ban.

## Install a plugin

Copy `Server/examples/hello` into the configured plugin directory as `hello`.
Set `enabled` to true in `hello/plugin.json`. Existing plugin files are yours to
preserve; installation must not overwrite them without review.

```json
{"id":"hello","version":"1.0.0","entry":"main.mjs","enabled":true}
```

```sh
node Server/main.mjs moderate --profile Data/launcher-player.json --action plugins-reload
node Server/main.mjs moderate --profile Data/launcher-player.json --action plugins-list --out plugins.json
```

Use `/hello` in the existing game chat. Replies are private to the sender.
Plugin folders contain `plugin.json`, one entry `.mjs` and a `data/` directory for
persistent module data. IDs use a lowercase initial letter, letters/digits/hyphens,
maximum 48 characters. Disabled manifests are not imported. A global false
`plugins.enabled` in server config prevents every plugin from loading.

Plugins have the server account's OS permissions. Worker isolation limits hangs and
failures; it is not a file/network permissions sandbox. Restart/reload resets module
variables, so durable state belongs in the supplied data directory. Native story,
map and battle hooks are not implemented yet.

## API v1

Export one handler:

```js
export async function onEvent(event, context) {
  if (event.type === 'command')
    return {reply: `Hello ${event.data.username}: ${event.data.args}`};
  if (event.type === 'call')
    return {ok: true, arguments: event.data.args};
}
```

`context.dataDirectory` is the plugin's persistent local storage directory.
Module variables reset on reload, so store durable state in that directory.

| Event | Data | Result |
|---|---|---|
| `server.started` | Public server URL | Ignored |
| `player.connected` | Account ID, username | Ignored |
| `player.disconnected` | Account ID | Ignored |
| `world.saved` | Realm ID, account ID, save counter | Ignored |
| `chat.message` | Public channel, text, account ID, username, operation ID | Ignored |
| `command` | Channel, account ID, username, argument string; `event.op` | Optional `{reply: "text"}` |
| `call` | Account ID, username, JSON arguments; `event.op` | JSON result |

Type `/plugin-id arguments` in existing chat. Commands and responses are private
to their sender and saved in that player's history. Replies are marked as system
output with a plugin label. Retrying the same operation returns the saved reply
without executing the command again. Replies allow 400 UTF-8 bytes before the
label. Unknown or disabled plugin commands remain ordinary chat text.

Custom clients can send `plugin.call` with `plugin`, UUID `op`, and JSON `args`.
`plugin.result` echoes the plugin and operation with the returned `data`.
Arguments are capped at 4 KiB; results at 8 KiB. Each worker processes events in
order with a queue limit of 16, one-second handler deadline and 32 MiB JS heap.
A failed/hanging worker is disabled until owner reload. At most 16 plugin folders
load. Other plugins and the core server continue working.

Plugins do not yet provide native map rendering, battles, story-script execution
or unattended simulation. Those game adapters remain separate unfinished work.

## Owner CLI

Run from the complete portable folder:

```powershell
.\Runtime\node.exe .\Server\main.mjs moderate --profile .\Data\launcher-player.json --action list-players --out .\players.json
.\Runtime\node.exe .\Server\main.mjs moderate --profile .\Data\launcher-player.json --action ban-user --target SomeName --reason "Server rule violation"
.\Runtime\node.exe .\Server\main.mjs moderate --profile .\Data\launcher-player.json --action unban-user --target SomeName
.\Runtime\node.exe .\Server\main.mjs moderate --profile .\Data\launcher-player.json --action ban-ip --target 203.0.113.8
.\Runtime\node.exe .\Server\main.mjs moderate --profile .\Data\launcher-player.json --action plugins-reload
```

`--out` creates a new result file and refuses to overwrite an existing one.
Keep owner profiles private.

Source: [server and plugins](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-server),
[launcher and documentation](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher).

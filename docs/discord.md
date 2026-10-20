# Discord presence and game invites

Application ID: `1561916972508385380`. Open the Discord desktop app, then the
launcher. **Help & source → Show activity on Discord** controls local IPC presence.
No Discord account token, bot token or OAuth login is used. The logo asset key is
`logo`; upload `Launcher/Assets/private-worlds.png` in the
[application portal](https://discord.com/developers/applications/1561916972508385380/rich-presence/assets).
The application name and image are managed there. Presence includes elapsed time
and links to [source](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-launcher) and
[hosting](https://github.com/dr4lera/pokemon-platinum-together-open-sourced-server).

## Invite a friend

1. Run backend revision 5 or later. In the **server's** `server.json`, configure
   `network.publicUrl` with the reachable HTTPS origin from your reverse proxy or
   relay. WebSocket upgrades must reach the same backend. Keep hosting settings
   in server configuration, not the launcher.
2. Sign in through the launcher and start the private game. Create/lead a party
   using the existing game controls. Keep the launcher open with Discord enabled.
3. The launcher refreshes party metadata every 20 seconds; Discord updates at most
   15 seconds afterward. Its status shows **party invites ready** when advertised.
   Use Discord's own invite-to-game control where Discord offers it.
4. The recipient opens the invite and confirms its server address in the launcher.
   Their own saved name/key on that server is used. A first-time player must choose
   a name. A game on another server must be saved and closed before switching.

**Current limit:** joining the authenticated backend party is implemented; the
native automatic transition from that party into the host world is still under
development. Do not describe this preview as completed one-click multiplayer.
Native movement synchronization has passed an isolated local test using the
research entry path, not the normal invite handoff.

## Open the launcher from a Discord invite

Click **Enable Discord invite launch** in the existing Help card. It registers
`discord-1561916972508385380://` for the current Windows user, with a quoted path
to this portable EXE. No administrator rights are needed. Repeat after moving the
portable folder. An already-open copy receives activation through a bounded,
current-user-only pipe. The launcher also accepts `--join <invite-URL>`; it treats
that URL as untrusted input, validates it, and confirms the destination.

## Privacy, expiry and troubleshooting

- A join secret is a random party capability URL, valid for ten minutes. It is
  refreshed while the host remains online. The URL necessarily identifies the
  public server; never configure a private/secret hostname as its public origin.
- It never contains an account seed, login/refresh token, relay ticket or save.
  Link resolution does not authenticate or join anyone. Normal account ownership,
  party capacity and bans still apply. Links expire on backend restart, party
  removal or leadership change; an offline host cannot resolve an invitation.
- Only HTTPS DNS origins are advertised. Loopback and numeric IP hosts are not
  advertised as Discord invites. Long origins exceeding Discord's 128-byte join
  secret limit are refused. Configure a short public hostname.
- The app does not automatically send invites/messages, accept join requests, or
  publish spectator access. Discord privacy/client settings may hide its controls.
- If the logo is missing, verify the asset upload and processing in the portal.
  An accepted IPC command does not prove the image is displayed.
- Local tests cover SUBSCRIBE/SET_ACTIVITY acceptance by Discord, event handling
  during command acknowledgements, ping/pong, malformed URL rejection, backend
  expiry/ownership and authenticated joins. A real two-person Discord invite and
  native world transition remain unverified.

Protocol references: [Discord RPC](https://docs.discord.com/developers/topics/rpc)
and [Rich Presence IPC events](https://github.com/discord/discord-rpc/blob/master/documentation/hard-mode.md).

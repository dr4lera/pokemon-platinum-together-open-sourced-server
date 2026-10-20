# Own-client link sessions, protocol 1

This original transport supplies authenticated, ordered, ephemeral node-to-node
bytes for the source client's wireless adapter. It does not implement a wireless
semantic provider, battle, trading, persistent worlds, Inverna actors or save
reconciliation. It does not use `/relay`, allocate a world ID, publish a save or
add world-history records. A successful transport test is not gameplay parity.

## Enable and prepare

The default is off. Set `"communityLink":{"enabled":true}` in server config,
or `communityLinkEnabled:true` in `Hub` options. Only the combined server role
supports it. Authenticated lobby ready/server-info features expose
`community_link`; the dedicated upgrade route is `/community-link` and returns
404 when disabled. Keep normal TLS and pinned-server verification in the client.

Every participant must first authenticate its existing account on `/lobby`,
using an own-client build ID. Create/join a normal existing party (2–4 members).
On each participant's exact live lobby socket, send:

```json
{"t":"community.link.prepare","build":"community-client-link-v1","catalog":"<64 lowercase SHA-256 hex>","rules":"<64 lowercase SHA-256 hex>"}
```

`build` must match the authenticated lobby build exactly, and match
`community-client-[A-Za-z0-9._-]{1,100}`. `catalog` and `rules` are exact lowercase
SHA-256 hex fingerprints of client-defined, versioned canonical catalog/rules
materials. The server compares them; it does not certify their contents. All
members must use the same three fields. Reply: `community.link.prepared` plus
those fields. Each account must have exactly one matching prepared online lobby
socket at allocation; ambiguous prepared sockets are refused.

The party leader then sends:

```json
{"t":"community.link.open","request_id":"<lowercase UUID>"}
```

The server freezes the party ID, ordered membership/leader, exact lobby sockets,
authenticated account keys, build and fingerprints. Each participant receives
its own `community.link.offer` on its bound lobby socket:

```text
{ t, pt:1, session:UUID, epoch:positive integer, party:UUID,
  build, catalog, rules, roster_hash:SHA256hex,
  roster:[{seat:0..3,player:decimal-string,key:base64-Ed25519-public-key,
           mac:12-lowercase-hex}],
  expires_at_ms, player, key, seat, ticket:base64-32bytes,
  ticket_expires_at_ms, link_url:"wss://origin/community-link" }
```

The roster is complete and immutable for the session. The server derives a
locally administered unicast MAC from SHA-256 of UTF-8 `session + NUL + player`,
using its first six bytes and setting byte0 `(byte0 | 2) & 254`. MACs are stable
within this session. `roster_hash` is SHA-256 of UTF-8 JSON serialization of
`roster`, with each object's keys in the displayed order and no extra whitespace.
`epoch` increases for each new allocation during one server lifetime; the UUID
also changes, so an epoch alone is never an identity across server restarts.

An active party has at most one session. Repeating the same leader request ID
on the same frozen lobby returns the same leader offer/ticket; it creates no
new session or tickets and does not resend guest offers. Consumed/expired tickets
are not revived. An ended request ID refuses with `link_request_closed` for at
least two minutes; clients must use a new UUID for new attempts. A different
open request while a session exists refuses with `link_session_active`.

Before attaching, a bound participant can request a replacement unused ticket:
`{t:"community.link.ticket",session,epoch}`. It invalidates the previous ticket
and sends one replacement offer. This is allowed only while that participant
is unattached and the session has not become active; it does not extend the join
deadline. Any bound participant can send `{t:"community.link.cancel"}` on its
lobby to end the session. Control commands have an elapsed-time budget of eight
initial commands, refilling one command per second per lobby socket.

## Signed attachment

Open `link_url` and send the following text JSON, using fields from the offer:

```text
{t:"community.link.hello",pt:1,ticket,session,epoch,build,catalog,rules}
```

The server reserves this single-use ticket to that socket and responds:
`{t:"community.link.challenge",nonce:base64-32bytes,session,epoch}`. Prove the
account's Ed25519 private key with `{t:"auth",sig:base64-64bytes}`. The signed
bytes are:

```text
ASCII("PT-COMMUNITY-LINK\0") || decoded_nonce32 || SHA256(binding_utf8)
binding_utf8 = JSON.stringify([
  1, session, epoch, party, player, key, seat, build, catalog, rules,
  roster_hash, SHA256(decoded_ticket32).hex_lowercase
])
```

No whitespace is inserted; all strings/integers above are the exact offer
values. Existing `proofBytes`/`checkProof` and canonical base64 helpers implement
the domain proof, and `communityLinkTail(offer)` supplies the binding hash for
tests/adapters. A signature over a nonce alone is insufficient. A bad proof
consumes the reserved ticket; it does not evict an already attached other peer.

Reply: `{t:"community.link.ready",pt:1,...sessionDescriptor,seat,active,limits}`.
The descriptor contains session/epoch/party/build/catalog/rules/roster/hash and
expiry, without any ticket. Every attachment also publishes
`{t:"community.link.peers",session,epoch,active,connected:[seat,...]}` to all bound
lobbies and attached link sockets. **Wait for `active:true` before transmitting
binary packets.** Active requires every frozen member to attach. No automatic
reattachment, frame replay or ambiguous trade continuation exists.

Tickets expire in at most 30 seconds; the entire roster must attach within 30
seconds of allocation. Proofs expire within five seconds. Session lifetime has
a fixed hard deadline 30 minutes after allocation. Each bound lobby must remain
live with current signed credentials for its original account/key. A normal
same-key lobby renewal preserves the session past the previous token's expiry;
it cannot extend the fixed session deadline or change the frozen identity.
Unrenewed/expired lobbies still end the session. Send `{t:"ping",ts:safeInteger}`
on the link socket for `{t:"pong",ts}`; existing connection idle expiry is 90
seconds. Clients must enforce their own matched-pong timeout too.

## Binary envelope and lifetime

One WebSocket binary message is one envelope:

| Bytes | Client → server | Server → client |
| --- | --- | --- |
| 0 | version `1` | version `1` |
| 1 | destination seat `0..3`, or `255` broadcast | authenticated sender seat |
| 2.. | 1–8192 opaque payload bytes | identical opaque payload bytes |

The server rejects self/unattached destinations, wrong version and empty or
oversized payloads. Broadcast excludes the sender. It rewrites byte1 from the
authenticated socket; there is no client-selected sender. WebSocket ordering
and message boundaries are retained. The byte/frame budget is 120 frames/second,
262144 bytes/second with a 262144-byte burst, counting the two-byte header.
Before sending to any receiver, all target buffers must remain at or below
1048576 bytes including the outgoing frame. A failure ends the entire session
rather than silently discarding packets or partially broadcasting that frame.

Seats are authenticated node-routing slots, **not DS AIDs**. Seat0/party leader
does not select a DS MP parent. The runtime semantic provider must map sender
node/MAC to the current parent/child group, validate inner claimed AIDs, allocate
child AIDs and validate all WM metadata/port/payload lengths. None of those
claims becomes trusted merely by appearing inside opaque payload bytes. Receiver
packet buffers must remain alive through actual ARM9 acknowledgment; this
server cannot manage that memory lifetime.

Any frozen party membership/leader, account key, build or fingerprint change,
bound lobby disconnection or credential expiry ends the session. An attached link disconnect sends
`{t:"community.link.peer_left",session,epoch,seat,player,reason:"disconnected"}`,
then `{t:"community.link.ended",session,epoch,reason}`. Explicit link leave
`{t:"community.link.leave"}` or lobby cancellation also ends it. Protocol/rate/
backpressure errors send `{t:"err",code,fatal:true}` to the offending socket,
end the session and close the transports. Ended events go to bound lobbies and
attached link sockets when writable. Stop/cancel native wireless callbacks,
discard queued packets and require a fresh explicit session after any end or
socket failure. Do not silently replay packets or resume a pending trade.

## Verification boundary

`node --test test/community-link.test.mjs` uses generated disposable account
keys, actual lobby party membership, signed WebSocket joins and real loopback
binary delivery. It covers four peers, idempotency, key/proof/epoch/ticket
rejection, roster/lobby/fingerprint teardown, credential and hard-deadline expiry,
signed same-key renewal past the old token expiry, and sender rewriting.
Rate tests freeze only the budget clock; backpressure tests inject a full
receiver-buffer getter to make the refusal deterministic. Existing full backend
tests also run. This verifies transport contracts, not native UI, DS emulation,
an ARM9 callback provider, battles, trades or saves. No public service is changed.

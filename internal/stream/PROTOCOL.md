# m6t stream protocol

The wire contract between the Go backend (`internal/stream`) and the webview.
This file is the specification: the frontend is written against it, so a change
here is a protocol change and needs the other side changed with it.

Rationale for the transport itself is in [DESIGN.md](../../DESIGN.md) §3.3. In
short: the Wails bridge is right for RPC and wrong for a terminal, so
throughput-sensitive data goes over a loopback WebSocket instead.

## 1. Discovery

The listener binds `127.0.0.1` on an OS-assigned port and mints a bearer token
from `crypto/rand` at construction. Both are per launch.

The frontend obtains them from the Wails binding `App.StreamEndpoint()`:

```json
{ "port": 51234, "token": "K7QF2V..." }
```

The token is not logged, not written to disk, and not carried in any other
binding. `StreamEndpoint` fails until the listener is up, and its error says why.

## 2. Authentication

Every connection must present the token, in one of two forms.

**Header** — for clients that can set request headers (Go tooling, tests):

```
Authorization: Bearer <token>
```

**Subprotocol** — for the browser `WebSocket` API, which cannot set headers. The
client offers two subprotocols: the version, and the token.

```
Sec-WebSocket-Protocol: m6t.v1, m6t.token.<token>
```

The server selects `m6t.v1`. A browser that offers subprotocols requires the
server to select one, so the version entry is not optional in this form.

When both forms are present the header wins.

## 3. Refusals

Every refusal is a plain HTTP response. No connection is ever upgraded and then
closed for a reason that could have been reported before the handshake.

| Condition | Status |
|---|---|
| Missing or wrong token | `401` |
| `Origin` present and not allowed | `403` |
| Unknown terminal session | `404` |

Allowed origins: absent, the Wails webview (`wails://…` on macOS and Linux,
`http://wails.localhost` on Windows), and loopback (`localhost`, `127.0.0.0/8`,
`[::1]`) on any port. `null` — what a `file://` document and a sandboxed frame
report — is refused. An absent `Origin` is allowed because browsers always send
one, so a request without it is a non-browser client for which the token is the
defence.

## 4. Endpoints

### `GET /pty/{sessionID}`

The character stream for one terminal session.

- **Binary frames** carry raw PTY bytes. Client to server they are the child's
  stdin; server to client they are its output, byte for byte, no framing of their
  own. The first server frame after connecting is the scrollback replay, when the
  session has any.
- **Text frames** carry control messages (§5).

Closing the socket does **not** end the session. PTYs are backend-owned and
survive a webview reload or a project-tab switch, so ending one is an explicit
`close` message. Reconnecting to the same `sessionID` replays the scrollback and
resumes the stream.

The server closes the socket with a normal closure (`1000`) after it has written
the `exit` frame.

### `GET /events`

Backend-push events. Server-to-client text frames only; anything the client
sends is discarded.

PTY exit is the only event type today, and it is published by the terminal
connection that observes it. A session that ends with no socket attached is
therefore not announced — when something other than the terminal tab needs to
know, the fix is a dedicated attachment that watches the session, not a change to
this protocol. Two sockets attached to the same session both publish, so a
consumer must treat `exit` as idempotent rather than counted.

The git, watch and helm services push onto this same socket as they land, which
is why the envelope carries a type rather than the endpoint implying one.

## 5. Control and event frames

All text frames on both endpoints share one envelope:

```json
{ "type": "<name>", "payload": { } }
```

`payload` is omitted when a type carries no data. A field named `projectID` is
reserved at the top level for when projects exist (issue #5); it is not sent
today, and a decoder must tolerate its absence.

An envelope whose `type` is unknown, or which does not decode, is **ignored** —
not an error and not a reason to close. That is what lets either side add a
message without the other having to be updated in lockstep.

### Client to server (`/pty/{sessionID}`)

| Type | Payload | Effect |
|---|---|---|
| `resize` | `{"cols": <uint16>, "rows": <uint16>}` | Sets the window size the child sees. A zero dimension is replaced by the default (80×24) rather than passed through. |
| `close` | — | Ends the session and its child: hangup first, then `SIGKILL` after a grace period. The server writes the resulting `exit` frame and *then* closes the socket, so a close never costs the client the exit status. |

### Server to client

| Type | Payload | Meaning |
|---|---|---|
| `exit` | `{"code": <int>}` | The child ended. `-1` means it was terminated by a signal rather than exiting on its own. Sent on `/pty/{sessionID}` and published on `/events`. |
| `resync` | `{"droppedBytes": <int>}` | Output was discarded before the frame that follows (§6). |

## 6. Backpressure

A PTY child writes as fast as the terminal will take it. A webview that has
stopped reading — mid-repaint, mid-GC, or wedged — must not be able to stall it,
because that would freeze the user's shell.

So each connection has a **fixed-size outbound queue**, and a full queue
**discards its oldest frame** to make room. The producer never waits.

Discarded bytes are counted, never hidden. The next frame written on that
connection is **preceded by a `resync` frame** carrying the number of bytes lost
since the last one. When output is dropped after the final data frame, the
trailing `resync` is written before the socket closes, so the accounting always
balances: for any connection, bytes received plus bytes reported dropped equals
bytes the session produced.

A `resync` means the character stream has a hole in it. A renderer must not paint
across one: escape sequences do not survive truncation, so the correct response
is to clear and redraw from a fresh attach rather than continue.

The same queue backs `/events`, so a `resync` can arrive there too. It means
events were discarded for a subscriber that fell that far behind — there is no
character stream to redraw, so a consumer's response is to refetch whatever state
the missed events would have updated.

## 7. Limits

| Limit | Value | Why |
|---|---|---|
| Inbound message size | 1 MiB | Terminal input is keystrokes and pastes; anything near this is a bug or an attempt to make the backend allocate. |
| Outbound queue | 64 frames | Roughly 2 MiB at PTY chunk size — enough to absorb a render stall, not enough to absorb a wedged webview. |
| Request header timeout | 5 s | A local client is immediate; this stops an opened-and-abandoned socket from holding a handler. |
| Shutdown grace | 2 s | The app is quitting; a connection that will not close is dropped. |

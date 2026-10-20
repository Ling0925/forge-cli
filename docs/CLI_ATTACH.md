# Optional local host attachment

Standalone `forge chat`, `forge run`, history and resume remain unchanged. They
create a process-local Harness and share persisted history, not live controllers.
`forge attach` is an explicit alternate entry and never creates a Harness if the
selected host is missing, disconnected or incompatible.

## Entrypoints

Linux only. Use an absolute socket path shorter than 101 UTF-8 bytes inside a
private directory owned by the current user. Ancestor symlinks, non-private
parents, occupied paths and sockets owned by other users are rejected. Newly
created directories are mode 0700; the socket is 0600. There is no TCP listener,
public relay, login or credential provisioning in this transport.

- Headless: `forge host --socket /private/forge/host.sock`
- Desktop: start the existing desktop process with
  `FORGE_HOST_SOCKET=/private/forge/desktop.sock`. Its worker adds the endpoint
  to the **same** Runtime Hub used by desktop IPC and its attached LAN server.
- Built standalone Web: add `--socket /private/forge/web.sock` to the Web server
  arguments. Local attachment and Web requests use the same injected Runtime Hub.
- The Vite development Web entry is unchanged; it does not advertise a socket.

An occupied path is never deleted automatically, including a stale socket after a
crash. Verify its owner has exited before removing it yourself. Stopping a host
explicitly stops its listeners and then disposes/cancels its runtime. Stopping an
attach connection does not stop the host.

## CLI commands

Use `forge attach --help` for command syntax.
All output is JSON/JSONL, separate from the standalone interactive terminal UI.

- `status`: host identity, protocol version, active run/session IDs, pending
  approvals and stopping state. Historical sessions are not active ownership.
- `sessions`, `show SESSION`, `create WORKSPACE`: existing shared RPCs.
- `run SESSION "prompt"`: start on the host and return its run handle. The CLI
  connection then exits; the host continues. Use `rpc` for other RunInput fields.
- `watch [RUN_ID]`: print recovery state and live events. Ctrl+C closes observation
  and returns 130. It never implicitly cancels a run.
- `cancel RUN_ID`: explicit cancellation, with acknowledgement delayed until the
  host's runtime operation, tool cleanup, approvals and child cleanup converge.
- `steer RUN_ID "prompt"` and `approve RUN_ID APPROVAL_ID yes|no`: existing live
  controls. The first approval answer wins; late answers cannot approve another
  request. Unknown/non-owned run IDs return an error.
- `rpc '{"method":"...", ...}'`: one validated existing RPC request; the CLI
  assigns a fresh request ID. This includes durable queue methods; desktop-only
  dialogs are rejected. Do not put
  secrets in shell arguments/history; configure credentials through existing
  secure configuration paths instead.

Options precede the subcommand. The CLI prints `hostId` on every output envelope.
For reconnect, pass `--host-id UUID --cursor N` using the last processed event's
cursor. A cursor must accompany its original host ID. Host IDs are per runtime
instance, not persisted session IDs; a restart or different host rejects the old
identity. Deliberately reconnect without it to inspect the new host.

## Wire and recovery contract

Protocol version 1 wraps the existing RPC/response/RunEvent schemas in bounded
UTF-8 JSONL. A handshake supplies host state, a connection ID, event cursor and
replay or an explicit recovery reset. State/recovery/cursor are captured in one
synchronous host step, avoiding a gap before live delivery. `getHostState` also
works over ordinary RPC; restricted Web hosts filter its runs by workspace.

Requests carry host ID, connection ID, monotonic per-connection sequence and UUID
correlation ID. Repeated sequences and old connection envelopes are rejected.
Clients retain up to 4,096 request IDs per connection, reject reuse, and never
reconnect/replay requests automatically. A timeout or disconnect means effects
may be uncertain; inspect host/session state. A newly constructed request is a
new user action, not proof the old one did nothing. Durable input acceptance may
be explicitly retried with its stable input ID as documented in INPUT_QUEUE.md.

Bounds: 32 connections, 128 in-flight requests per connection, 16 MiB request
frames, 64 MiB response/send buffers, 2,048 retained events or 4 MiB, and a 5-second
handshake deadline. The client also bounds its pre-subscription event backlog.
Normal requests time out after 120 seconds without replay. If the event cursor
falls outside retention, `reset: true` supplies active recovery state; obtain
persisted sessions for complete history. A host restart is never treated as
continuation of the previous host's cursor.

## Verification and remaining integration gate

The protocol/control suite runs both against real Unix sockets
(`tests/host/local-host.test.ts`) and a deterministic in-memory duplex test double
(`tests/host/local-protocol.test.ts`). The latter covers attach start, disconnect,
replay/gaps, identity/version rejection, racing approvals, explicit cancellation
join, duplicate envelopes, timeout uncertainty, and observation Ctrl+C. Framing
and private-path tests are separate. Existing real loopback LAN tests cover the
same hub's identity/control and lifecycle.

The implementation workspace disallows Unix socket binding (`listen EPERM`), so
real Linux socket integration and a launched desktop/CLI/LAN combination remain
unverified. The native suite is committed unchanged and must be run in an allowed
Linux environment before treating issue #4's end-to-end acceptance as complete.
The draft PR intentionally does not close that issue. No desktop packaging,
installation, real provider call or device enrollment is part of this validation.

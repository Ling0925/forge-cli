import { randomUUID } from "node:crypto";
import { hostError } from "../host/errors";
import { connectLocalHost } from "../host/local-client";
import { rpcRequestSchema } from "../shared/ipc";
import type { CliIO } from "./cli";

export const attachHelp = `forge attach --socket /private/directory/host.sock [--host-id UUID] [--cursor N] <command>
Commands (JSON/JSONL output):
  status | sessions | show SESSION | create WORKSPACE
  run SESSION PROMPT | watch [RUN_ID]
  cancel RUN_ID | steer RUN_ID PROMPT | approve RUN_ID APPROVAL_ID yes|no
  rpc JSON (one existing Forge RPC request without id)
run returns the host-owned handle. watch observes only; Ctrl+C/disconnect leaves work running.
cancel explicitly aborts and waits for host cleanup. Timeouts/disconnects never replay requests.
Use --host-id and --cursor from event output to resume the same host; a changed host fails explicitly.
`;

export async function runAttach(
  argv: readonly string[],
  io: Pick<CliIO, "stdout" | "stderr" | "onInterrupt">,
): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    io.stdout(attachHelp);
    return 0;
  }
  const args = [...argv];
  const options = new Map<string, string>();
  while (args[0]?.startsWith("--")) {
    const name = args.shift() ?? "";
    if (name === "--help") {
      io.stdout(attachHelp);
      return 0;
    }
    if (
      !["--socket", "--host-id", "--cursor"].includes(name) ||
      options.has(name)
    )
      throw hostError(`Unknown or repeated attach option ${name}.`);
    const value = args.shift();
    if (!value || value.startsWith("--"))
      throw hostError(`Missing value for ${name}.`);
    options.set(name, value);
  }
  const socketPath = options.get("--socket");
  const hostId = options.get("--host-id");
  const rawCursor = options.get("--cursor");
  if (!socketPath)
    throw hostError(
      "Attach requires --socket. It never creates a standalone Harness.",
    );
  const cursor = rawCursor === undefined ? undefined : Number(rawCursor);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
    throw hostError("Invalid event cursor.");
  const command = args.shift() ?? "status";
  const exact = (count: number) => {
    if (args.length !== count)
      throw hostError("Unexpected attach arguments. Use forge attach --help.");
  };
  let request: object | undefined;
  switch (command) {
    case "status":
      exact(0);
      request = { method: "getHostState" };
      break;
    case "sessions":
      exact(0);
      request = { method: "listSessions" };
      break;
    case "show":
      exact(1);
      request = { method: "getSession", sessionId: args[0] };
      break;
    case "create":
      exact(1);
      request = { method: "createSession", input: { workspace: args[0] } };
      break;
    case "run":
      exact(2);
      request = {
        method: "startRun",
        input: { sessionId: args[0], prompt: args[1] },
      };
      break;
    case "cancel":
      exact(1);
      request = { method: "cancelRun", runId: args[0], wait: true };
      break;
    case "steer":
      exact(2);
      request = { method: "steerRun", runId: args[0], prompt: args[1] };
      break;
    case "approve":
      exact(3);
      if (!["yes", "no"].includes(args[2] ?? ""))
        throw hostError("Approval must be yes or no.");
      request = {
        method: "answerApproval",
        runId: args[0],
        approvalId: args[1],
        approved: args[2] === "yes",
      };
      break;
    case "rpc":
      exact(1);
      request = JSON.parse(args[0] ?? "");
      break;
    case "watch":
      if (args.length > 1) exact(1);
      break;
    default:
      throw hostError("Unknown attach command. Use forge attach --help.");
  }
  const rpc = request
    ? rpcRequestSchema.parse({ ...request, id: randomUUID() })
    : undefined;
  const client = await connectLocalHost({
    socketPath,
    // Control requests may wait through long runs. Consume unrelated events
    // from the handshake onward instead of filling the bounded watch backlog.
    ...(rpc ? { onEvent: () => {} } : {}),
    ...(hostId ? { hostId } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const output = (value: object) =>
    io.stdout(`${JSON.stringify({ hostId: client.state.hostId, ...value })}\n`);
  let interrupted = false;
  const off = io.onInterrupt(() => {
    interrupted = true;
    void client.close();
  });
  try {
    if (rpc) {
      const response = await client.request(rpc);
      output({ kind: "response", response });
      return response.ok ? 0 : 1;
    }
    output({
      kind: "state",
      cursor: client.cursor,
      reset: client.reset,
      state: client.state,
    });
    const wanted = args[0];
    const show = (
      event: (typeof client.recovery)[number],
      at: number,
      recovery = false,
    ) => {
      if (wanted && event.runId !== wanted) return;
      output({ kind: "event", cursor: at, recovery, data: event });
    };
    for (const event of client.recovery) show(event, client.cursor, true);
    client.subscribe((event, at) => show(event, at));
    await client.closed;
    if (!interrupted)
      throw hostError(
        "The observed host disconnected. Reconnect explicitly to restore state.",
      );
    return 130;
  } finally {
    off();
    await client.close();
  }
}

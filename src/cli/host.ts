import { createHarness } from "../core/harness";
import { createRuntimeHub } from "../desktop/runtime";
import { hostError } from "../host/errors";
import { createLocalHost } from "../host/local-server";

export async function runHeadlessHost(
  args: readonly string[],
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "forge host --socket /private/directory/host.sock\nOptional headless shared host. SIGINT/SIGTERM explicitly stops the host and its tasks.",
    );
    return 0;
  }
  if (args.length !== 2 || args[0] !== "--socket" || !args[1])
    throw hostError("Use forge host --socket /private/directory/host.sock.");
  const runtime = createRuntimeHub(await createHarness());
  let local: Awaited<ReturnType<typeof createLocalHost>> | undefined;
  try {
    local = await createLocalHost({ runtime, socketPath: args[1] });
    console.log(`Forge shared host: ${local.path}`);
    await new Promise<void>((done) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        done();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  } finally {
    try {
      await local?.close();
    } finally {
      await runtime.dispose();
    }
  }
}

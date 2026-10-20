import { resolveStateDirectory } from "../core/state-directory";
import { ForgeError } from "../shared/errors";
import { openDeviceAuthorization } from "../store/devices";

export async function runDevices(
  args: readonly string[],
  output: (text: string) => void = (text) => process.stdout.write(text),
  directory = resolveStateDirectory(),
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    output(
      "forge devices pair NAME | list | revoke DEVICE_ID\nLocal device management for this FORGE_HOME. Pair prints a one-time five-minute token; exchange it with same-origin POST /api/pair. Treat tokens as secrets; HTTP is not confidential.\n",
    );
    return 0;
  }
  if (
    !(
      (args[0] === "list" && args.length === 1) ||
      (["pair", "revoke"].includes(args[0] ?? "") &&
        args.length === 2 &&
        args[1])
    )
  )
    throw new ForgeError(
      "invalid_input",
      "Use forge devices pair NAME | list | revoke DEVICE_ID.",
    );
  const devices = await openDeviceAuthorization({ directory });
  try {
    if (args[0] === "list") output(`${JSON.stringify(await devices.list())}\n`);
    else if (args[0] === "pair")
      output(`${JSON.stringify(await devices.createPairing(args[1] ?? ""))}\n`);
    else {
      await devices.revoke(args[1] ?? "");
      output(
        "Device revoked. Accepted tasks remain running; cancel explicitly to stop them.\n",
      );
    }
    return 0;
  } finally {
    await devices.close();
  }
}

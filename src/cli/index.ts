import { runDevices } from "./devices";
import { createHarness } from "../core/harness";
import { toErrorInfo } from "../shared/errors";
import { runCli } from "./cli";
import { runAttach } from "./attach";
import { runHeadlessHost } from "./host";

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  if (args[0] === "attach") return runAttach(args.slice(1), { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
    onInterrupt: callback => { process.on("SIGINT", callback); return () => { process.off("SIGINT", callback); }; } });
  if (args[0] === "devices") return runDevices(args.slice(1));
  if (args[0] === "host") return runHeadlessHost(args.slice(1));
  const service = await createHarness();
  try {
    return await runCli(process.argv.slice(2), service);
  } finally {
    await service.dispose();
  }
};

try {
  process.exitCode = await main();
} catch (error: unknown) {
  const info = toErrorInfo(error);
  process.stderr.write(`${info.code}: ${info.message}\n`);
  process.exitCode = info.code === "cancelled" ? 130 : 1;
}

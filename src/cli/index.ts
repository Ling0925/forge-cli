import { createHarness } from "../core/harness";
import { toErrorInfo } from "../shared/errors";
import { runCli } from "./cli";

const main = async (): Promise<number> => {
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

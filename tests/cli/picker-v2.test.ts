import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { TerminalReader } from "../../src/cli/terminal";

it("filters real values, navigates beyond page, cancels without consuming draft", async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 20, rows: 12 });
  const reader = new TerminalReader({ input, output, isTTY: true });
  await reader.ui.configure({ theme: "dark" });
  input.write("draft");
  const items = Array.from({ length: 20 }, (_, i) => ({
    value: `id-${i}`,
    label: `Model ${i}`,
  }));
  const pick = reader.ui.choose(
    { title: "Models", items },
    new AbortController().signal,
  );
  input.write("Model 1\x0e\x0e\r");
  expect(await pick).toBe("id-11");
  const cancel = reader.ui.choose(
    { title: "Models", items },
    new AbortController().signal,
  );
  input.write("\x1b");
  expect(await cancel).toBeNull();
  const question = reader.question("❯ ", new AbortController().signal);
  input.write("\r");
  expect(await question).toBe("draft");
  const abort = new AbortController();
  const cancelled = reader.ui.choose({ title: "Models", items }, abort.signal);
  abort.abort();
  expect(await cancelled).toBeNull();
  const empty = reader.ui.choose(
    { title: "Models", items: [] },
    new AbortController().signal,
  );
  input.write("\r");
  expect(await empty).toBeNull();
  reader.ui.dispose();
});

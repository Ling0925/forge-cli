import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalReader } from "./legacy/reader";
import { InputDecoder, type InputEvent } from "../../src/cli/terminal/decoder";
import { Editor } from "./legacy/editor";

function fixture(maxBytes = 10000) {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new TerminalReader({ input, output, isTTY: false, maxBytes });
  return { input, reader };
}
const signal = () => new AbortController().signal;

describe("fresh intentional consent", () => {
  it("requires complete typed y plus Enter, and repeated decisions are fresh", async () => {
    const { input, reader } = fixture();
    let settled = false;
    const first = reader.readApproval("Approve? ", signal()).then((v) => {
      settled = true;
      return v;
    });
    input.write("y");
    await Promise.resolve();
    expect(settled).toBe(false);
    input.write("\ry\r");
    expect(await first).toBe(true);
    const second = reader.readApproval("Again? ", signal());
    input.write("\r");
    expect(await second).toBe(true);
    reader.dispose();
  });
  it("rejects every fragmented paste marker and paste followed by typed Enter", async () => {
    const payload = "\x1b[200~y\x1b[201~\r";
    for (let split = 1; split < payload.length; split++) {
      const { input, reader } = fixture();
      const answer = reader.readApproval("Approve? ", signal());
      input.write(payload.slice(0, split));
      input.write(payload.slice(split));
      expect(await answer).toBe(false);
      reader.dispose();
    }
  });
  it("retains paste provenance across prompt transition and fragmented start", async () => {
    for (let split = 1; split <= 6; split++) {
      const { input, reader } = fixture();
      const first = reader.question("", signal());
      input.write("go\r\x1b[200~".slice(0, 3 + split));
      await first;
      const approval = reader.question("Approve? ", signal(), { fresh: true });
      input.write(`${"\x1b[200~".slice(split)}y\r\x1b[201~\r`);
      expect(await approval).toBe("no");
      reader.dispose();
    }
  });
  it("denies abort, EOF and overflow", async () => {
    for (const mode of ["abort", "eof", "overflow"]) {
      const { input, reader } = fixture(3);
      const abort = new AbortController();
      const answer = reader.readApproval("?", abort.signal);
      if (mode === "abort") abort.abort();
      else input.write(mode === "eof" ? "\x04" : "yyyy");
      expect(await answer).toBe(false);
      reader.dispose();
    }
  });
  it("typed n and Escape deny, paste Enter is not a decision", async () => {
    const { input, reader } = fixture();
    let done = false;
    const answer = reader.readApproval("?", signal()).then((v) => {
      done = true;
      return v;
    });
    input.write("\x1b[200~y\r\x1b[201~");
    await Promise.resolve();
    expect(done).toBe(false);
    input.write("\x1b");
    expect(await answer).toBe(false);
    const next = reader.readApproval("?", signal());
    input.write("n\r");
    expect(await next).toBe(false);
    reader.dispose();
  });
});

it("decoder consumes fragmented OSC replies, UTF8 and CRLF without composer pollution", () => {
  const events: InputEvent[] = [];
  const decoder = new InputDecoder((v) => events.push(v));
  for (const byte of Buffer.from("中\x1b]11;rgb:ffff/ffff/ffff\x1b\\\r\n"))
    decoder.feed(Buffer.from([byte]));
  expect(events).toEqual([
    { kind: "text", text: "中", pasted: false },
    { kind: "background", background: "light" },
    { kind: "key", key: "enter", pasted: false },
  ]);
  decoder.dispose();
});
it("edits complete graphemes and supports word/home/end/history", () => {
  const editor = new Editor();
  editor.insert("中👨‍👩‍👧‍👦é");
  editor.key("backspace");
  expect(editor.text).toBe("中👨‍👩‍👧‍👦");
  editor.key("left");
  editor.key("delete");
  expect(editor.text).toBe("中");
  editor.insert(" hello world");
  editor.key("word");
  expect(editor.text).toBe("中 hello ");
  editor.remember();
  editor.clear();
  editor.key("up");
  expect(editor.text).toBe("中 hello ");
});

it("fresh approval cannot import typed or pasted composer history", async () => {
  for (const value of ["y\r", "\x1b[200~y\r\x1b[201~"]) {
    const { input, reader } = fixture();
    const first = reader.question("", signal());
    input.write(value);
    await first;
    const approval = reader.readApproval("?", signal());
    input.write("\x1b[A\r");
    expect(await approval).toBe(false);
    reader.dispose();
  }
});
it("plain input preserves tabs and split Unicode", async () => {
  const { input, reader } = fixture();
  const answer = reader.question("", signal());
  for (const byte of Buffer.from("a\tb中\n")) input.write(Buffer.from([byte]));
  expect(await answer).toBe("a\tb中");
  reader.dispose();
});

it("only complete fresh typed y or yes authorizes", async () => {
  for (const value of ["y", "yes"]) {
    const { input, reader } = fixture();
    const approval = reader.readApproval("?", signal());
    input.write(value);
    let settled = false;
    void approval.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    input.write("\r");
    expect(await approval).toBe(true);
    reader.dispose();
    const pasted = fixture();
    const denial = pasted.reader.readApproval("?", signal());
    pasted.input.write(`\x1b[200~${value}\x1b[201~\r`);
    expect(await denial).toBe(false);
    pasted.reader.dispose();
  }
});

it("fresh empty Enter approves, but queued/pasted empty input never does", async () => {
  for (const prefix of ["\r", "\r\r", "y\r"]) {
    const {input, reader} = fixture();
    const first = reader.question("", signal()); input.write("start\r" + prefix); await first;
    let settled = false; const approval = reader.readApproval("Approve? [Y/n] ", signal());
    void approval.then(() => {settled = true;}); await Promise.resolve(); expect(settled).toBe(false);
    input.write("\r"); expect(await approval).toBe(true); reader.dispose();
  }
  for (const payload of ["\r", "\n", "\r\n", "\x1b[Z", "\x1b[13;2u"]) {
    const {input, reader} = fixture(); const approval = reader.readApproval("?", signal());
    input.write("\x1b[200~" + payload + "\x1b[201~\r");
    expect(await approval).toBe(false); reader.dispose();
  }
});

it("abort racing an Enter and Shift+Enter both deny", async () => {
  const {input, reader} = fixture(); const abort = new AbortController();
  const approval = reader.readApproval("?", abort.signal); input.write("\r"); abort.abort();
  expect(await approval).toBe(false); reader.dispose();
  const next = fixture(); const answer = next.reader.readApproval("?", signal());
  next.input.write("\x1b[13;2u"); expect(await answer).toBe(false); next.reader.dispose();
});

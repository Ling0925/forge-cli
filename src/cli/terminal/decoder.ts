import { StringDecoder } from "node:string_decoder";

export type InputEvent =
  | { kind: "text"; text: string; pasted: boolean }
  | { kind: "key"; key: string; pasted: boolean }
  | { kind: "background"; background: "light" | "dark" };

const keys: Readonly<Record<string, string>> = {
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[H": "home",
  "\x1b[F": "end",
  "\x1b[1~": "home",
  "\x1b[4~": "end",
  "\x1b[3~": "delete",
  "\x1bOH": "home",
  "\x1bOF": "end",
};
const controls: Readonly<Record<string, string>> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x03": "interrupt",
  "\x04": "eof",
  "\x01": "home",
  "\x05": "end",
  "\x15": "kill",
  "\x17": "word",
  "\x10": "up",
  "\x0e": "down",
};

/** Streaming protocol decoder. Fresh prompts MUST NOT reset this object's state. */
export class InputDecoder {
  private readonly utf8 = new StringDecoder("utf8");
  private pending = "";
  private paste = false;
  private cr = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly emit: (event: InputEvent) => void) {}
  feed(chunk: Buffer | string): void {
    this.pending += typeof chunk === "string" ? chunk : this.utf8.write(chunk);
    this.drain();
  }
  private drain(): void {
    if (this.timer) clearTimeout(this.timer);
    while (this.pending) {
      if (this.pending.startsWith("\x1b")) {
        const markers = ["\x1b[200~", "\x1b[201~"];
        const marker = markers.find((value) => this.pending.startsWith(value));
        if (marker) {
          this.paste = marker === markers[0];
          this.pending = this.pending.slice(marker.length);
          continue;
        }
        if (markers.some((value) => value.startsWith(this.pending))) {
          // A lone Escape is a key; longer partial paste markers remain pending.
          if (this.pending === "\x1b")
            this.timer = setTimeout(() => {
              if (this.pending === "\x1b") {
                this.pending = "";
                this.emit({ kind: "key", key: "escape", pasted: this.paste });
              }
            }, 35);
          return;
        }
        if (this.pending.startsWith("\x1b]")) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: parses the terminal OSC protocol, never user styling
          const match = /^\x1b\]([^\x07]*?)(?:\x07|\x1b\\)/.exec(this.pending);
          if (!match) {
            if (this.pending.length > 4096) this.pending = "";
            return;
          }
          const color = /^11;rgb:([\da-f]+)\/([\da-f]+)\/([\da-f]+)$/i.exec(
            match[1] ?? "",
          );
          if (color && !this.paste) {
            const values = color
              .slice(1)
              .map((v) => Number.parseInt(v, 16) / (16 ** v.length - 1));
            this.emit({
              kind: "background",
              background:
                (values[0] ?? 0) * 0.2126 +
                  (values[1] ?? 0) * 0.7152 +
                  (values[2] ?? 0) * 0.0722 >
                0.5
                  ? "light"
                  : "dark",
            });
          }
          this.pending = this.pending.slice(match[0].length);
          continue;
        }
        const found = Object.keys(keys).find((value) =>
          this.pending.startsWith(value),
        );
        if (found) {
          this.emit({
            kind: "key",
            key: keys[found] ?? "",
            pasted: this.paste,
          });
          this.pending = this.pending.slice(found.length);
          continue;
        }
        if (Object.keys(keys).some((value) => value.startsWith(this.pending)))
          return;
        // biome-ignore lint/suspicious/noControlCharactersInRegex: consumes terminal CSI protocol
        const sequence = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(this.pending);
        if (sequence) {
          this.pending = this.pending.slice(sequence[0].length);
          continue;
        }
        this.pending = this.pending.slice(1);
        this.emit({ kind: "key", key: "escape", pasted: this.paste });
        continue;
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: batches printable protocol data
      const text = /^[^\x00-\x1f\x7f\x1b]+/.exec(this.pending);
      if (text) {
        this.pending = this.pending.slice(text[0].length);
        this.cr = false;
        this.emit({ kind: "text", text: text[0], pasted: this.paste });
        continue;
      }
      const char = String.fromCodePoint(this.pending.codePointAt(0) ?? 0);
      this.pending = this.pending.slice(char.length);
      if (char === "\n" && this.cr) {
        this.cr = false;
        continue;
      }
      this.cr = char === "\r";
      const key = controls[char];
      if (key) this.emit({ kind: "key", key, pasted: this.paste });
      else if (char >= " " && char !== "\x7f")
        this.emit({ kind: "text", text: char, pasted: this.paste });
    }
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

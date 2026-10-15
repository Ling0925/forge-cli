import { graphemes } from "../../../src/cli/theme";

export class Editor {
  text = "";
  cursor = 0;
  tainted = false;
  private history: string[] = [];
  private index = 0;
  private saved = "";
  loadHistory(entries: readonly string[]): void {
    this.history = entries.slice(-1000);
    while (this.history.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 1_000_000) this.history.shift();
    this.index = this.history.length;
    this.saved = "";
  }
  clear(): void {
    this.text = "";
    this.cursor = 0;
    this.tainted = false;
  }
  set(text: string): void {
    this.text = text;
    this.cursor = text.length;
  }
  insert(text: string, pasted = false): void {
    this.text =
      this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
    this.tainted ||= pasted;
  }
  remember(): void {
    if (this.text && this.history.at(-1) !== this.text)
      this.history.push(this.text);
    while (
      this.history.length > 1000 ||
      this.history.reduce((sum, item) => sum + Buffer.byteLength(item), 0) >
        1_000_000
    )
      this.history.shift();
    this.index = this.history.length;
  }
  key(key: string): void {
    const before = this.text.slice(0, this.cursor);
    const left = graphemes(before).at(-1)?.length ?? 0;
    const right = graphemes(this.text.slice(this.cursor))[0]?.length ?? 0;
    switch (key) {
      case "left":
        this.cursor -= left;
        break;
      case "right":
        this.cursor += right;
        break;
      case "home":
        this.cursor = before.lastIndexOf("\n") + 1;
        break;
      case "end": {
        const end = this.text.indexOf("\n", this.cursor);
        this.cursor = end < 0 ? this.text.length : end;
        break;
      }
      case "backspace":
        this.text =
          before.slice(0, -left || before.length) +
          this.text.slice(this.cursor);
        this.cursor -= left;
        break;
      case "delete":
        this.text = before + this.text.slice(this.cursor + right);
        break;
      case "kill": {
        const start = before.lastIndexOf("\n") + 1;
        this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
        this.cursor = start;
        break;
      }
      case "kill-end": {
        const end = this.text.indexOf("\n", this.cursor);
        this.text = before + (end < 0 ? "" : this.text.slice(end));
        break;
      }
      case "word-left":
        this.cursor = before.replace(/\S+\s*$/, "").length;
        break;
      case "word-right": {
        const next = /^\s*\S+/.exec(this.text.slice(this.cursor));
        this.cursor += next?.[0].length ?? this.text.length - this.cursor;
        break;
      }
      case "word": {
        const keep = before.replace(/\S+\s*$/, "");
        this.text = keep + this.text.slice(this.cursor);
        this.cursor = keep.length;
        break;
      }
      case "up":
      case "down":
        if (this.index === this.history.length) this.saved = this.text;
        this.index = Math.max(
          0,
          Math.min(this.history.length, this.index + (key === "up" ? -1 : 1)),
        );
        this.set(this.history[this.index] ?? this.saved);
        break;
    }
  }
}

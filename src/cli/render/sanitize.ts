/** Streaming terminal-control removal; never buffers attacker-controlled payloads. */
export class ControlFilter {
  private state: "text" | "escape" | "csi" | "string" | "terminator" = "text";

  push(chunk: string): string {
    let out = "";
    for (const char of chunk) {
      const code = char.codePointAt(0) ?? 0;
      switch (this.state) {
        case "escape":
          if (char === "[") this.state = "csi";
          else if ("]PX^_".includes(char)) this.state = "string";
          else this.state = "text";
          break;
        case "csi":
          if (code >= 0x40 && code <= 0x7e) this.state = "text";
          break;
        case "string":
          if (code === 7 || code === 0x9c) this.state = "text";
          else if (code === 0x1b) this.state = "terminator";
          break;
        case "terminator":
          this.state = char === "\\" || code === 7 ? "text" : "string";
          break;
        case "text":
          if (code === 0x1b) this.state = "escape";
          else if (code === 0x9b) this.state = "csi";
          else if (code === 0x9d || code === 0x90) this.state = "string";
          else if (
            char === "\n" ||
            char === "\t" ||
            (code >= 32 && !(code >= 127 && code <= 159))
          )
            out += char;
          break;
      }
    }
    return out;
  }

  finish(): string {
    this.state = "text";
    return "";
  }
}

export const sanitizeText = (text: string): string =>
  new ControlFilter().push(text);

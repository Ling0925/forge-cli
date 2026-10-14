import type { ToolResult } from "../../shared/schemas";
import { sanitizeText } from "./sanitize";

const PREVIEW_LINES = 12;

const readValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readObject = (raw: string): Record<string, unknown> | null => {
  const value = readValue(raw);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  return null;
};

const stringField = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  return typeof field === "string" ? field : "";
};

const numberField = (
  value: Record<string, unknown>,
  key: string,
): number | null => {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
};

const boolField = (value: Record<string, unknown>, key: string): boolean =>
  value[key] === true;

interface Envelope {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly body: string;
  readonly note: string;
}

export const textLines = (value: string): string[] =>
  sanitizeText(value)
    .split("\n")
    .filter((item) => item.length > 0);

const summarizeValue = (value: unknown, depth = 0): string => {
  if (typeof value === "string")
    return sanitizeText(value).replace(/\s+/g, " ");
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (depth >= 2) return "…";
  if (Array.isArray(value)) {
    const shown = value
      .slice(0, 3)
      .map((item) => summarizeValue(item, depth + 1))
      .filter((item) => item.length > 0);
    const more =
      value.length > shown.length ? `, …${value.length - shown.length}` : "";
    return `[${shown.join(", ")}${more}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 4);
    const parts = entries.map(
      ([key, item]) => `${key}: ${summarizeValue(item, depth + 1)}`,
    );
    const more =
      Object.keys(value).length > entries.length
        ? `, …${Object.keys(value).length - entries.length}`
        : "";
    return `{${parts.join(", ")}${more}}`;
  }
  return "";
};

const previewFromObject = (parsed: Record<string, unknown>): Envelope => {
  const exit = numberField(parsed, "exit_code");
  const stdout = stringField(parsed, "stdout");
  const stderr = stringField(parsed, "stderr");
  if ("exit_code" in parsed || stdout || stderr) {
    return { stdout, stderr, exitCode: exit, body: "", note: "" };
  }
  if (typeof parsed.content === "string") {
    const bits = [
      stringField(parsed, "path"),
      parsed.total_lines !== undefined
        ? `${String(parsed.total_lines)} lines`
        : "",
      boolField(parsed, "truncated") ? "truncated" : "",
      boolField(parsed, "partial_line") ? "partial line" : "",
      boolField(parsed, "cache_hit") ? "cached" : "",
    ].filter(Boolean);
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      body: parsed.content,
      note: bits.join(" · "),
    };
  }
  if (typeof parsed.text === "string") {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      body: parsed.text,
      note: boolField(parsed, "truncated") ? "truncated" : "",
    };
  }
  if (typeof parsed.error === "string") {
    return {
      stdout: "",
      stderr: parsed.error,
      exitCode: null,
      body: "",
      note: "",
    };
  }
  const facts: string[] = [];
  for (const key of [
    "path",
    "written",
    "edited",
    "replacements",
    "created",
    "source",
    "artifact",
    "bytes",
    "navigated",
    "completed",
    "note",
  ]) {
    if (!(key in parsed)) continue;
    const value = parsed[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      facts.push(`${key} ${summarizeValue(value)}`);
    }
  }
  if (Array.isArray(parsed.entries)) {
    const names = parsed.entries
      .slice(0, PREVIEW_LINES)
      .map((item) =>
        typeof item === "object" && item !== null
          ? summarizeValue(item, 1)
          : summarizeValue(item),
      );
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      body: names.join("\n"),
      note: `${parsed.entries.length} entries${boolField(parsed, "truncated") ? " · truncated" : ""}`,
    };
  }
  if (Array.isArray(parsed.matches)) {
    const names = parsed.matches.slice(0, PREVIEW_LINES).map((item) => {
      if (typeof item !== "object" || item === null)
        return summarizeValue(item);
      const record = Object.fromEntries(Object.entries(item));
      const path = stringField(record, "path");
      const lineNo = numberField(record, "line");
      const excerpt = stringField(record, "excerpt");
      return [
        path,
        lineNo === null ? "" : `:${lineNo}`,
        excerpt ? ` ${excerpt}` : "",
      ]
        .filter(Boolean)
        .join("");
    });
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      body: names.join("\n"),
      note: `${parsed.matches.length} matches${boolField(parsed, "truncated") ? " · truncated" : ""}`,
    };
  }
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    body: facts.join("\n") || summarizeValue(parsed),
    note: "",
  };
};

export const envelope = (result: ToolResult): Envelope => {
  const parsed = readObject(result.content);
  if (!parsed)
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      body: result.content,
      note: "",
    };
  return previewFromObject(parsed);
};

import type {
  WebCitation,
  WebSearchProgress,
  WebSearchRecord,
} from "@forge/core/shared/web-search";
import { sanitizeText } from "./sanitize";

/**
 * English rendering of web-search progress for the terminal.
 *
 * Core's `web-search-display` is the localized projection shared with the web UI.
 * The terminal stays English so it reads without CJK fonts, so this module owns
 * the CLI wording. It keeps the same safety rules: bounded, plain text only, and
 * URLs are only emitted when Core's citation validation accepted them.
 */
const statusWords: Readonly<Record<WebSearchProgress["status"], string>> = {
  in_progress: "starting",
  searching: "searching",
  completed: "completed",
  failed: "failed",
  incomplete: "incomplete",
};

const plain = (value: string): string =>
  sanitizeText(value).replace(/\s+/g, " ").trim().slice(0, 256);

export function webSearchStatus(search: WebSearchProgress): string {
  return `Web search · ${statusWords[search.status] ?? search.status}`;
}

export interface WebSearchDisplayInput {
  readonly citations?: readonly WebCitation[];
  readonly webSearches?: readonly WebSearchRecord[];
}

/** English companion to Core's `webSearchDetails`; same bounds, same sources. */
export function webSearchDetails(value: WebSearchDisplayInput): string {
  const lines: string[] = [];
  const searches = (value.webSearches ?? []).slice(0, 16);
  if (searches.length) {
    lines.push("### Web search");
    for (const search of searches) {
      const target =
        search.action === "search"
          ? search.queries?.slice(0, 3).join("; ")
          : search.url;
      lines.push(
        `- ${plain(search.action)} · ${plain(search.status)}${target ? ` · ${plain(target)}` : ""}`,
      );
    }
    if ((value.webSearches?.length ?? 0) > searches.length) {
      lines.push("- More search records are kept in the session.");
    }
  }
  const cited = new Set<string>();
  const sources: string[] = [];
  for (const citation of (value.citations ?? []).slice(0, 256)) {
    const url = citation.url;
    if (!url || cited.has(url) || sources.length >= 32) continue;
    cited.add(url);
    sources.push(
      `${sources.length + 1}. [${plain(citation.title) || "source"}](${url})`,
    );
  }
  if (sources.length) lines.push("### Cited sources", ...sources);
  const consulted: string[] = [];
  for (const search of (value.webSearches ?? []).slice(0, 128)) {
    for (const url of [
      ...(search.sources ?? []).slice(0, 128),
      ...(search.url ? [search.url] : []),
    ]) {
      if (!url || cited.has(url) || consulted.length >= 32) continue;
      cited.add(url);
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {
        /* Keep the raw string. */
      }
      consulted.push(`- [${plain(host)}](${url})`);
    }
  }
  if (consulted.length)
    lines.push("### Consulted sources (not necessarily cited)", ...consulted);
  if ((value.citations?.length ?? 0) > 32) {
    lines.push(
      "Full citation records stay in the session; at most 32 distinct sources are shown here.",
    );
  }
  return lines.length ? `\n\n${lines.join("\n")}\n` : "";
}

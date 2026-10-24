import { stripMarkdownCode, trimTrailingPunctuation } from "./markdown-scan.js";

export const ISSUE_REFERENCE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export interface IssueReferenceMatch {
  index: number;
  length: number;
  identifier: string;
  matchedText: string;
}

// Token grammar (leftmost alternative wins at each position):
//   https?://[^\s<>()]+  |  /[^\s<>()]+  |  [A-Z][A-Z0-9]*-\d+   (case-insensitive)
// The identifier alternative used to be a regex whose `[A-Z0-9]*` re-scanned the
// rest of an alphanumeric run from every start position, which is quadratic on
// long unbroken runs (a 1MB comment pinned the event loop; ALG-3397). The
// scanner below matches the same tokens but measures each run only once.
const URL_TOKEN_RE = /https?:\/\/[^\s<>()]+/iy;
const PATH_TOKEN_RE = /\/[^\s<>()]+/y;
const IDENTIFIER_SUFFIX_RE = /-\d+/y;
const ISSUES_SEGMENT_HINT_RE = /issues/i;

function isAsciiLetter(code: number) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlphanumeric(code: number) {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

export function normalizeIssueIdentifier(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return ISSUE_REFERENCE_IDENTIFIER_RE.test(trimmed) ? trimmed : null;
}

export function buildIssueReferenceHref(identifier: string): string {
  const normalized = normalizeIssueIdentifier(identifier);
  return `/issues/${normalized ?? identifier.trim()}`;
}

export function parseIssueReferenceHref(href: string): { identifier: string } | null {
  const raw = href.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = raw.startsWith("/")
      ? new URL(raw, "https://paperclip.invalid")
      : new URL(raw);
  } catch {
    return null;
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index]?.toLowerCase() !== "issues") continue;
    const identifier = normalizeIssueIdentifier(segments[index + 1] ?? "");
    if (identifier) {
      return { identifier };
    }
  }

  return null;
}

function readTokenAt(text: string, index: number, identifierEnd: number): string | null {
  const code = text.charCodeAt(index);
  if (code === 104 || code === 72) {
    URL_TOKEN_RE.lastIndex = index;
    const url = URL_TOKEN_RE.exec(text);
    if (url) return url[0];
  } else if (code === 47) {
    PATH_TOKEN_RE.lastIndex = index;
    const path = PATH_TOKEN_RE.exec(text);
    if (path) return path[0];
  }

  return identifierEnd !== -1 && isAsciiLetter(code) ? text.slice(index, identifierEnd) : null;
}

export function findIssueReferenceMatches(text: string): IssueReferenceMatch[] {
  if (!text) return [];

  const matches: IssueReferenceMatch[] = [];
  // Every start offset inside one alphanumeric run shares the run's end, and so
  // whether a `-\d+` suffix follows it; measure both once per run.
  let alphanumericRunEnd = 0;
  let identifierEnd = -1;
  let index = 0;

  while (index < text.length) {
    if (index >= alphanumericRunEnd) {
      alphanumericRunEnd = index;
      while (
        alphanumericRunEnd < text.length
        && isAsciiAlphanumeric(text.charCodeAt(alphanumericRunEnd))
      ) {
        alphanumericRunEnd += 1;
      }
      IDENTIFIER_SUFFIX_RE.lastIndex = alphanumericRunEnd;
      identifierEnd = alphanumericRunEnd > index && IDENTIFIER_SUFFIX_RE.test(text)
        ? IDENTIFIER_SUFFIX_RE.lastIndex
        : -1;
    }
    const rawToken = readTokenAt(text, index, identifierEnd);
    if (rawToken === null) {
      index += 1;
      continue;
    }
    const matchIndex = index;
    index += rawToken.length;

    const cleanedToken = trimTrailingPunctuation(rawToken);
    if (!cleanedToken) continue;

    // Only hrefs with an "issues" path segment can resolve; skip URL parsing
    // (and its exception cost) for every other link-shaped token.
    const identifier =
      normalizeIssueIdentifier(cleanedToken)
      ?? (ISSUES_SEGMENT_HINT_RE.test(cleanedToken) ? parseIssueReferenceHref(cleanedToken)?.identifier : null)
      ?? null;

    if (!identifier) continue;

    matches.push({
      index: matchIndex,
      length: cleanedToken.length,
      identifier,
      matchedText: cleanedToken,
    });
  }

  return matches;
}

export function extractIssueReferenceIdentifiers(markdown: string): string[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match.identifier);
  }

  return ordered;
}

export function extractIssueReferenceMatches(markdown: string): IssueReferenceMatch[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: IssueReferenceMatch[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match);
  }

  return ordered;
}

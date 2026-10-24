import { createHash } from "node:crypto";
import { parseIssueReferenceHref } from "./issue-references.js";
import { stripMarkdownCode, trimTrailingPunctuation } from "./markdown-scan.js";
import type {
  ExternalObjectCanonicalIdentity,
  ExternalObjectCanonicalUrl,
  ExternalObjectMentionSource,
  ExternalObjectUrlCanonicalizationOptions,
  ExternalObjectUrlMatch,
} from "./external-objects.js";

const EXTERNAL_URL_TOKEN_RE = /https?:\/\/[^\s<>()]+/gi;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizePathname(pathname: string): string {
  return pathname || "/";
}

export function findExternalObjectUrlMatches(markdown: string): ExternalObjectUrlMatch[] {
  if (!markdown) return [];

  const scrubbed = stripMarkdownCode(markdown);
  const matches: ExternalObjectUrlMatch[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(EXTERNAL_URL_TOKEN_RE);

  while ((match = re.exec(scrubbed)) !== null) {
    const matchedText = trimTrailingPunctuation(match[0]);
    if (!matchedText || parseIssueReferenceHref(matchedText)) continue;

    matches.push({
      index: match.index,
      length: matchedText.length,
      matchedText,
    });
  }

  return matches;
}

export function canonicalizeExternalObjectUrl(
  value: string,
  options: ExternalObjectUrlCanonicalizationOptions = {},
): ExternalObjectCanonicalUrl | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const scheme = url.protocol === "https:" ? "https" : "http";
  const path = normalizePathname(url.pathname);
  const sanitizedCanonicalUrl = `${scheme}://${url.host.toLowerCase()}${path}`;
  const identityQueryParams = new Set(options.identityQueryParams ?? []);
  const queryParamHashes: Record<string, string> = {};

  for (const key of [...identityQueryParams].sort()) {
    const values = url.searchParams.getAll(key);
    if (values.length === 0) continue;
    queryParamHashes[key] = sha256Hex(values.join("\u0000"));
  }

  const canonicalIdentity: ExternalObjectCanonicalIdentity = {
    scheme,
    host: url.host.toLowerCase(),
    path,
    ...(Object.keys(queryParamHashes).length > 0 ? { queryParamHashes } : {}),
  };

  return {
    sanitizedCanonicalUrl,
    sanitizedDisplayUrl: sanitizedCanonicalUrl,
    canonicalIdentity,
    canonicalIdentityHash: sha256Hex(stableStringify(canonicalIdentity)),
    redactedMatchedText: sanitizedCanonicalUrl,
  };
}

export function extractExternalObjectCanonicalUrls(
  markdown: string,
  options: ExternalObjectUrlCanonicalizationOptions = {},
): ExternalObjectCanonicalUrl[] {
  const seen = new Set<string>();
  const ordered: ExternalObjectCanonicalUrl[] = [];
  // Canonicalizing parses the URL and hashes it twice; repeated links in a
  // large body are common, so canonicalize each distinct text once.
  const seenText = new Set<string>();

  for (const match of findExternalObjectUrlMatches(markdown)) {
    if (seenText.has(match.matchedText)) continue;
    seenText.add(match.matchedText);
    const canonical = canonicalizeExternalObjectUrl(match.matchedText, options);
    if (!canonical || seen.has(canonical.canonicalIdentityHash)) continue;
    seen.add(canonical.canonicalIdentityHash);
    ordered.push(canonical);
  }

  return ordered;
}

export function buildExternalObjectScopedIdentityKey(args: {
  companyId: string;
  providerKey: string;
  objectType: string;
  canonicalIdentityHash: string;
}): string {
  return [args.companyId, args.providerKey, args.objectType, args.canonicalIdentityHash].join(":");
}

export function buildExternalObjectMentionSourceKey(source: Required<Pick<
  ExternalObjectMentionSource,
  "companyId" | "sourceIssueId" | "sourceKind"
>> & ExternalObjectMentionSource): string {
  return [
    source.companyId,
    source.sourceIssueId,
    source.sourceKind,
    source.sourceRecordId ?? "",
    source.documentKey ?? "",
    source.propertyKey ?? "",
  ].join(":");
}

import { describe, expect, it } from "vitest";
import { extractExternalObjectCanonicalUrls } from "./external-objects-server.js";
import { extractIssueReferenceMatches, findIssueReferenceMatches, normalizeIssueIdentifier, parseIssueReferenceHref } from "./issue-references.js";
import { stripMarkdownCode, trimTrailingPunctuation } from "./markdown-scan.js";
import {
  extractAgentMentionIds,
  extractPipelineMentions,
  extractProjectMentionIds,
  extractUserMentionIds,
} from "./project-mentions.js";

// The pre-ALG-3397 implementations, kept verbatim as oracles. They are correct
// but quadratic, so they are only run on short inputs.
function legacyStripMarkdownCode(markdown: string): string {
  if (!markdown) return "";
  const preserve = (value: string) => value.replace(/[^\n]/g, " ");
  let output = "";
  let index = 0;
  while (index < markdown.length) {
    const remaining = markdown.slice(index);
    const fenceMatch = /^(?:```+|~~~+)/.exec(remaining);
    const atLineStart = index === 0 || markdown[index - 1] === "\n";
    if (atLineStart && fenceMatch) {
      const fence = fenceMatch[0]!;
      const blockStart = index;
      index += fence.length;
      while (index < markdown.length && markdown[index] !== "\n") index += 1;
      if (index < markdown.length) index += 1;
      while (index < markdown.length) {
        const lineStart = index === 0 || markdown[index - 1] === "\n";
        if (lineStart && markdown.startsWith(fence, index)) {
          index += fence.length;
          while (index < markdown.length && markdown[index] !== "\n") index += 1;
          if (index < markdown.length) index += 1;
          break;
        }
        index += 1;
      }
      output += preserve(markdown.slice(blockStart, index));
      continue;
    }
    if (markdown[index] === "`") {
      let tickCount = 1;
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") tickCount += 1;
      const fence = "`".repeat(tickCount);
      const inlineStart = index;
      index += tickCount;
      const closeIndex = markdown.indexOf(fence, index);
      if (closeIndex === -1) {
        output += markdown.slice(inlineStart, inlineStart + tickCount);
        index = inlineStart + tickCount;
        continue;
      }
      index = closeIndex + tickCount;
      output += preserve(markdown.slice(inlineStart, index));
      continue;
    }
    output += markdown[index]!;
    index += 1;
  }
  return output;
}

function legacyTrimTrailingPunctuation(token: string): string {
  let trimmed = token;
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1]!;
    if (!".,!?;:".includes(last) && last !== ")" && last !== "]") break;
    if (
      (last === ")" && (trimmed.match(/\(/g)?.length ?? 0) >= (trimmed.match(/\)/g)?.length ?? 0))
      || (last === "]" && (trimmed.match(/\[/g)?.length ?? 0) >= (trimmed.match(/\]/g)?.length ?? 0))
    ) {
      break;
    }
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function legacyFindIssueReferenceMatches(text: string) {
  if (!text) return [];
  const matches: Array<{ index: number; length: number; identifier: string; matchedText: string }> = [];
  const re = /https?:\/\/[^\s<>()]+|\/[^\s<>()]+|[A-Z][A-Z0-9]*-\d+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const cleanedToken = legacyTrimTrailingPunctuation(match[0]);
    if (!cleanedToken) continue;
    const identifier = normalizeIssueIdentifier(cleanedToken) ?? parseIssueReferenceHref(cleanedToken)?.identifier ?? null;
    if (!identifier) continue;
    matches.push({ index: match.index, length: cleanedToken.length, identifier, matchedText: cleanedToken });
  }
  return matches;
}

// Deterministic PRNG so a failure reproduces from its seed.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_PIECES = [
  "`", "``", "```", "~~~", "\n", " ", "a", "Z", "x1", "9", "-", "-12", "PAP-7", "pap-8", "/", "/issues/",
  "issues", "http://h.test/", "https://", "h", "[", "]", "(", ")", ".", ",", ":", "!", "\t",
];

function randomText(random: () => number, length: number) {
  let text = "";
  while (text.length < length) text += FUZZ_PIECES[Math.floor(random() * FUZZ_PIECES.length)];
  return text;
}

function timeMs(fn: () => unknown) {
  const startedAt = performance.now();
  fn();
  return performance.now() - startedAt;
}

describe("linear markdown scanning (ALG-3397)", () => {
  it("matches the legacy scanners on randomized markdown", () => {
    for (let seed = 1; seed <= 4_000; seed += 1) {
      const random = mulberry32(seed);
      const text = randomText(random, 1 + Math.floor(random() * 80));
      expect(stripMarkdownCode(text), `strip seed ${seed}: ${JSON.stringify(text)}`).toBe(legacyStripMarkdownCode(text));
      expect(findIssueReferenceMatches(text), `find seed ${seed}: ${JSON.stringify(text)}`)
        .toEqual(legacyFindIssueReferenceMatches(text));
      expect(trimTrailingPunctuation(text), `trim seed ${seed}`).toBe(legacyTrimTrailingPunctuation(text));
    }
  });

  it("keeps leftmost identifier semantics around alphanumeric runs", () => {
    expect(findIssueReferenceMatches("1PAP-5").map((match) => [match.index, match.identifier])).toEqual([[1, "PAP-5"]]);
    expect(findIssueReferenceMatches("AB-12CD-5").map((match) => match.identifier)).toEqual(["AB-12", "CD-5"]);
    expect(findIssueReferenceMatches("xhttps://p.test/issues/PAP-9").map((match) => match.identifier)).toEqual(["PAP-9"]);
  });

  // Each input below took minutes to hours at this size with the regex
  // scanners; linear scanners finish in milliseconds. The bound is generous
  // for slow shared runners and still orders of magnitude under the old cost.
  const size = 1_000_000;
  it.each([
    ["an unbroken alphanumeric run", "x".repeat(size)],
    ["alternating letters and digits", "x1".repeat(size / 2)],
    ["base64-like text", Buffer.alloc(size).fill("paperclip").toString("base64").slice(0, size)],
    ["unclosed brackets", "[".repeat(size)],
    ["a closing-bracket tail on a path", `/a${"]".repeat(size)}`],
    ["chained unterminated mention links", "[x](agent://a".repeat(size / 13)],
    ["descending unclosed backtick fences", Array.from({ length: 1_400 }, (_, i) => "`".repeat(1_400 - i) + "a").join("")],
    ["a backtick per character pair", "`a".repeat(size / 2)],
  ])("scans %s in linear time", (_label, text) => {
    const elapsed = timeMs(() => {
      extractIssueReferenceMatches(text);
      extractExternalObjectCanonicalUrls(text);
      extractAgentMentionIds(text);
      extractProjectMentionIds(text);
      extractUserMentionIds(text);
      extractPipelineMentions(text);
    });
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});

describe("mention link extraction", () => {
  it("still finds a mention whose label follows a stray opening bracket", () => {
    expect(extractAgentMentionIds("[note [Ada](agent://agent-1) and [Bob](agent://agent-2)")).toEqual(["agent-1", "agent-2"]);
  });
});

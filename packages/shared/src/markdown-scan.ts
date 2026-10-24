// Linear-time markdown scanning helpers shared by the issue-reference and
// external-object extractors. These run synchronously on every comment,
// description, and document body the server stores, so each one must stay
// O(n) in the body length: a quadratic scan here blocks the event loop for
// minutes on a large body (ALG-3397).

const LINE_START_FENCE_RE = /```+|~~~+/y;

function preserveNewlinesAsWhitespace(value: string) {
  return value.includes("\n") ? value.replace(/[^\n]/g, " ") : " ".repeat(value.length);
}

interface BacktickRuns {
  starts: number[];
  // suffixMaxLength[i] is the longest backtick run among runs i..end.
  suffixMaxLength: number[];
}

function collectBacktickRuns(markdown: string): BacktickRuns {
  const starts: number[] = [];
  const lengths: number[] = [];
  let index = markdown.indexOf("`");
  while (index !== -1) {
    let end = index + 1;
    while (end < markdown.length && markdown[end] === "`") end += 1;
    starts.push(index);
    lengths.push(end - index);
    index = markdown.indexOf("`", end);
  }
  const suffixMaxLength = new Array<number>(lengths.length);
  let max = 0;
  for (let i = lengths.length - 1; i >= 0; i -= 1) {
    max = Math.max(max, lengths[i]!);
    suffixMaxLength[i] = max;
  }
  return { starts, suffixMaxLength };
}

export function stripMarkdownCode(markdown: string): string {
  if (!markdown) return "";
  // No code fence or span can start without one of these; skip the copy.
  if (!markdown.includes("`") && !markdown.includes("~")) return markdown;

  const parts: string[] = [];
  let plainStart = 0;
  let index = 0;
  let backtickRuns: BacktickRuns | null = null;
  let runCursor = 0;

  while (index < markdown.length) {
    const code = markdown.charCodeAt(index);
    let fenceMatch: RegExpExecArray | null = null;
    if ((code === 96 || code === 126) && (index === 0 || markdown.charCodeAt(index - 1) === 10)) {
      LINE_START_FENCE_RE.lastIndex = index;
      fenceMatch = LINE_START_FENCE_RE.exec(markdown);
    }

    if (fenceMatch) {
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

      parts.push(markdown.slice(plainStart, blockStart));
      parts.push(preserveNewlinesAsWhitespace(markdown.slice(blockStart, index)));
      plainStart = index;
      continue;
    }

    if (code === 96) {
      let tickCount = 1;
      while (index + tickCount < markdown.length && markdown[index + tickCount] === "`") {
        tickCount += 1;
      }
      const inlineStart = index;
      index += tickCount;

      // An unclosed fence would otherwise rescan the rest of the body with
      // indexOf; consult the longest backtick run still ahead instead.
      backtickRuns ??= collectBacktickRuns(markdown);
      while (runCursor < backtickRuns.starts.length && backtickRuns.starts[runCursor]! < index) {
        runCursor += 1;
      }
      const longestRunAhead = runCursor < backtickRuns.starts.length
        ? backtickRuns.suffixMaxLength[runCursor]!
        : 0;
      const closeIndex = longestRunAhead >= tickCount
        ? markdown.indexOf("`".repeat(tickCount), index)
        : -1;
      if (closeIndex === -1) continue;

      index = closeIndex + tickCount;
      parts.push(markdown.slice(plainStart, inlineStart));
      parts.push(preserveNewlinesAsWhitespace(markdown.slice(inlineStart, index)));
      plainStart = index;
      continue;
    }

    index += 1;
  }

  parts.push(markdown.slice(plainStart));
  return parts.join("");
}

export function trimTrailingPunctuation(token: string): string {
  let openParens = 0;
  let closeParens = 0;
  let openBrackets = 0;
  let closeBrackets = 0;
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i];
    if (char === "(") openParens += 1;
    else if (char === ")") closeParens += 1;
    else if (char === "[") openBrackets += 1;
    else if (char === "]") closeBrackets += 1;
  }

  let end = token.length;
  while (end > 0) {
    const last = token[end - 1]!;
    if (!".,!?;:".includes(last) && last !== ")" && last !== "]") break;

    if (
      (last === ")" && openParens >= closeParens)
      || (last === "]" && openBrackets >= closeBrackets)
    ) {
      break;
    }
    if (last === ")") closeParens -= 1;
    else if (last === "]") closeBrackets -= 1;
    end -= 1;
  }
  return token.slice(0, end);
}

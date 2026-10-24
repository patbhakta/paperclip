import type { RequestHandler } from "express";

const BYTE_LIMIT_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;
const BYTE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

function readPositiveByteLimit(raw: string | undefined): number | null {
  const match = raw?.trim().match(BYTE_LIMIT_RE);
  if (!match) return null;
  const bytes = Math.floor(Number(match[1]) * BYTE_UNITS[(match[2] ?? "b").toLowerCase()]!);
  return Number.isSafeInteger(bytes) && bytes >= 1 ? bytes : null;
}

function readPositiveInteger(raw: string | undefined): number | null {
  const value = Math.floor(Number(raw));
  return raw !== undefined && raw.trim() !== "" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Ceiling for every JSON request body outside company import. Over-limit bodies
// are rejected by the parser with 413 before any route runs. Operators can
// override it with PAPERCLIP_JSON_BODY_LIMIT (bytes, or e.g. "5mb").
export const DEFAULT_JSON_BODY_LIMIT: string | number =
  readPositiveByteLimit(process.env.PAPERCLIP_JSON_BODY_LIMIT) ?? "10mb";

// Longest issue comment body accepted, in characters. Every stored comment is
// scanned synchronously for issue references, mentions, and external links, so
// this also bounds how long one comment write can hold the event loop
// (ALG-3397). The default is ten times the largest comment seen in practice;
// long reports belong in issue documents. Override with
// PAPERCLIP_MAX_COMMENT_BODY_CHARS.
export const MAX_COMMENT_BODY_CHARS =
  readPositiveInteger(process.env.PAPERCLIP_MAX_COMMENT_BODY_CHARS) || 262_144;

// JSON byte ceiling for the comment-create route. A JSON string spends at most
// six bytes per character (a \uXXXX escape), plus slack for the other fields,
// so no body under the character cap is refused here. A larger declared length
// is answered with 413 before a byte of it is buffered or parsed.
export const COMMENT_JSON_BODY_LIMIT_BYTES = MAX_COMMENT_BODY_CHARS * 6 + 64 * 1024;

// How long a client may take to deliver a request body. A stalled or trickling
// upload is answered with 408 and its connection closed instead of holding a
// parser and socket open indefinitely. 0 disables the guard. Override with
// PAPERCLIP_REQUEST_BODY_TIMEOUT_MS.
export const REQUEST_BODY_TIMEOUT_MS =
  readPositiveInteger(process.env.PAPERCLIP_REQUEST_BODY_TIMEOUT_MS) ?? 30_000;

function hasRequestBody(headers: Record<string, string | string[] | undefined>) {
  if (headers["transfer-encoding"] !== undefined) return true;
  const contentLength = Number(headers["content-length"]);
  return Number.isFinite(contentLength) && contentLength > 0;
}

export function requestBodyTimeout(timeoutMs: number = REQUEST_BODY_TIMEOUT_MS): RequestHandler {
  return (req, res, next) => {
    if (timeoutMs <= 0 || !hasRequestBody(req.headers) || req.complete) {
      next();
      return;
    }
    const timer = setTimeout(() => {
      if (req.complete) return;
      if (res.headersSent) {
        req.destroy();
        return;
      }
      res.once("finish", () => req.destroy());
      res.status(408).set("Connection", "close").json({
        error: "Request body was not received in time",
        code: "request_body_timeout",
      });
    }, timeoutMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    req.once("end", clear);
    req.once("close", clear);
    res.once("close", clear);
    next();
  };
}
export const PORTABLE_JSON_BODY_LIMIT = "64mb";
export const PORTABLE_JSON_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

// A company import can also be uploaded as its raw compressed zip (multipart or
// application/zip) instead of an inflated inline JSON body. The compressed zip
// is roughly a third of the inline size, but the limit is kept generous so a
// large company package uploads in one request rather than truncating in transit.
// The whole upload is buffered in memory and unzipped in one pass, so this cap
// bounds peak per-import memory (roughly the compressed size plus the inflated
// package). Operators who need more (or less) headroom can override it with
// PAPERCLIP_IMPORT_ZIP_MAX_BYTES; the import route scales its decompression-bomb
// guards from whatever value is in effect.
// The override is clamped to [1 byte, 64 GiB]: a fractional value would floor
// to a zero-byte limit that rejects every upload, and an astronomically large
// one would overflow the derived 4x decompression guard. 64 GiB is far beyond
// what the in-memory import pipeline can serve anyway.
const MAX_ZIP_UPLOAD_LIMIT_OVERRIDE_BYTES = 64 * 1024 * 1024 * 1024;
const zipUploadLimitOverride = Math.floor(Number(process.env.PAPERCLIP_IMPORT_ZIP_MAX_BYTES));
export const PORTABLE_ZIP_UPLOAD_LIMIT_BYTES =
  Number.isFinite(zipUploadLimitOverride) && zipUploadLimitOverride >= 1
    ? Math.min(zipUploadLimitOverride, MAX_ZIP_UPLOAD_LIMIT_OVERRIDE_BYTES)
    : 1024 * 1024 * 1024;

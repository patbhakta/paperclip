import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PerformanceObserver } from "node:perf_hooks";
import express from "express";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueReferenceMentions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  COMMENT_JSON_BODY_LIMIT_BYTES,
  DEFAULT_JSON_BODY_LIMIT,
  MAX_COMMENT_BODY_CHARS,
  requestBodyTimeout,
} from "../http/body-limits.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

// ALG-3397 / HU-3183: a large comment POST committed its row and then pinned
// the event loop while the body was scanned for references and mentions, so
// the response never arrived and every other route hung until restart. These
// tests drive the real comment route over a real socket and probe an unrelated
// route while the large request is in flight; a wedge shows up as a stalled
// probe and a timed-out POST.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres large comment body tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const RESPONSE_BUDGET_MS = 10_000;
const PROBE_BUDGET_MS = 100;

describeEmbeddedPostgres("large issue comment bodies", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const servers: Server[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-large-body-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    await db.delete(activityLog);
    await db.delete(issueReferenceMentions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssues() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const referencedIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Large Body Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "BIG-1", title: "Large comment target", status: "todo", priority: "medium" },
      { id: referencedIssueId, companyId, identifier: "BIG-2", title: "Referenced issue", status: "todo", priority: "medium" },
    ]);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    return { companyId, issueId, referencedIssueId };
  }

  async function startApp(companyId: string, warmUpIssueId: string, options: { bodyTimeoutMs?: number } = {}) {
    const app = express();
    // Same order as the production pipeline in app.ts.
    app.use(requestBodyTimeout(options.bodyTimeoutMs));
    app.post("/api/issues/:id/comments", express.json({ limit: COMMENT_JSON_BODY_LIMIT_BYTES }));
    app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT }));
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);

    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    // Pay one-time costs before measuring: lazy compilation of the route
    // module, and V8 optimizing (then deoptimizing and re-optimizing) the
    // scanners' hot loops for large inputs of each string shape used below.
    // Each lands once per process lifetime, on its first large comment, and
    // costs a few hundred ms at most — not a wedge, but not steady state either.
    const warmUpChunk = Math.floor(MAX_COMMENT_BODY_CHARS / 4);
    const warmUp = await postComment(
      baseUrl,
      warmUpIssueId,
      commentPayload(
        "Warm-up for BIG-1, see [log](https://e.test/a) `x`.\n".repeat(Math.floor(warmUpChunk / 52))
          + "x".repeat(warmUpChunk)
          + "[".repeat(warmUpChunk)
          + Buffer.alloc(warmUpChunk).fill("warm").toString("base64").slice(0, warmUpChunk),
      ),
    );
    expect(warmUp.status).toBe(201);
    return baseUrl;
  }

  function expectProbeWithinBudget(probe: { slowestProbeBusyMs: number; slowestProbeWallMs: number; gcInSlowestProbeMs: number }) {
    expect(
      probe.slowestProbeBusyMs,
      `slowest probe busy ${probe.slowestProbeBusyMs.toFixed(1)}ms (after ${probe.gcInSlowestProbeMs.toFixed(1)}ms GC), slowest wall ${probe.slowestProbeWallMs.toFixed(1)}ms`,
    ).toBeLessThan(PROBE_BUDGET_MS);
  }

  async function commentBodyLengths(issueId: string) {
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.map((row) => row.body.length);
  }

  // Polls an unrelated route until `inFlight` settles and reports the slowest
  // probe. A blocked event loop delays every probe issued while it is blocked.
  // Each probe is charged the time the event loop spent running code:
  //  - min(wall, this thread's CPU): a loaded shared runner deschedules the
  //    process for 100ms+ at a time, which inflates wall time but burns no CPU,
  //    while a synchronous block burns CPU for its whole duration;
  //  - minus garbage-collector pauses inside the probe: their length follows
  //    the live heap of the whole test worker, not the request, and a server
  //    pays them on any request.
  // The thread also runs the test client, so the charge never undercounts the
  // server's own blocking; a regex wedge is pure JS and is charged in full.
  async function probeWhile<T>(baseUrl: string, inFlight: Promise<T>) {
    let settled = false;
    const result = inFlight.finally(() => {
      settled = true;
    });
    const gcPauses: Array<{ startTime: number; duration: number }> = [];
    const gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) gcPauses.push({ startTime: entry.startTime, duration: entry.duration });
    });
    gcObserver.observe({ entryTypes: ["gc"] });
    const windows: Array<{ start: number; end: number; cpuMs: number }> = [];
    while (!settled) {
      const start = performance.now();
      const cpuBefore = process.threadCpuUsage();
      const response = await fetch(`${baseUrl}/health`);
      await response.json();
      const cpu = process.threadCpuUsage(cpuBefore);
      windows.push({ start, end: performance.now(), cpuMs: (cpu.user + cpu.system) / 1000 });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (const entry of gcObserver.takeRecords()) gcPauses.push({ startTime: entry.startTime, duration: entry.duration });
    gcObserver.disconnect();

    let slowestProbeBusyMs = 0;
    let slowestProbeWallMs = 0;
    let gcInSlowestProbeMs = 0;
    for (const window of windows) {
      const wallMs = window.end - window.start;
      const gcMs = gcPauses
        .filter((pause) => pause.startTime >= window.start && pause.startTime < window.end)
        .reduce((total, pause) => total + pause.duration, 0);
      const busyMs = Math.max(0, Math.min(wallMs, window.cpuMs) - gcMs);
      if (busyMs >= slowestProbeBusyMs) {
        slowestProbeBusyMs = busyMs;
        gcInSlowestProbeMs = gcMs;
      }
      slowestProbeWallMs = Math.max(slowestProbeWallMs, wallMs);
    }
    return {
      result: await result,
      slowestProbeBusyMs,
      slowestProbeWallMs,
      gcInSlowestProbeMs,
      probes: windows.length,
    };
  }

  // Serialize before probing starts: stringifying and encoding a multi-MB body
  // is client work in this same process and would otherwise be charged to the
  // server under test.
  function commentPayload(body: string) {
    return Buffer.from(JSON.stringify({ body }));
  }

  // Writes the prepared payload straight to the socket and returns the raw
  // response text; callers parse it after probing ends for the same reason.
  function postComment(baseUrl: string, issueId: string, payload: Buffer) {
    return sendJson(baseUrl, "POST", `/api/issues/${issueId}/comments`, payload);
  }

  function sendJson(baseUrl: string, method: string, path: string, payload: Buffer) {
    const url = new URL(`${baseUrl}${path}`);
    const startedAt = performance.now();
    return new Promise<{ status: number; text: string; elapsedMs: number }>((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: { "content-type": "application/json", "content-length": String(payload.length) },
        timeout: RESPONSE_BUDGET_MS,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
          elapsedMs: performance.now() - startedAt,
        }));
      });
      req.on("timeout", () => req.destroy(new Error(`no response within ${RESPONSE_BUDGET_MS}ms`)));
      req.on("error", reject);
      req.end(payload);
    });
  }

  it.each([
    // An unbroken alphanumeric run: the identifier regex rescanned it from every
    // offset, roughly 30 minutes of blocked event loop at this size.
    ["unbroken alphanumeric run", (size: number) => "x".repeat(size)],
    // Opening brackets: each mention regex rescanned the rest of the body from
    // every "[".
    ["unclosed mention brackets", (size: number) => "[".repeat(size)],
    ["base64 payload", (size: number) => Buffer.alloc(size).fill("paperclip").toString("base64").slice(0, size)],
  ])("stores a max-size comment made of an %s without blocking other routes", async (_label, makeBody) => {
    const { companyId, issueId, referencedIssueId } = await seedIssues();
    const baseUrl = await startApp(companyId, referencedIssueId);
    const body = makeBody(MAX_COMMENT_BODY_CHARS);
    const payload = commentPayload(body);

    const { result, probes, ...probe } = await probeWhile(baseUrl, postComment(baseUrl, issueId, payload));

    expect(result.status, result.text.slice(0, 500)).toBe(201);
    expect(JSON.parse(result.text).body).toHaveLength(body.length);
    expect(result.elapsedMs).toBeLessThan(RESPONSE_BUDGET_MS);
    expect(probes).toBeGreaterThan(0);
    expectProbeWithinBudget(probe);
    expect(await commentBodyLengths(issueId)).toEqual([body.length]);
  }, 30_000);

  it("still indexes issue references at the end of a large realistic comment", async () => {
    const { companyId, issueId, referencedIssueId } = await seedIssues();
    const baseUrl = await startApp(companyId, referencedIssueId);
    const paragraph = "Status: see [log](https://ci.example.test/run/42) and `npm test` output.\n\n";
    const tail = "\nFollow-up tracked in BIG-2.";
    const body = paragraph.repeat(Math.floor((MAX_COMMENT_BODY_CHARS - tail.length) / paragraph.length)) + tail;
    const payload = commentPayload(body);

    const { result, ...probe } = await probeWhile(baseUrl, postComment(baseUrl, issueId, payload));

    expect(result.status, result.text.slice(0, 500)).toBe(201);
    expect(result.elapsedMs).toBeLessThan(RESPONSE_BUDGET_MS);
    expectProbeWithinBudget(probe);
    const mentions = await db
      .select({ targetIssueId: issueReferenceMentions.targetIssueId })
      .from(issueReferenceMentions)
      .where(eq(issueReferenceMentions.sourceIssueId, issueId));
    expect(mentions.map((row) => row.targetIssueId)).toContain(referencedIssueId);
  }, 30_000);

  it("rejects a comment one character over the cap with 413 before writing anything", async () => {
    const { companyId, issueId, referencedIssueId } = await seedIssues();
    const baseUrl = await startApp(companyId, referencedIssueId);
    const payload = commentPayload("y".repeat(MAX_COMMENT_BODY_CHARS + 1));

    const { result, ...probe } = await probeWhile(baseUrl, postComment(baseUrl, issueId, payload));

    expect(result.status).toBe(413);
    expect(JSON.parse(result.text)).toMatchObject({ error: "Comment body too large", code: "comment_body_too_large" });
    expectProbeWithinBudget(probe);
    expect(await commentBodyLengths(issueId)).toEqual([]);
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");
  }, 30_000);

  it("rejects a 5MB comment from its declared length without parsing it", async () => {
    const { companyId, issueId, referencedIssueId } = await seedIssues();
    const baseUrl = await startApp(companyId, referencedIssueId);
    const payload = commentPayload("y".repeat(5 * 1024 * 1024));

    const { result, ...probe } = await probeWhile(baseUrl, postComment(baseUrl, issueId, payload));

    expect(result.status).toBe(413);
    expect(JSON.parse(result.text)).toMatchObject({ error: "Request body too large", code: "entity.too.large" });
    expect(result.elapsedMs).toBeLessThan(RESPONSE_BUDGET_MS);
    expectProbeWithinBudget(probe);
    expect(await commentBodyLengths(issueId)).toEqual([]);
  }, 30_000);

  it("rejects any request over the global JSON body limit with 413 instead of 500", async () => {
    const { companyId, issueId, referencedIssueId } = await seedIssues();
    const baseUrl = await startApp(companyId, referencedIssueId);
    const payload = Buffer.from(JSON.stringify({ description: "z".repeat(11 * 1024 * 1024) }));

    const result = await sendJson(baseUrl, "PATCH", `/api/issues/${issueId}`, payload);

    expect(result.status).toBe(413);
    expect(JSON.parse(result.text)).toMatchObject({ error: "Request body too large", code: "entity.too.large" });
  }, 30_000);

  it("answers a stalled request body with 408 and keeps serving other routes", async () => {
    const { companyId, issueId, referencedIssueId } = await seedIssues();
    const baseUrl = await startApp(companyId, referencedIssueId, { bodyTimeoutMs: 200 });
    const url = new URL(`${baseUrl}/api/issues/${issueId}/comments`);

    const stalled = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "1000" },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      // Send a fragment of the declared body and then go silent.
      req.write('{"body":"partial');
    });

    const { result, ...probe } = await probeWhile(baseUrl, stalled);

    expect(result.status).toBe(408);
    expect(JSON.parse(result.body)).toMatchObject({ code: "request_body_timeout" });
    expectProbeWithinBudget(probe);
    expect(await commentBodyLengths(issueId)).toEqual([]);
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issueService.checkout run context snapshot backfill", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-run-context-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TimerCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedTodoIssue(companyId: string, title: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "todo",
      priority: "medium",
    });
    return issueId;
  }

  function runRow(companyId: string, agentId: string, contextSnapshot: Record<string, unknown>) {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      status: "running" as const,
      invocationSource: "heartbeat" as const,
      contextSnapshot,
    };
  }

  it("stamps the checked-out issue into an unscoped timer run so same-issue writes are exempt", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoIssue(companyId, "Timer wake work");
    const run = runRow(companyId, agentId, { wakeReason: "heartbeat_timer" });
    await db.insert(heartbeatRuns).values(run);

    await svc.checkout(issueId, agentId, ["todo"], run.id);

    const persisted = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id))
      .then((rows) => rows[0]);
    expect(persisted?.contextSnapshot).toMatchObject({
      wakeReason: "heartbeat_timer",
      issueId,
    });

    // The write the run just earned by checking out: exempt, not counted.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId: run.id,
      agentId,
      targetIssueId: issueId,
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();

    // A different issue is still guarded by the cap.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId: run.id,
      agentId,
      targetIssueId: randomUUID(),
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ count: 1, allowed: true });
  });

  it("does not clobber the source issue of a run that is already scoped elsewhere", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const scopedIssueId = await seedTodoIssue(companyId, "Task wake source");
    const otherIssueId = await seedTodoIssue(companyId, "Different checkout target");
    const run = runRow(companyId, agentId, { issueId: scopedIssueId });
    await db.insert(heartbeatRuns).values(run);

    await svc.checkout(otherIssueId, agentId, ["todo"], run.id);

    const persisted = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id))
      .then((rows) => rows[0]);
    expect(persisted?.contextSnapshot).toMatchObject({ issueId: scopedIssueId });

    // The checked-out-but-foreign issue is still treated as cross-issue
    // influence: counted against the cap, never exempted by the stamp.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId: run.id,
      agentId,
      targetIssueId: otherIssueId,
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ count: 1, allowed: true });
  });

  it("skips the stamp for a checkout without a run id instead of failing", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoIssue(companyId, "User checkout");

    await expect(svc.checkout(issueId, agentId, ["todo"], null)).resolves.toMatchObject({
      id: issueId,
      status: "in_progress",
    });
  });
});


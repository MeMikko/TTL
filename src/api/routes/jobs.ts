import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, lt, or } from 'drizzle-orm';
import { targetPolicyFromConfig } from '../../core/config.js';
import { parseEncryptionKey } from '../../core/crypto.js';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import {
  createJob,
  decryptHeaders,
  deleteJob,
  getJob,
  pauseJob,
  resumeJob,
  triggerJob,
  updateJob,
  type JobsDeps,
  type ScheduleInput,
} from '../../core/jobs.js';
import type { AppDeps } from '../context.js';
import { createRouter } from '../router.js';
import {
  AttemptSchema,
  CreateJobSchema,
  JobSchema,
  PageQuerySchema,
  RunSchema,
  UpdateJobSchema,
  errorResponses,
  idParam,
} from '../schemas.js';
import {
  decodeCursor,
  encodeCursor,
  serializeAttempt,
  serializeJob,
  serializeRun,
} from '../serializers.js';

const security = [{ bearerAuth: [] }];
const jsonContent = <T extends z.ZodType>(s: T) => ({ 'application/json': { schema: s } });
const jobIdParam = idParam('job');
const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });

const routes = {
  create: createRoute({
    method: 'post',
    path: '/v1/jobs',
    tags: ['jobs'],
    summary: 'Create a scheduled job (cron or one-off HTTP webhook)',
    description:
      'Supports the Idempotency-Key header. Deliveries are signed with T2L-Signature ' +
      '(see GET /v1/account/webhook-secret).',
    security,
    request: { body: { required: true, content: jsonContent(CreateJobSchema) } },
    responses: {
      201: { description: 'Job created', content: jsonContent(JobSchema) },
      ...errorResponses(400, 401, 403, 409, 422, 429),
    },
  }),
  list: createRoute({
    method: 'get',
    path: '/v1/jobs',
    tags: ['jobs'],
    summary: 'List jobs (newest first)',
    security,
    request: { query: PageQuerySchema },
    responses: {
      200: { description: 'Jobs', content: jsonContent(page(JobSchema)) },
      ...errorResponses(400, 401, 403, 429),
    },
  }),
  get: createRoute({
    method: 'get',
    path: '/v1/jobs/{id}',
    tags: ['jobs'],
    summary: 'Get a job',
    security,
    request: { params: jobIdParam },
    responses: {
      200: { description: 'Job', content: jsonContent(JobSchema) },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  update: createRoute({
    method: 'patch',
    path: '/v1/jobs/{id}',
    tags: ['jobs'],
    summary: 'Update a job',
    description:
      'Fields in `target` are merged; `target.headers`, when given, replaces all headers.',
    security,
    request: {
      params: jobIdParam,
      body: { required: true, content: jsonContent(UpdateJobSchema) },
    },
    responses: {
      200: { description: 'Updated job', content: jsonContent(JobSchema) },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  remove: createRoute({
    method: 'delete',
    path: '/v1/jobs/{id}',
    tags: ['jobs'],
    summary: 'Delete a job and its run history',
    security,
    request: { params: jobIdParam },
    responses: {
      200: {
        description: 'Deleted',
        content: jsonContent(z.object({ id: z.string(), deleted: z.literal(true) })),
      },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  pause: createRoute({
    method: 'post',
    path: '/v1/jobs/{id}/pause',
    tags: ['jobs'],
    summary: 'Pause a job (pending runs are cancelled)',
    security,
    request: { params: jobIdParam },
    responses: {
      200: { description: 'Paused job', content: jsonContent(JobSchema) },
      ...errorResponses(400, 401, 403, 404, 409, 429),
    },
  }),
  resume: createRoute({
    method: 'post',
    path: '/v1/jobs/{id}/resume',
    tags: ['jobs'],
    summary: 'Resume a paused job from now on',
    security,
    request: { params: jobIdParam },
    responses: {
      200: { description: 'Active job', content: jsonContent(JobSchema) },
      ...errorResponses(400, 401, 403, 404, 409, 429),
    },
  }),
  trigger: createRoute({
    method: 'post',
    path: '/v1/jobs/{id}/trigger',
    tags: ['jobs'],
    summary: 'Run a job now (counts against the monthly run quota)',
    description: 'Supports the Idempotency-Key header.',
    security,
    request: { params: jobIdParam },
    responses: {
      202: { description: 'Run queued', content: jsonContent(RunSchema) },
      ...errorResponses(400, 401, 402, 403, 404, 429),
    },
  }),
  runs: createRoute({
    method: 'get',
    path: '/v1/jobs/{id}/runs',
    tags: ['runs'],
    summary: 'List runs of a job (newest first, kept 30 days)',
    security,
    request: { params: jobIdParam, query: PageQuerySchema },
    responses: {
      200: { description: 'Runs', content: jsonContent(page(RunSchema)) },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  run: createRoute({
    method: 'get',
    path: '/v1/runs/{id}',
    tags: ['runs'],
    summary: 'Get a run with its delivery attempts (log)',
    security,
    request: { params: idParam('run') },
    responses: {
      200: {
        description: 'Run',
        content: jsonContent(RunSchema.extend({ attemptLog: z.array(AttemptSchema) })),
      },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
};

function toSchedule(s: z.infer<typeof CreateJobSchema>['schedule']): ScheduleInput {
  return s.type === 'cron'
    ? { type: 'cron', expression: s.expression, timezone: s.timezone }
    : { type: 'once', at: new Date(s.at) };
}

function cursorOrThrow(cursor: string | undefined) {
  if (cursor === undefined) return null;
  const c = decodeCursor(cursor);
  if (!c) throw new ApiError(400, 'invalid_cursor', 'Invalid pagination cursor');
  return c;
}

export function jobRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const jobsDeps: JobsDeps = {
    db,
    encryptionKey: parseEncryptionKey(deps.config.ENCRYPTION_KEY),
    policy: targetPolicyFromConfig(deps.config),
    maxJobsPerAccount: deps.config.MAX_JOBS_PER_ACCOUNT,
    resolve: deps.dnsResolve,
  };
  const render = (job: Parameters<typeof serializeJob>[0]) =>
    serializeJob(job, decryptHeaders(jobsDeps.encryptionKey, job));
  const app = createRouter();

  app.openapi(routes.create, async (c) => {
    const body = c.req.valid('json');
    const job = await createJob(
      jobsDeps,
      c.get('account'),
      { ...body, schedule: toSchedule(body.schedule) },
      now(),
    );
    return c.json(render(job), 201);
  });

  app.openapi(routes.list, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const after = cursorOrThrow(cursor);
    const t = schema.jobs;
    const rows = await db
      .select()
      .from(t)
      .where(
        and(
          eq(t.accountId, c.get('account').id),
          after
            ? or(
                lt(t.createdAt, after.createdAt),
                and(eq(t.createdAt, after.createdAt), lt(t.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return c.json(
      {
        data: pageRows.map(render),
        nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      },
      200,
    );
  });

  app.openapi(routes.get, async (c) => {
    const job = await getJob(db, c.get('account').id, c.req.valid('param').id);
    return c.json(render(job), 200);
  });

  app.openapi(routes.update, async (c) => {
    const body = c.req.valid('json');
    const job = await updateJob(
      jobsDeps,
      c.get('account').id,
      c.req.valid('param').id,
      { ...body, schedule: body.schedule ? toSchedule(body.schedule) : undefined },
      now(),
    );
    return c.json(render(job), 200);
  });

  app.openapi(routes.remove, async (c) => {
    const { id } = c.req.valid('param');
    await deleteJob(db, c.get('account').id, id);
    return c.json({ id, deleted: true as const }, 200);
  });

  app.openapi(routes.pause, async (c) => {
    const job = await pauseJob(db, c.get('account').id, c.req.valid('param').id, now());
    return c.json(render(job), 200);
  });

  app.openapi(routes.resume, async (c) => {
    const job = await resumeJob(db, c.get('account').id, c.req.valid('param').id, now());
    return c.json(render(job), 200);
  });

  app.openapi(routes.trigger, async (c) => {
    const run = await triggerJob(db, c.get('account'), c.req.valid('param').id, now());
    return c.json(serializeRun(run), 202);
  });

  app.openapi(routes.runs, async (c) => {
    const { id } = c.req.valid('param');
    const { limit, cursor } = c.req.valid('query');
    await getJob(db, c.get('account').id, id); // ownership check
    const after = cursorOrThrow(cursor);
    const t = schema.jobRuns;
    const rows = await db
      .select()
      .from(t)
      .where(
        and(
          eq(t.jobId, id),
          after
            ? or(
                lt(t.createdAt, after.createdAt),
                and(eq(t.createdAt, after.createdAt), lt(t.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return c.json(
      {
        data: pageRows.map(serializeRun),
        nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      },
      200,
    );
  });

  app.openapi(routes.run, async (c) => {
    const [run] = await db
      .select()
      .from(schema.jobRuns)
      .where(
        and(
          eq(schema.jobRuns.id, c.req.valid('param').id),
          eq(schema.jobRuns.accountId, c.get('account').id),
        ),
      );
    if (!run) throw new ApiError(404, 'not_found', 'Run not found');
    const attempts = await db
      .select()
      .from(schema.jobAttempts)
      .where(eq(schema.jobAttempts.runId, run.id))
      .orderBy(asc(schema.jobAttempts.attempt));
    return c.json({ ...serializeRun(run), attemptLog: attempts.map(serializeAttempt) }, 200);
  });

  return app;
}

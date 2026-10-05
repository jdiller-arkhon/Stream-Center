import type { Job } from '../../shared/contracts';
import type { Db } from '../core/database';
import { DriftFailure, fail, toDriftError } from '../core/errors';
import type { EventBus } from '../core/events';
import { newId, nowIso } from '../core/ids';
import type { Logger } from '../core/logger';

export type JobKind = Job['kind'];

export interface JobContext<P> {
  job: Job;
  payload: P;
  signal: AbortSignal;
  /** Report real progress (0..1). Throttled before reaching the UI. */
  progress(fraction: number | null, detail?: string | null): void;
  setState(state: 'running' | 'validating'): void;
  lowPriority(): boolean;
}

export interface JobOutcome {
  outputPath?: string | null;
  outputClipId?: string | null;
}

export type JobHandler<P = unknown> = (ctx: JobContext<P>) => Promise<JobOutcome>;

interface Row {
  doc: string;
  spec: string;
}

const ACTIVE: Job['state'][] = ['queued', 'running', 'validating'];

/**
 * Persistent background job queue with bounded concurrency, cancellation and retry.
 * Jobs interrupted by an app exit are marked INTERRUPTED (retryable) on next start.
 */
export class JobQueue {
  private readonly handlers = new Map<JobKind, JobHandler<never>>();
  private readonly running = new Map<string, AbortController>();
  private readonly runningTasks = new Map<string, Promise<void>>();
  private stopping = false;
  private readonly lastEmit = new Map<string, number>();
  private started = false;

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private concurrency: () => number,
    private readonly isGaming: () => boolean,
  ) {}

  register<P>(kind: JobKind, handler: JobHandler<P>): void {
    this.handlers.set(kind, handler as JobHandler<never>);
  }

  /** Recovers state from the previous run and starts processing. */
  start(): void {
    const rows = this.db.prepare("SELECT doc FROM jobs WHERE state IN ('running','validating')").all() as unknown as Row[];
    for (const r of rows) {
      const job = JSON.parse(r.doc) as Job;
      job.state = 'failed';
      job.finishedAt = nowIso();
      job.error = { code: 'INTERRUPTED', message: 'Drift Studio closed while this job was running.', detail: null, retryable: true };
      job.progress = null;
      this.persist(job);
    }
    this.started = true;
    this.pump();
  }

  /**
   * Stops processing for app shutdown. Running jobs are aborted but their stored
   * state is left as-is so the next start() reports them as INTERRUPTED (retryable).
   */
  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    for (const c of this.running.values()) c.abort();
    await Promise.race([Promise.allSettled([...this.runningTasks.values()]), new Promise((r) => setTimeout(r, 5000))]);
  }

  enqueue<P>(kind: JobKind, label: string, payload: P, refId: string | null = null): Job {
    if (!this.handlers.has(kind)) fail('UNSUPPORTED', `No handler for ${kind} jobs`);
    const job: Job = {
      id: newId('job'),
      kind,
      state: 'queued',
      label,
      progress: null,
      progressDetail: 'Waiting in queue',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      error: null,
      outputPath: null,
      outputClipId: null,
      refId,
    };
    this.db.prepare('INSERT INTO jobs(id, kind, state, created_at, doc, spec) VALUES(?,?,?,?,?,?)').run(job.id, kind, job.state, job.createdAt, JSON.stringify(job), JSON.stringify(payload));
    this.emit(job, true);
    this.pump();
    return job;
  }

  /** Finds an active job with an identical spec (prevents accidental duplicate requests). */
  findActiveBySpec(kind: JobKind, payload: unknown): Job | null {
    const spec = JSON.stringify(payload);
    const rows = this.db.prepare("SELECT doc, spec FROM jobs WHERE kind = ? AND state IN ('queued','running','validating')").all(kind) as unknown as Row[];
    const hit = rows.find((r) => r.spec === spec);
    return hit ? (JSON.parse(hit.doc) as Job) : null;
  }

  get(id: string): Job {
    const row = this.db.prepare('SELECT doc FROM jobs WHERE id = ?').get(id) as Row | undefined;
    if (!row) fail('NOT_FOUND', 'Job not found', { detail: id });
    return JSON.parse(row.doc) as Job;
  }

  list(limit = 100): Job[] {
    return (this.db.prepare('SELECT doc FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Row[]).map((r) => JSON.parse(r.doc) as Job);
  }

  activeCount(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state IN ('queued','running','validating')").get() as { n: number }).n;
  }

  cancel(id: string): Job {
    const job = this.get(id);
    if (!ACTIVE.includes(job.state)) return job;
    const ctl = this.running.get(id);
    if (ctl) {
      ctl.abort();
      return { ...job, progressDetail: 'Cancelling…' };
    }
    job.state = 'cancelled';
    job.finishedAt = nowIso();
    job.progressDetail = null;
    this.persist(job);
    this.emit(job, true);
    return job;
  }

  retry(id: string): Job {
    const job = this.get(id);
    if (job.state !== 'failed' && job.state !== 'cancelled') fail('CONFLICT', 'Only failed or cancelled jobs can be retried');
    job.state = 'queued';
    job.error = null;
    job.progress = null;
    job.progressDetail = 'Waiting in queue';
    job.startedAt = null;
    job.finishedAt = null;
    job.outputPath = null;
    job.outputClipId = null;
    this.persist(job);
    this.emit(job, true);
    this.pump();
    return job;
  }

  clearFinished(): void {
    this.db.prepare("DELETE FROM jobs WHERE state IN ('succeeded','cancelled','failed')").run();
  }

  private pump(): void {
    if (!this.started) return;
    while (this.running.size < Math.max(1, this.concurrency())) {
      const row = this.db.prepare("SELECT doc, spec FROM jobs WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1").get() as Row | undefined;
      if (!row) return;
      const job = JSON.parse(row.doc) as Job;
      const task = this.runJob(job, JSON.parse(row.spec)).finally(() => this.runningTasks.delete(job.id));
      this.runningTasks.set(job.id, task);
    }
  }

  private async runJob(job: Job, payload: unknown): Promise<void> {
    const handler = this.handlers.get(job.kind)!;
    const ctl = new AbortController();
    this.running.set(job.id, ctl);
    job.state = 'running';
    job.attempts += 1;
    job.startedAt = nowIso();
    job.progress = 0;
    job.progressDetail = 'Starting';
    this.persist(job);
    this.emit(job, true);
    try {
      const outcome = await handler({
        job,
        payload: payload as never,
        signal: ctl.signal,
        progress: (fraction, detail) => {
          if (this.stopping) return;
          job.progress = fraction === null ? null : Math.max(0, Math.min(1, fraction));
          if (detail !== undefined) job.progressDetail = detail;
          this.emit(job, false);
        },
        setState: (state) => {
          job.state = state;
          this.persist(job);
          this.emit(job, true);
        },
        lowPriority: () => this.isGaming(),
      });
      if (ctl.signal.aborted) throw new DriftFailure('CANCELLED', 'Cancelled');
      job.state = 'succeeded';
      job.progress = 1;
      job.progressDetail = null;
      job.outputPath = outcome.outputPath ?? null;
      job.outputClipId = outcome.outputClipId ?? null;
      job.error = null;
    } catch (err) {
      const e = toDriftError(err);
      if (e.code === 'CANCELLED' || ctl.signal.aborted) {
        job.state = 'cancelled';
        job.error = null;
      } else {
        job.state = 'failed';
        job.error = e;
        this.log.warn('job failed', { id: job.id, kind: job.kind, error: e });
      }
      job.progressDetail = null;
    } finally {
      this.running.delete(job.id);
      if (this.stopping) return; // leave stored state for INTERRUPTED recovery
      job.finishedAt = nowIso();
      this.persist(job);
      this.emit(job, true);
      this.pump();
    }
  }

  private persist(job: Job): void {
    this.db.prepare('UPDATE jobs SET state=?, doc=? WHERE id=?').run(job.state, JSON.stringify(job), job.id);
  }

  private emit(job: Job, force: boolean): void {
    const now = Date.now();
    if (!force && now - (this.lastEmit.get(job.id) ?? 0) < 250) return;
    this.lastEmit.set(job.id, now);
    this.bus.emit('job.updated', { ...job });
  }
}

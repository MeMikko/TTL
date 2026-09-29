CREATE TABLE "job_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"http_status" integer,
	"response_snippet" text,
	"error_kind" text,
	"error" text,
	"final_url" text
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"account_id" text NOT NULL,
	"trigger" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"last_http_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_runs_status_check" CHECK ("job_runs"."status" in ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"schedule_kind" text NOT NULL,
	"cron_expr" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"run_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone,
	"url" text NOT NULL,
	"method" text DEFAULT 'POST' NOT NULL,
	"headers_enc" text,
	"body" text,
	"timeout_ms" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('active', 'paused', 'completed')),
	CONSTRAINT "jobs_method_check" CHECK ("jobs"."method" in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
	CONSTRAINT "jobs_schedule_check" CHECK (("jobs"."schedule_kind" = 'cron' and "jobs"."cron_expr" is not null) or ("jobs"."schedule_kind" = 'once' and "jobs"."run_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"account_id" text NOT NULL,
	"period" text NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_account_id_period_pk" PRIMARY KEY("account_id","period")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_run_id_job_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempts_run_attempt_idx" ON "job_attempts" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE INDEX "job_runs_pending_idx" ON "job_runs" USING btree ("next_attempt_at") WHERE "job_runs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "job_runs_running_idx" ON "job_runs" USING btree ("locked_until") WHERE "job_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "job_runs_job_idx" ON "job_runs" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "job_runs_created_at_idx" ON "job_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_schedule_unique_idx" ON "job_runs" USING btree ("job_id","scheduled_for") WHERE "job_runs"."trigger" = 'schedule';--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("next_run_at") WHERE "jobs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "jobs_account_idx" ON "jobs" USING btree ("account_id","created_at");
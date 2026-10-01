ALTER TABLE "monitors" ADD COLUMN "mode" text DEFAULT 'heartbeat' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "check_url" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "check_interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_probe_ok" boolean;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_probe_detail" text;--> statement-breakpoint
CREATE INDEX "monitors_probe_idx" ON "monitors" USING btree ("last_probe_at") WHERE "monitors"."mode" = 'active';
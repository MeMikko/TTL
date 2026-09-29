CREATE TABLE "alert_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"monitor_id" text NOT NULL,
	"account_id" text NOT NULL,
	"event" text NOT NULL,
	"channel" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"last_http_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitor_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "monitor_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"monitor_id" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"grace_seconds" integer NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"last_ping_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"dead_since" timestamp with time zone,
	"alert_webhook_url" text,
	"alert_telegram" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitors_status_check" CHECK ("monitors"."status" in ('new', 'alive', 'dead', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "telegram_link_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_events" ADD CONSTRAINT "monitor_events_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_deliveries_pending_idx" ON "alert_deliveries" USING btree ("next_attempt_at") WHERE "alert_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "alert_deliveries_running_idx" ON "alert_deliveries" USING btree ("locked_until") WHERE "alert_deliveries"."status" = 'running';--> statement-breakpoint
CREATE INDEX "alert_deliveries_monitor_idx" ON "alert_deliveries" USING btree ("monitor_id","created_at");--> statement-breakpoint
CREATE INDEX "alert_deliveries_created_at_idx" ON "alert_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "monitor_events_monitor_idx" ON "monitor_events" USING btree ("monitor_id","at");--> statement-breakpoint
CREATE INDEX "monitor_events_at_idx" ON "monitor_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "monitors_expiry_idx" ON "monitors" USING btree ("expires_at") WHERE "monitors"."status" = 'alive';--> statement-breakpoint
CREATE INDEX "monitors_account_idx" ON "monitors" USING btree ("account_id","created_at");
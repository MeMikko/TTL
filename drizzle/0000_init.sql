CREATE TABLE "worker_ticks" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL
);

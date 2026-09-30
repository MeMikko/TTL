CREATE TABLE "keeper_cursors" (
	"chain_id" integer NOT NULL,
	"factory" text NOT NULL,
	"next_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keeper_cursors_chain_id_factory_pk" PRIMARY KEY("chain_id","factory")
);
--> statement-breakpoint
CREATE TABLE "keeper_switches" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"owner" text NOT NULL,
	"created_block" bigint NOT NULL,
	"deadline" bigint,
	"checked_at" timestamp with time zone,
	"triggered_at" timestamp with time zone,
	"trigger_tx" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keeper_switches_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE INDEX "keeper_switches_due_idx" ON "keeper_switches" USING btree ("chain_id","deadline");
CREATE TABLE "credits_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credits_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" text NOT NULL,
	"delta_micro" bigint NOT NULL,
	"reason" text NOT NULL,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"product" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"network" text NOT NULL,
	"asset" text NOT NULL,
	"payer" text,
	"transaction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "credit_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "billing" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "paid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credits_ledger" ADD CONSTRAINT "credits_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credits_ledger_account_idx" ON "credits_ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tx_idx" ON "payments" USING btree ("network","transaction");--> statement-breakpoint
CREATE INDEX "payments_account_idx" ON "payments" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "monitors_paid_until_idx" ON "monitors" USING btree ("paid_until") WHERE "monitors"."billing" = 'paid';--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_credit_nonnegative" CHECK ("accounts"."credit_micro" >= 0);
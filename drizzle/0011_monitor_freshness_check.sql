ALTER TABLE "monitors" ADD COLUMN "check_json_path" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "check_max_age_seconds" integer;
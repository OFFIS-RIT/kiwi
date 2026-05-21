ALTER TABLE "text_units" ADD COLUMN "start_page" integer;--> statement-breakpoint
ALTER TABLE "text_units" ADD COLUMN "end_page" integer;--> statement-breakpoint
ALTER TABLE "text_units" ADD CONSTRAINT "text_units_page_span_check" CHECK ((("start_page" IS NULL AND "end_page" IS NULL) OR ("start_page" IS NOT NULL AND "end_page" IS NOT NULL AND "start_page" >= 1 AND "end_page" >= "start_page")));
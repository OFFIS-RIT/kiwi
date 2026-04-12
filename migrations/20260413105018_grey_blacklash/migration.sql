ALTER TABLE "files" ADD COLUMN "status" text DEFAULT 'processing' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "process_step" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE "files" SET "status" = 'processed', "process_step" = 'completed';

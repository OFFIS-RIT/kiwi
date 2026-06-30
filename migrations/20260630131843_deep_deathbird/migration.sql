ALTER TABLE "code_graph_layers" ADD COLUMN "branch" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "code_graph_layers_identity_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "code_graph_layers_current_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "code_graph_layers_identity_idx" ON "code_graph_layers" USING btree ("graph_id","layer","repository_scope","branch","snapshot_key");
--> statement-breakpoint
CREATE INDEX "code_graph_layers_current_idx" ON "code_graph_layers" USING btree ("graph_id","layer","repository_scope","branch","created_at") WHERE "code_graph_layers"."status" = 'current';

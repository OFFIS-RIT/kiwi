CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgrouting;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vectorscale;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_cron;
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"idToken" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL,
	"token" text NOT NULL UNIQUE,
	"expiresAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"imposonatedBy" text
);
--> statement-breakpoint
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text,
	"banned" boolean,
	"banReason" text,
	"banExpires" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chats" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY,
	"chat_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"tokens_per_second" double precision,
	"time_to_first_token" double precision,
	"input_tokens" double precision,
	"output_tokens" double precision,
	"total_tokens" double precision,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "chat_messages_parts_array_check" CHECK (jsonb_typeof("parts") = 'array')
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY,
	"graph_id" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"type" text NOT NULL,
	"embedding" vector(4096) NOT NULL,
	"search_tsv" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(name, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY,
	"graph_id" text NOT NULL,
	"name" text NOT NULL,
	"file_size" integer NOT NULL,
	"file_type" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_key" text NOT NULL,
	"deleted" boolean DEFAULT false,
	"token_count" integer DEFAULT 0 NOT NULL,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "graphs" (
	"id" text PRIMARY KEY,
	"group_id" text,
	"user_id" text,
	"graph_id" text,
	"name" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'ready' NOT NULL,
	"type" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "graphs_single_owner_check" CHECK (((("group_id" IS NOT NULL)::int + ("user_id" IS NOT NULL)::int + ("graph_id" IS NOT NULL)::int) <= 1))
);
--> statement-breakpoint
ALTER TABLE "graphs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "graph_updates" (
	"id" text PRIMARY KEY,
	"graph_id" text NOT NULL,
	"update_type" text NOT NULL,
	"update_message" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "graph_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "group_users" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "group_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "process_stats" (
	"id" text PRIMARY KEY,
	"total_time" double precision DEFAULT 0 NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"file_sizes" double precision DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "process_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" text PRIMARY KEY,
	"active" boolean DEFAULT false NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"graph_id" text NOT NULL,
	"rank" double precision DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"embedding" vector(4096) NOT NULL,
	"search_tsv" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(description, '')), 'A')) STORED,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "relationships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY,
	"entity_id" text,
	"relationship_id" text,
	"text_unit_id" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"embedding" vector(4096) NOT NULL,
	"search_tsv" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(description, '')), 'A')) STORED,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "system_prompts" (
	"id" text PRIMARY KEY,
	"graph_id" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "system_prompts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "text_units" (
	"id" text PRIMARY KEY,
	"file_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "text_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_user_chats_user_project_updated_at" ON "chats" ("user_id","project_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_chat_messages_chat_id_id" ON "messages" ("chat_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_chat_role_status_id" ON "messages" ("chat_id","role","status","created_at","id");--> statement-breakpoint
CREATE INDEX "graphs_group_type_idx" ON "graphs" ("group_id","type");--> statement-breakpoint
CREATE INDEX "graphs_user_type_idx" ON "graphs" ("user_id","type");--> statement-breakpoint
CREATE INDEX "graphs_graph_type_idx" ON "graphs" ("graph_id","type");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_imposonatedBy_user_id_fkey" FOREIGN KEY ("imposonatedBy") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_project_id_graphs_id_fkey" FOREIGN KEY ("project_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "graph_updates" ADD CONSTRAINT "graph_updates_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_users" ADD CONSTRAINT "group_users_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_users" ADD CONSTRAINT "group_users_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_id_entities_id_fkey" FOREIGN KEY ("source_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_target_id_entities_id_fkey" FOREIGN KEY ("target_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_entity_id_entities_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_relationship_id_relationships_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationships"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_text_unit_id_text_units_id_fkey" FOREIGN KEY ("text_unit_id") REFERENCES "text_units"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "system_prompts" ADD CONSTRAINT "system_prompts_graph_id_graphs_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "text_units" ADD CONSTRAINT "text_units_file_id_files_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE;

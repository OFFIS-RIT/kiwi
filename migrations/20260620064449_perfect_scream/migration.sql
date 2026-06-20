ALTER TABLE "connector_resource_bindings" DROP CONSTRAINT "connector_resource_bindings_provider_check";--> statement-breakpoint
ALTER TABLE "connector_installations" DROP CONSTRAINT "connector_installations_provider_check";--> statement-breakpoint
ALTER TABLE "connector_webhook_events" DROP CONSTRAINT "connector_webhook_events_provider_check";--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_provider_check";
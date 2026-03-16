package util

import (
	"context"
	"fmt"
	"strings"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

type BlockingProjectQueryClient interface {
	QueryLocal(ctx context.Context, msgs []ai.ChatMessage) (string, error)
	QueryAgentic(ctx context.Context, msgs []ai.ChatMessage, tools []ai.Tool) (string, error)
}

func ExecuteBlockingProjectQuery(
	ctx context.Context,
	queryClient BlockingProjectQueryClient,
	queryMode string,
	chatHistory []ai.ChatMessage,
	tools []ai.Tool,
) (string, error) {
	switch queryMode {
	case "agentic":
		return queryClient.QueryAgentic(ctx, chatHistory, tools)
	case "normal":
		fallthrough
	default:
		return queryClient.QueryLocal(ctx, chatHistory)
	}
}

func BuildExpertGraphCatalog(currentProjectID string, expertProjects []pgdb.GetAvailableExpertProjectsRow) string {
	var catalogBuilder strings.Builder
	fmt.Fprintf(&catalogBuilder, "Current query graph id (you may use this with ask_expert for complex query decomposition): %s\n", currentProjectID)

	if len(expertProjects) == 0 {
		catalogBuilder.WriteString("Available expert graphs (state=ready only): none.")
		return strings.TrimSpace(catalogBuilder.String())
	}

	catalogBuilder.WriteString("Available expert graphs (state=ready only; use these exact expert_graph_id values with ask_expert):\n")
	for _, expertProject := range expertProjects {
		description := "No description provided."
		if expertProject.Description.Valid {
			trimmedDescription := strings.TrimSpace(expertProject.Description.String)
			if trimmedDescription != "" {
				description = trimmedDescription
			}
		}

		fmt.Fprintf(&catalogBuilder, "- expert_graph_id=%s | expert_graph_name=%q | description=%q\n", expertProject.ProjectID, expertProject.Name, description)
	}

	return strings.TrimSpace(catalogBuilder.String())
}

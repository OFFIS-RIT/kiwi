package aiclient

import (
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"
	oai "github.com/OFFIS-RIT/kiwi/backend/pkg/ai/ollama"
	gai "github.com/OFFIS-RIT/kiwi/backend/pkg/ai/openai"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/logger"
)

func NewChat(timeoutMin int) ai.GraphAIClient {
	return newGraphClient(timeoutMin, "AI_CHAT")
}

func NewExtract(timeoutMin int) ai.GraphAIClient {
	return newGraphClient(timeoutMin, "AI_EXTRACT")
}

func newGraphClient(timeoutMin int, profile string) ai.GraphAIClient {
	adapter := util.GetEnv("AI_ADAPTER")
	chatModel := util.GetEnv(profile + "_MODEL")
	chatURL := envWithFallback(profile+"_URL", "AI_CHAT_URL")
	chatKey := envWithFallback(profile+"_KEY", "AI_CHAT_KEY")

	switch adapter {
	case "ollama":
		client, err := oai.NewGraphOllamaClient(oai.NewGraphOllamaClientParams{
			EmbeddingModel:        util.GetEnv("AI_EMBED_MODEL"),
			ChatModel:             chatModel,
			ImageModel:            util.GetEnv("AI_IMAGE_MODEL"),
			BaseURL:               chatURL,
			ApiKey:                chatKey,
			MaxConcurrentRequests: int64(util.GetEnvNumeric("AI_PARALLEL_REQ", 15)),
			TimeoutMin:            timeoutMin,
		})
		if err != nil {
			logger.Fatal("Failed to create Ollama client", "err", err)
		}
		return client
	default:
		return gai.NewGraphOpenAIClient(gai.NewGraphOpenAIClientParams{
			EmbeddingModel:        util.GetEnv("AI_EMBED_MODEL"),
			ChatModel:             chatModel,
			ImageModel:            util.GetEnv("AI_IMAGE_MODEL"),
			EmbeddingURL:          util.GetEnv("AI_EMBED_URL"),
			EmbeddingKey:          util.GetEnv("AI_EMBED_KEY"),
			ChatURL:               chatURL,
			ChatKey:               chatKey,
			ImageURL:              util.GetEnv("AI_IMAGE_URL"),
			ImageKey:              util.GetEnv("AI_IMAGE_KEY"),
			MaxConcurrentRequests: int64(util.GetEnvNumeric("AI_PARALLEL_REQ", 15)),
			TimeoutMin:            timeoutMin,
		})
	}
}

func envWithFallback(primary, fallback string) string {
	if value := util.GetEnvString(primary, ""); value != "" {
		return value
	}
	return util.GetEnv(fallback)
}

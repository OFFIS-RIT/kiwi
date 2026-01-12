package openai

import (
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// GraphOpenAIClient is a client for interacting with AI models used in the
// graph RAG system. It manages separate OpenAI clients for embeddings
// and chat/completion tasks.
//
// A GraphOpenAIClient should be created using NewGraphAIClient.
type GraphOpenAIClient struct {
	embeddingModel   string
	descriptionModel string
	extractionModel  string
	imageModel       string
	audioModel       string

	embeddingURL string
	embeddingKey string
	chatURL      string
	chatKey      string
	imageURL     string
	imageKey     string
	audioURL     string
	audioKey     string

	metricsLock sync.Mutex
	metrics     ai.ModelMetrics

	ChatClient      *openai.Client
	EmbeddingClient *openai.Client
	ImageClient     *openai.Client
	AudioClient     *openai.Client
}

// NewGraphAIClientParams defines the configuration parameters for creating
// a new GraphAIClient.
//
// EmbeddingModel specifies the model used for embeddings.
// DescriptionModel specifies the model used for generating descriptions.
// ExtractionModel specifies the model used for information extraction.
// EmbeddingURL and EmbeddingKey configure the embedding API endpoint.
// ChatURL and ChatKey configure the chat/completion API endpoint.
type NewGraphOpenAIClientParams struct {
	EmbeddingModel   string
	DescriptionModel string
	ExtractionModel  string
	ImageModel       string
	AudioModel       string

	EmbeddingURL string
	EmbeddingKey string
	ChatURL      string
	ChatKey      string
	ImageURL     string
	ImageKey     string
	AudioURL     string
	AudioKey     string
}

// NewGraphAIClient creates and returns a new GraphAIClient configured with
// the provided parameters. It initializes separate OpenAI clients for
// embeddings and chat/completion tasks.
//
// Example:
//
//	params := ai.NewGraphAIClientParams{
//		EmbeddingModel:   "text-embedding-3-small",
//		DescriptionModel: "gpt-4o-mini",
//		ExtractionModel:  "gpt-4o-mini",
//		EmbeddingURL:     "https://api.openai.com/v1",
//		EmbeddingKey:     os.Getenv("OPENAI_API_KEY"),
//		ChatURL:          "https://api.openai.com/v1",
//		ChatKey:          os.Getenv("OPENAI_API_KEY"),
//	}
//	client := ai.NewGraphAIClient(params)
func NewGraphOpenAIClient(
	params NewGraphOpenAIClientParams,
) *GraphOpenAIClient {
	chatClient := newOpenaiClient(params.ChatURL, params.ChatKey)
	embedClient := newOpenaiClient(params.EmbeddingURL, params.EmbeddingKey)
	imageClient := newOpenaiClient(params.ImageURL, params.ImageKey)
	audioClient := newOpenaiClient(params.AudioURL, params.AudioKey)

	return &GraphOpenAIClient{
		embeddingModel:   params.EmbeddingModel,
		descriptionModel: params.DescriptionModel,
		extractionModel:  params.ExtractionModel,
		imageModel:       params.ImageModel,
		audioModel:       params.AudioModel,

		chatURL:      params.ChatURL,
		chatKey:      params.ChatKey,
		embeddingURL: params.EmbeddingURL,
		embeddingKey: params.EmbeddingKey,
		imageURL:     params.ImageURL,
		imageKey:     params.ImageKey,
		audioURL:     params.AudioURL,
		audioKey:     params.AudioKey,

		metricsLock: sync.Mutex{},
		metrics: ai.ModelMetrics{
			InputTokens:  0,
			OutputTokens: 0,
			TotalTokens:  0,
			DurationMs:   0,
		},

		ChatClient:      chatClient,
		EmbeddingClient: embedClient,
		ImageClient:     imageClient,
		AudioClient:     audioClient,
	}
}

func newOpenaiClient(
	baseURL string,
	apiKey string,
) *openai.Client {
	if apiKey == "" {
		return nil
	}
	options := []option.RequestOption{
		option.WithAPIKey(apiKey),
	}

	if baseURL != "" {
		options = append(options, option.WithBaseURL(baseURL))
	}

	client := openai.NewClient(options...)

	return &client
}

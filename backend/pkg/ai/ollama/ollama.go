package ollama

import (
	"net/http"
	"net/url"
	"sync"

	"github.com/OFFIS-RIT/kiwi/backend/pkg/ai"

	"github.com/ollama/ollama/api"
	"golang.org/x/sync/semaphore"
)

// GraphOllamaClient implements the ai.GraphAIClient interface using Ollama as the backend.
// It supports text generation, embeddings, and image description via locally-hosted models.
type GraphOllamaClient struct {
	embeddingModel   string
	descriptionModel string
	extractionModel  string
	imageModel       string

	reqLock *semaphore.Weighted

	metricsLock sync.Mutex
	metrics     ai.ModelMetrics

	baseURL    *url.URL
	apiKey     string
	httpClient *http.Client

	Client *api.Client
}

// NewGraphOllamaClientParams contains configuration options for creating a new GraphOllamaClient.
type NewGraphOllamaClientParams struct {
	EmbeddingModel   string
	DescriptionModel string
	ExtractionModel  string
	ImageModel       string

	BaseURL string
	ApiKey  string

	MaxConcurrentRequests int64
}

type headerTransport struct {
	headers map[string]string
	rt      http.RoundTripper
}

func (t *headerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// clone so original request isn't modified
	r := req.Clone(req.Context())
	for k, v := range t.headers {
		// don't overwrite if already set
		if r.Header.Get(k) == "" {
			r.Header.Set(k, v)
		}
	}
	return t.rt.RoundTrip(r)
}

// NewGraphOllamaClient creates a new Ollama-based AI client with the specified configuration.
// It connects to the Ollama server at the given BaseURL (or the default if empty)
// and uses the configured models for different AI operations.
func NewGraphOllamaClient(
	params NewGraphOllamaClientParams,
) (*GraphOllamaClient, error) {
	var (
		u   *url.URL
		err error
	)

	if params.BaseURL != "" {
		u, err = url.Parse(params.BaseURL)
		if err != nil {
			return nil, err
		}
	}

	httpClient := &http.Client{
		Transport: &headerTransport{
			headers: map[string]string{
				"Authorization": "Bearer " + params.ApiKey,
			},
			rt: http.DefaultTransport,
		},
	}

	cli := api.NewClient(u, httpClient)

	sem := semaphore.NewWeighted(params.MaxConcurrentRequests)

	return &GraphOllamaClient{
		embeddingModel:   params.EmbeddingModel,
		descriptionModel: params.DescriptionModel,
		extractionModel:  params.ExtractionModel,
		imageModel:       params.ImageModel,

		reqLock: sem,

		metricsLock: sync.Mutex{},
		metrics: ai.ModelMetrics{
			InputTokens:  0,
			OutputTokens: 0,
			TotalTokens:  0,
			DurationMs:   0,
		},

		baseURL:    u,
		apiKey:     params.ApiKey,
		httpClient: httpClient,

		Client: cli,
	}, nil
}

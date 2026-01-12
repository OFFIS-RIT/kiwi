package graph

// GraphClient is the main client for interacting with the graph RAG system.
// It manages token encoding, file processing parallelism, and concurrent
// AI requests.
//
// A GraphClient should be created using NewGraphClient.
type GraphClient struct {
	tokenEncoder       string
	parallelFiles      int
	parallelAiRequests int
	maxRetries         int
}

// NewGraphClientParams defines the configuration parameters for creating
// a new GraphClient.
//
// TokenEncoder specifies the encoding strategy for tokens.
// ParallelFiles controls how many files can be processed in parallel.
// ParallelAiRequests controls how many AI requests can be executed concurrently.
type NewGraphClientParams struct {
	TokenEncoder       string
	ParallelFiles      int
	ParallelAiRequests int
	MaxRetries         int
}

// NewGraphClient creates and returns a new GraphClient configured with
// the provided parameters.
//
// Example:
//
//	params := graph.NewGraphClientParams{
//		TokenEncoder:       "o200k_base",
//		ParallelFiles:      2,
//		ParallelAiRequests: 25,
//	}
//	client, err := graph.NewGraphClient(params)
//	if err != nil {
//		log.Fatal(err)
//	}
//
// Returns a pointer to GraphClient and an error if initialization fails.
func NewGraphClient(params NewGraphClientParams) (*GraphClient, error) {
	maxRetires := params.MaxRetries
	if maxRetires <= 0 {
		maxRetires = 3
	}
	g := &GraphClient{
		tokenEncoder:       params.TokenEncoder,
		parallelFiles:      params.ParallelFiles,
		parallelAiRequests: params.ParallelAiRequests,
		maxRetries:         maxRetires,
	}

	return g, nil
}

package ollama

import (
	"math"

	"kiwi/pkg/ai"
)

// ResetMetrics clears all accumulated token and timing metrics to zero.
func (c *GraphOllamaClient) ResetMetrics() {
	c.metricsLock.Lock()
	c.metrics = ai.ModelMetrics{
		InputTokens:  0,
		OutputTokens: 0,
		TotalTokens:  0,
		DurationMs:   0,
	}
	c.metricsLock.Unlock()
}

// GetMetrics returns the accumulated token usage and timing metrics since the last reset.
func (c *GraphOllamaClient) GetMetrics() ai.ModelMetrics {
	return c.metrics
}

func (c *GraphOllamaClient) modifyMetrics(m ai.ModelMetrics) {
	c.metricsLock.Lock()
	defer c.metricsLock.Unlock()

	c.metrics.InputTokens += m.InputTokens
	c.metrics.OutputTokens += m.OutputTokens
	c.metrics.TotalTokens += m.TotalTokens
	c.metrics.DurationMs += m.DurationMs

	if c.metrics.DurationMs > 0 {
		tokensPerSecond := (float64(c.metrics.TotalTokens) * 1000.0) / float64(c.metrics.DurationMs)
		c.metrics.TokenPerSecond = float32(math.Round(tokensPerSecond*100) / 100)
	}
}

package ids

import (
	"sync"
	"testing"

	"github.com/oklog/ulid/v2"
)

func TestNewReturnsValidULID(t *testing.T) {
	t.Parallel()

	id := New()
	if _, err := ulid.ParseStrict(id); err != nil {
		t.Fatalf("expected valid ULID, got %q: %v", id, err)
	}
}

func TestNewAtIsMonotonicWithinSameMillisecond(t *testing.T) {
	prev := New()
	for i := 0; i < 128; i++ {
		next := New()
		if next <= prev {
			t.Fatalf("expected monotonic ULIDs, prev=%q next=%q", prev, next)
		}
		prev = next
	}
}

func TestNewIsUniqueAcrossConcurrentCalls(t *testing.T) {
	t.Parallel()

	const count = 512
	results := make(chan string, count)

	var wg sync.WaitGroup
	wg.Add(count)
	for i := 0; i < count; i++ {
		go func() {
			defer wg.Done()
			results <- New()
		}()
	}

	wg.Wait()
	close(results)

	seen := make(map[string]struct{}, count)
	for id := range results {
		if _, exists := seen[id]; exists {
			t.Fatalf("duplicate ULID generated: %q", id)
		}
		seen[id] = struct{}{}
	}
}

package pgx

import (
	"fmt"
	"sort"
	"strings"

	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
)

const rrfK = 60.0

type hybridDiscoveryCandidate struct {
	Index            int
	ID               int64
	SemanticDistance float64
	KeywordRank      float64
	KeywordMatches   int32
	KeywordTotal     int32
}

func parseKeywordsParam(params map[string]any) ([]string, error) {
	raw, exists := params["keywords"]
	if !exists || raw == nil {
		return nil, nil
	}

	keywords := make([]string, 0)
	seen := make(map[string]struct{})

	appendKeyword := func(keyword string) {
		keyword = strings.TrimSpace(keyword)
		if keyword == "" {
			return
		}
		normalized := strings.ToLower(keyword)
		if _, exists := seen[normalized]; exists {
			return
		}
		seen[normalized] = struct{}{}
		keywords = append(keywords, keyword)
	}

	switch entries := raw.(type) {
	case []any:
		for i, entry := range entries {
			keyword, ok := entry.(string)
			if !ok {
				return nil, fmt.Errorf("keywords[%d] must be a string", i)
			}
			appendKeyword(keyword)
		}
	case []string:
		for _, keyword := range entries {
			appendKeyword(keyword)
		}
	default:
		return nil, fmt.Errorf("keywords must be an array of strings when provided")
	}

	return keywords, nil
}

func candidateLimit(limit int32) int32 {
	if limit <= 0 {
		limit = 10
	}

	candidateLimit := min(max(limit*6, 40), 240)

	return candidateLimit
}

func keywordCoverage(matches, total int32) float64 {
	if total <= 0 {
		return 0
	}
	coverage := float64(matches) / float64(total)
	if coverage < 0 {
		return 0
	}
	if coverage > 1 {
		return 1
	}
	return coverage
}

func buildRankPositions(
	candidates []hybridDiscoveryCandidate,
	less func(a, b hybridDiscoveryCandidate) bool,
) map[int]int {
	order := make([]int, len(candidates))
	for i := range candidates {
		order[i] = i
	}

	sort.SliceStable(order, func(i, j int) bool {
		return less(candidates[order[i]], candidates[order[j]])
	})

	positions := make(map[int]int, len(candidates))
	for rank, index := range order {
		positions[index] = rank + 1
	}

	return positions
}

func rrfComponent(rank int, weight float64) float64 {
	if rank <= 0 {
		return 0
	}
	return weight / (rrfK + float64(rank))
}

func selectRerankedCandidateIndexes(candidates []hybridDiscoveryCandidate, limit int32) []int {
	if len(candidates) == 0 || limit <= 0 {
		return nil
	}

	semanticRanks := buildRankPositions(candidates, func(a, b hybridDiscoveryCandidate) bool {
		if a.SemanticDistance == b.SemanticDistance {
			return a.ID < b.ID
		}
		return a.SemanticDistance < b.SemanticDistance
	})

	hasKeywords := false
	for _, candidate := range candidates {
		if candidate.KeywordTotal > 0 {
			hasKeywords = true
			break
		}
	}

	keywordRanks := map[int]int{}
	coverageRanks := map[int]int{}
	if hasKeywords {
		keywordRanks = buildRankPositions(candidates, func(a, b hybridDiscoveryCandidate) bool {
			if a.KeywordRank == b.KeywordRank {
				if a.KeywordMatches == b.KeywordMatches {
					if a.SemanticDistance == b.SemanticDistance {
						return a.ID < b.ID
					}
					return a.SemanticDistance < b.SemanticDistance
				}
				return a.KeywordMatches > b.KeywordMatches
			}
			return a.KeywordRank > b.KeywordRank
		})

		coverageRanks = buildRankPositions(candidates, func(a, b hybridDiscoveryCandidate) bool {
			coverageA := keywordCoverage(a.KeywordMatches, a.KeywordTotal)
			coverageB := keywordCoverage(b.KeywordMatches, b.KeywordTotal)
			if coverageA == coverageB {
				if a.KeywordMatches == b.KeywordMatches {
					if a.SemanticDistance == b.SemanticDistance {
						return a.ID < b.ID
					}
					return a.SemanticDistance < b.SemanticDistance
				}
				return a.KeywordMatches > b.KeywordMatches
			}
			return coverageA > coverageB
		})
	}

	type scoredCandidate struct {
		Candidate hybridDiscoveryCandidate
		Score     float64
	}

	scored := make([]scoredCandidate, len(candidates))
	for i, candidate := range candidates {
		score := rrfComponent(semanticRanks[candidate.Index], 1.0)
		if hasKeywords {
			score += rrfComponent(keywordRanks[candidate.Index], 1.0)
			score += rrfComponent(coverageRanks[candidate.Index], 1.0)
		}

		scored[i] = scoredCandidate{Candidate: candidate, Score: score}
	}

	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].Score == scored[j].Score {
			if scored[i].Candidate.SemanticDistance == scored[j].Candidate.SemanticDistance {
				if scored[i].Candidate.KeywordMatches == scored[j].Candidate.KeywordMatches {
					return scored[i].Candidate.ID < scored[j].Candidate.ID
				}
				return scored[i].Candidate.KeywordMatches > scored[j].Candidate.KeywordMatches
			}
			return scored[i].Candidate.SemanticDistance < scored[j].Candidate.SemanticDistance
		}
		return scored[i].Score > scored[j].Score
	})

	if limit > int32(len(scored)) {
		limit = int32(len(scored))
	}

	selected := make([]int, 0, limit)
	for i := int32(0); i < limit; i++ {
		selected = append(selected, scored[i].Candidate.Index)
	}

	return selected
}

func rerankEntityResults(rows []pgdb.SearchEntitiesByEmbeddingWithKeywordsRow, limit int32) []pgdb.SearchEntitiesByEmbeddingWithKeywordsRow {
	candidates := make([]hybridDiscoveryCandidate, len(rows))
	for i, row := range rows {
		candidates[i] = hybridDiscoveryCandidate{
			Index:            i,
			ID:               row.ID,
			SemanticDistance: row.SemanticDistance,
			KeywordRank:      row.KeywordRank,
			KeywordMatches:   row.KeywordMatches,
			KeywordTotal:     row.KeywordTotal,
		}
	}

	indexes := selectRerankedCandidateIndexes(candidates, limit)
	ranked := make([]pgdb.SearchEntitiesByEmbeddingWithKeywordsRow, 0, len(indexes))
	for _, index := range indexes {
		ranked = append(ranked, rows[index])
	}

	return ranked
}

func rerankEntityTypeResults(rows []pgdb.SearchEntitiesByTypeWithKeywordsRow, limit int32) []pgdb.SearchEntitiesByTypeWithKeywordsRow {
	candidates := make([]hybridDiscoveryCandidate, len(rows))
	for i, row := range rows {
		candidates[i] = hybridDiscoveryCandidate{
			Index:            i,
			ID:               row.ID,
			SemanticDistance: row.SemanticDistance,
			KeywordRank:      row.KeywordRank,
			KeywordMatches:   row.KeywordMatches,
			KeywordTotal:     row.KeywordTotal,
		}
	}

	indexes := selectRerankedCandidateIndexes(candidates, limit)
	ranked := make([]pgdb.SearchEntitiesByTypeWithKeywordsRow, 0, len(indexes))
	for _, index := range indexes {
		ranked = append(ranked, rows[index])
	}

	return ranked
}

func rerankRelationshipResults(rows []pgdb.SearchRelationshipsByEmbeddingWithKeywordsRow, limit int32) []pgdb.SearchRelationshipsByEmbeddingWithKeywordsRow {
	candidates := make([]hybridDiscoveryCandidate, len(rows))
	for i, row := range rows {
		candidates[i] = hybridDiscoveryCandidate{
			Index:            i,
			ID:               row.ID,
			SemanticDistance: row.SemanticDistance,
			KeywordRank:      row.KeywordRank,
			KeywordMatches:   row.KeywordMatches,
			KeywordTotal:     row.KeywordTotal,
		}
	}

	indexes := selectRerankedCandidateIndexes(candidates, limit)
	ranked := make([]pgdb.SearchRelationshipsByEmbeddingWithKeywordsRow, 0, len(indexes))
	for _, index := range indexes {
		ranked = append(ranked, rows[index])
	}

	return ranked
}

func rerankNeighbourResults(rows []pgdb.GetEntityNeighboursRankedWithKeywordsRow, limit int32) []pgdb.GetEntityNeighboursRankedWithKeywordsRow {
	candidates := make([]hybridDiscoveryCandidate, len(rows))
	for i, row := range rows {
		candidates[i] = hybridDiscoveryCandidate{
			Index:            i,
			ID:               row.RelationshipID,
			SemanticDistance: row.SemanticDistance,
			KeywordRank:      row.KeywordRank,
			KeywordMatches:   row.KeywordMatches,
			KeywordTotal:     row.KeywordTotal,
		}
	}

	indexes := selectRerankedCandidateIndexes(candidates, limit)
	ranked := make([]pgdb.GetEntityNeighboursRankedWithKeywordsRow, 0, len(indexes))
	for _, index := range indexes {
		ranked = append(ranked, rows[index])
	}

	return ranked
}

func rerankEntitySourceResults(rows []pgdb.FindRelevantSourcesForEntitiesWithKeywordsRow, limit int32) []pgdb.FindRelevantSourcesForEntitiesWithKeywordsRow {
	candidates := make([]hybridDiscoveryCandidate, len(rows))
	for i, row := range rows {
		candidates[i] = hybridDiscoveryCandidate{
			Index:            i,
			ID:               row.ID,
			SemanticDistance: row.SemanticDistance,
			KeywordRank:      row.KeywordRank,
			KeywordMatches:   row.KeywordMatches,
			KeywordTotal:     row.KeywordTotal,
		}
	}

	indexes := selectRerankedCandidateIndexes(candidates, limit)
	ranked := make([]pgdb.FindRelevantSourcesForEntitiesWithKeywordsRow, 0, len(indexes))
	for _, index := range indexes {
		ranked = append(ranked, rows[index])
	}

	return ranked
}

func rerankRelationshipSourceResults(rows []pgdb.FindRelevantSourcesForRelationsWithKeywordsRow, limit int32) []pgdb.FindRelevantSourcesForRelationsWithKeywordsRow {
	candidates := make([]hybridDiscoveryCandidate, len(rows))
	for i, row := range rows {
		candidates[i] = hybridDiscoveryCandidate{
			Index:            i,
			ID:               row.ID,
			SemanticDistance: row.SemanticDistance,
			KeywordRank:      row.KeywordRank,
			KeywordMatches:   row.KeywordMatches,
			KeywordTotal:     row.KeywordTotal,
		}
	}

	indexes := selectRerankedCandidateIndexes(candidates, limit)
	ranked := make([]pgdb.FindRelevantSourcesForRelationsWithKeywordsRow, 0, len(indexes))
	for _, index := range indexes {
		ranked = append(ranked, rows[index])
	}

	return ranked
}

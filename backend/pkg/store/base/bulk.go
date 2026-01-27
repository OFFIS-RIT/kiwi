package base

func chunkRange(total, chunkSize int, fn func(start, end int) error) error {
	if total <= 0 {
		return nil
	}
	if chunkSize <= 0 {
		chunkSize = total
	}
	for start := 0; start < total; start += chunkSize {
		end := min(start + chunkSize, total)
		if err := fn(start, end); err != nil {
			return err
		}
	}
	return nil
}

func dedupeStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

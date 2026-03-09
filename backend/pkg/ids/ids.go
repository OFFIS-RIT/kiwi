package ids

import (
	crand "crypto/rand"
	"time"

	"github.com/oklog/ulid/v2"
)

var entropy = &ulid.LockedMonotonicReader{
	MonotonicReader: ulid.Monotonic(crand.Reader, 0),
}

func New() string {
	return ulid.MustNew(ulid.Timestamp(time.Now().UTC()), entropy).String()
}

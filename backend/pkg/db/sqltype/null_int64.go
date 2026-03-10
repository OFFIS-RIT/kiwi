package sqltype

import (
	"database/sql"
	"database/sql/driver"
	"encoding/json"
)

type NullInt64 struct {
	Int64 int64
	Valid bool
}

func (n *NullInt64) Scan(value any) error {
	var nullable sql.NullInt64
	if err := nullable.Scan(value); err != nil {
		return err
	}

	n.Int64 = nullable.Int64
	n.Valid = nullable.Valid
	return nil
}

func (n NullInt64) Value() (driver.Value, error) {
	if !n.Valid {
		return nil, nil
	}

	return n.Int64, nil
}

func (n NullInt64) MarshalJSON() ([]byte, error) {
	if !n.Valid {
		return []byte("null"), nil
	}

	return json.Marshal(n.Int64)
}

func (n *NullInt64) UnmarshalJSON(data []byte) error {
	var value *int64
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}

	if value == nil {
		n.Int64 = 0
		n.Valid = false
		return nil
	}

	n.Int64 = *value
	n.Valid = true
	return nil
}

package middleware

import (
	"testing"
)

func TestHasPermission(t *testing.T) {
	user := &AppUser{
		UserID:      "1",
		Role:        "manager",
		Permissions: []string{"project.create", "project.update", "group.view"},
	}

	tests := []struct {
		name       string
		user       *AppUser
		permission string
		want       bool
	}{
		{"has permission", user, "project.create", true},
		{"missing permission", user, "group.create", false},
		{"nil user", nil, "project.create", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := HasPermission(tt.user, tt.permission); got != tt.want {
				t.Errorf("HasPermission() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHasAnyPermission(t *testing.T) {
	user := &AppUser{
		UserID:      "1",
		Role:        "user",
		Permissions: []string{"group.view"},
	}

	tests := []struct {
		name        string
		user        *AppUser
		permissions []string
		want        bool
	}{
		{"has one", user, []string{"group.view", "group.create"}, true},
		{"has none", user, []string{"group.create", "group.delete"}, false},
		{"nil user", nil, []string{"group.view"}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := HasAnyPermission(tt.user, tt.permissions...); got != tt.want {
				t.Errorf("HasAnyPermission() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestIsAdmin(t *testing.T) {
	tests := []struct {
		name string
		user *AppUser
		want bool
	}{
		{"admin", &AppUser{Role: "admin"}, true},
		{"manager", &AppUser{Role: "manager"}, false},
		{"user", &AppUser{Role: "user"}, false},
		{"nil", nil, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsAdmin(tt.user); got != tt.want {
				t.Errorf("IsAdmin() = %v, want %v", got, tt.want)
			}
		})
	}
}

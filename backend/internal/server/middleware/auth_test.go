package middleware

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	keyfunc "github.com/MicahParks/keyfunc/v3"
	"github.com/labstack/echo/v4"
)

var testECKey *ecdsa.PrivateKey

func init() {
	var err error
	testECKey, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic("failed to generate test ECDSA key: " + err.Error())
	}
}

// padCoordinate pads an ECDSA coordinate to 32 bytes (P-256).
func padCoordinate(b *big.Int) []byte {
	bytes := b.Bytes()
	if len(bytes) < 32 {
		padded := make([]byte, 32)
		copy(padded[32-len(bytes):], bytes)
		return padded
	}
	return bytes
}

// newTestKeyfunc creates a keyfunc.Keyfunc backed by our test ECDSA key.
func newTestKeyfunc(t *testing.T) keyfunc.Keyfunc {
	t.Helper()
	pubKey := testECKey.PublicKey
	jwkSet := map[string]any{
		"keys": []any{
			map[string]any{
				"kty": "EC",
				"crv": "P-256",
				"x":   base64.RawURLEncoding.EncodeToString(padCoordinate(pubKey.X)),
				"y":   base64.RawURLEncoding.EncodeToString(padCoordinate(pubKey.Y)),
				"alg": "ES256",
				"use": "sig",
				"kid": "test-key",
			},
		},
	}
	raw, _ := json.Marshal(jwkSet)
	kf, err := keyfunc.NewJWKSetJSON(raw)
	if err != nil {
		t.Fatalf("failed to create keyfunc: %v", err)
	}
	return kf
}

func createTestJWT(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = "test-key"
	signed, err := token.SignedString(testECKey)
	if err != nil {
		t.Fatalf("failed to sign token: %v", err)
	}
	return signed
}

func TestAuthMiddleware_MissingHeader(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	kf := newTestKeyfunc(t)
	app := &App{Key: &kf}
	ctx := &AppContext{Context: c, App: app}

	handler := AuthMiddleware(func(c echo.Context) error {
		return c.NoContent(http.StatusOK)
	})

	err := handler(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddleware_MasterAPIKey(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer master-key-123")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	kf := newTestKeyfunc(t)
	app := &App{
		Key:            &kf,
		MasterAPIKey:   "master-key-123",
		MasterUserID:   "master-1",
		MasterUserRole: "admin",
	}
	ctx := &AppContext{Context: c, App: app}

	var capturedUser *AppUser
	handler := AuthMiddleware(func(c echo.Context) error {
		capturedUser = c.(*AppContext).User
		return c.NoContent(http.StatusOK)
	})

	err := handler(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if capturedUser == nil {
		t.Fatal("user should not be nil")
	}
	if capturedUser.UserID != "master-1" {
		t.Errorf("expected user ID 'master-1', got '%s'", capturedUser.UserID)
	}
	if capturedUser.Role != "admin" {
		t.Errorf("expected role 'admin', got '%s'", capturedUser.Role)
	}
	if len(capturedUser.Permissions) != len(allPermissions) {
		t.Errorf("expected %d permissions, got %d", len(allPermissions), len(capturedUser.Permissions))
	}
}

func TestAuthMiddleware_ValidJWT(t *testing.T) {
	claims := jwt.MapClaims{
		"id":          "user-42",
		"role":        "manager",
		"permissions": []any{"project.create", "group.view"},
		"exp":         time.Now().Add(time.Hour).Unix(),
	}
	tokenStr := createTestJWT(t, claims)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	kf := newTestKeyfunc(t)
	app := &App{Key: &kf}
	ctx := &AppContext{Context: c, App: app}

	var capturedUser *AppUser
	handler := AuthMiddleware(func(c echo.Context) error {
		capturedUser = c.(*AppContext).User
		return c.NoContent(http.StatusOK)
	})

	err := handler(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if capturedUser == nil {
		t.Fatalf("expected capturedUser to be set")
	}
	if capturedUser.UserID != "user-42" {
		t.Errorf("expected user ID 'user-42', got '%s'", capturedUser.UserID)
	}
	if capturedUser.Role != "manager" {
		t.Errorf("expected role 'manager', got '%s'", capturedUser.Role)
	}
	if len(capturedUser.Permissions) != 2 {
		t.Errorf("expected 2 permissions, got %d", len(capturedUser.Permissions))
	}
}

func TestAuthMiddleware_ExpiredJWT(t *testing.T) {
	claims := jwt.MapClaims{
		"id":   "user-1",
		"role": "user",
		"exp":  time.Now().Add(-time.Hour).Unix(),
	}
	tokenStr := createTestJWT(t, claims)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	kf := newTestKeyfunc(t)
	app := &App{Key: &kf}
	ctx := &AppContext{Context: c, App: app}

	handler := AuthMiddleware(func(c echo.Context) error {
		return c.NoContent(http.StatusOK)
	})

	handler(ctx)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for expired token, got %d", rec.Code)
	}
}

func TestAuthMiddleware_AdminGetsAllPermissions(t *testing.T) {
	claims := jwt.MapClaims{
		"id":   "admin-1",
		"role": "admin",
		"exp":  time.Now().Add(time.Hour).Unix(),
	}
	tokenStr := createTestJWT(t, claims)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	kf := newTestKeyfunc(t)
	app := &App{Key: &kf}
	ctx := &AppContext{Context: c, App: app}

	var capturedUser *AppUser
	handler := AuthMiddleware(func(c echo.Context) error {
		capturedUser = c.(*AppContext).User
		return c.NoContent(http.StatusOK)
	})

	if err := handler(ctx); err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if capturedUser == nil {
		t.Fatalf("expected capturedUser, got nil")
	}
	if len(capturedUser.Permissions) != len(allPermissions) {
		t.Errorf("admin without permissions claim should get all permissions, got %d", len(capturedUser.Permissions))
	}
}

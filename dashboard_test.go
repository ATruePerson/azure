package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDashboardMutationRequiresSameOriginCSRF(t *testing.T) {
	s := testServer(&Config{})
	clear := func(origin, csrf, cookie string) int {
		req := httptest.NewRequest("POST", "/dashboard/api/clear", nil)
		req.Host = "127.0.0.1:8787"
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if csrf != "" {
			req.Header.Set("X-ACC-CSRF", csrf)
		}
		if cookie != "" {
			req.Header.Set("Cookie", "acc_dashboard_csrf="+cookie)
		}
		w := httptest.NewRecorder()
		s.handleDashboardClear(w, req)
		return w.Code
	}

	if got := clear("http://127.0.0.1:8787", "", ""); got != 403 {
		t.Fatalf("missing CSRF status = %d, want 403", got)
	}
	if got := clear("http://evil.example", "test-csrf", "test-csrf"); got != 403 {
		t.Fatalf("cross-origin status = %d, want 403", got)
	}
	if got := clear("http://127.0.0.1:8787", "test-csrf", "test-csrf"); got != 200 {
		t.Fatalf("valid CSRF status = %d, want 200", got)
	}
}

func TestDashboardUISetsCSRFAndRejectsCrossOriginPreflight(t *testing.T) {
	s := testServer(&Config{})
	req := httptest.NewRequest("GET", "/dashboard/", nil)
	req.Host = "127.0.0.1:8787"
	w := httptest.NewRecorder()
	s.handleDashboardUI(w, req)
	if !strings.Contains(w.Header().Get("Set-Cookie"), "acc_dashboard_csrf=test-csrf") {
		t.Fatalf("missing dashboard CSRF cookie: %q", w.Header().Get("Set-Cookie"))
	}

	preflight := httptest.NewRequest("OPTIONS", "/v1/models", nil)
	preflight.Host = "127.0.0.1:8787"
	preflight.Header.Set("Origin", "http://evil.example")
	preflightWriter := httptest.NewRecorder()
	corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})).ServeHTTP(preflightWriter, preflight)
	if preflightWriter.Code != 403 {
		t.Fatalf("cross-origin preflight status = %d, want 403", preflightWriter.Code)
	}
}

package main

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"time"
)

func (s *server) handleDashboardLogs(w http.ResponseWriter, r *http.Request) {
	tuiLogsMu.Lock()
	defer tuiLogsMu.Unlock()

	// Prepare JSON payload
	data := map[string]any{
		"uptime": time.Since(startTime).Round(time.Second).String(),
		"logs":   tuiLogs,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func (s *server) handleDashboardClear(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	if !s.validDashboardMutation(r) {
		http.Error(w, "dashboard mutation requires a same-origin CSRF token", http.StatusForbidden)
		return
	}
	tuiLogsMu.Lock()
	tuiLogs = nil
	tuiLogsMu.Unlock()
	w.WriteHeader(200)
}

func (s *server) handleDashboardRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", 405)
		return
	}
	if !s.validDashboardMutation(r) {
		http.Error(w, "dashboard mutation requires a same-origin CSRF token", http.StatusForbidden)
		return
	}
	w.WriteHeader(200)
	go func() {
		time.Sleep(500 * time.Millisecond)
		exec.Command("acc-restart").Run()
	}()
}

func (s *server) validDashboardMutation(r *http.Request) bool {
	if s.dashboardCSRF == "" || r.Header.Get("X-ACC-CSRF") != s.dashboardCSRF {
		return false
	}
	cookie, err := r.Cookie("acc_dashboard_csrf")
	if err != nil || cookie.Value != s.dashboardCSRF {
		return false
	}
	return sameOrigin(r.Header.Get("Origin"), r.Host)
}

func (s *server) handleDashboardInfo(w http.ResponseWriter, r *http.Request) {
	s.reloadIfChanged()
	cfg := s.cfg.Load()

	providers := []string{}
	for p := range cfg.Providers {
		providers = append(providers, p)
	}

	aliases := []string{}
	for k := range cfg.Aliases {
		aliases = append(aliases, k)
	}

	routes := []string{}
	for k := range cfg.Routes {
		routes = append(routes, k)
	}

	data := map[string]any{
		"providers": providers,
		"aliases":   aliases,
		"routes":    routes,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

// Dashboard UI static assets live under web/dashboard/ (see web_static.go).

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// This is the local contract harness for the Codex Responses boundary. It
// exercises the real handler, route resolution, provider request construction,
// and response translation without requiring a live provider key.
func TestResponsesGatewayRoutesExactProviderModelThroughFakeProvider(t *testing.T) {
	var upstreamModel string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("upstream path = %s, want /chat/completions", r.URL.Path)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		var request OpenAIRequest
		if err := json.Unmarshal(body, &request); err != nil {
			t.Fatal(err)
		}
		upstreamModel = request.Model
		response := OpenAIResponse{
			Choices: []OpenAIChoice{{Message: &OpenAIMessage{Role: "assistant", Content: json.RawMessage(`"exact route"`)}}},
			Usage:   &OpenAIUsage{PromptTokens: 2, CompletionTokens: 2},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer provider.Close()

	cfg := &Config{Providers: map[string]Provider{
		"fake": {BaseURL: provider.URL, APIKey: "test-key"},
	}}
	s := testServer(cfg)
	s.http = provider.Client()
	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(`{"model":"fake/test-model","input":"hello"}`))
	w := httptest.NewRecorder()
	s.handleResponses(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("gateway status = %d, body = %s", w.Code, w.Body.String())
	}
	if upstreamModel != "test-model" {
		t.Fatalf("upstream model = %q, want exact test-model", upstreamModel)
	}
	if !strings.Contains(w.Body.String(), "exact route") {
		t.Fatalf("translated response missing provider text: %s", w.Body.String())
	}
}

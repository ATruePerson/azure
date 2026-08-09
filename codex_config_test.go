package main

import (
	"strings"
	"testing"
)

func TestSanitizeCodexConfigStripsModelReasoningEffort(t *testing.T) {
	// Original config with duplicate model_reasoning_effort that caused TOML parse error
	original := `model_reasoning_effort = "medium"
service_tier = "default"
personality = "friendly"

# BEGIN AZURE CODEX OWNED
model = "nvidia/nvidia~snemotron-3-ultra-550b-a55b"
model_reasoning_effort = ""
model_provider = "azure"
model_catalog_json = "/Users/kabir/.codex/azure-models.json"
web_search = "disabled"
# END AZURE CODEX OWNED`

	sanitized := sanitizeCodexConfig(original, true)

	// Owned section and outside routing keys are stripped so restore/render can
	// rewrite a single clean Azure block.
	if strings.Contains(sanitized, "model_reasoning_effort") {
		t.Fatalf("Expected model_reasoning_effort to be stripped, got:\n%s", sanitized)
	}
	if strings.Contains(sanitized, azureCodexRootBegin) || strings.Contains(sanitized, `model_provider = "azure"`) {
		t.Fatalf("Azure-owned section should be stripped:\n%s", sanitized)
	}
	for _, want := range []string{`service_tier = "default"`, `personality = "friendly"`} {
		if !strings.Contains(sanitized, want) {
			t.Fatalf("unrelated setting lost (%s):\n%s", want, sanitized)
		}
	}
}

func TestRenderCodexAzureConfigWithEmptyEffortDoesNotProduceInvalidTOML(t *testing.T) {
	// Clean base config (no duplicates)
	base := `service_tier = "default"
personality = "friendly"`

	// Render with empty effort (this was causing "reasoning_effort must not be empty" error)
	rendered := renderCodexAzureConfig(base, "/Users/kabir/.codex/azure-models.json", "http://127.0.0.1:9999/v1", "nvidia/nvidia~snemotron-3-ultra-550b-a55b", "")

	// Should NOT contain model_reasoning_effort line at all when empty
	if strings.Contains(rendered, "model_reasoning_effort") {
		t.Errorf("Rendered config should not contain model_reasoning_effort when empty, got:\n%s", rendered)
	}
}

func TestRenderCodexAzureConfigWithNonEmptyEffortIncludesLine(t *testing.T) {
	base := `service_tier = "default"
personality = "friendly"`

	// Render with non-empty effort
	rendered := renderCodexAzureConfig(base, "/Users/kabir/.codex/azure-models.json", "http://127.0.0.1:9999/v1", "nvidia/nvidia~snemotron-3-ultra-550b-a55b", "medium")

	if !strings.Contains(rendered, "model_reasoning_effort = \"medium\"") {
		t.Errorf("Rendered config missing model_reasoning_effort line:\n%s", rendered)
	}
}

func TestGeneratedConfigIsAlwaysValidTOML(t *testing.T) {
	testCases := []struct {
		name     string
		effort   string
		hasAzure bool
		model    string
		catalog  string
		baseURL  string
	}{
		{
			name:     "empty effort with Azure",
			effort:   "",
			hasAzure: true,
			model:    "nvidia/nvidia~snemotron-3-ultra-550b-a55b",
			catalog:  "/Users/kabir/.codex/azure-models.json",
			baseURL:  "http://127.0.0.1:9999/v1",
		},
		{
			name:     "non-empty effort with Azure",
			effort:   "high",
			hasAzure: true,
			model:    "nvidia/nvidia~snemotron-3-ultra-550b-a55b",
			catalog:  "/Users/kabir/.codex/azure-models.json",
			baseURL:  "http://127.0.0.1:9999/v1",
		},
		{
			name:     "empty effort without Azure (subscription)",
			effort:   "",
			hasAzure: false,
			model:    "",
			catalog:  "",
			baseURL:  "",
		},
	}

	for _, tc := range testCases {
		base := `service_tier = "default"
personality = "friendly"`

		var rendered string
		if tc.hasAzure {
			rendered = renderCodexAzureConfig(base, tc.catalog, tc.baseURL, tc.model, tc.effort)
		} else {
			// For subscription mode, we'd use sanitizeCodexConfig directly
			rendered = sanitizeCodexConfig(base, true)
		}

		if err := validateCodexConfigText(rendered); err != nil {
			t.Errorf("%s: generated invalid TOML: %v\nConfig:\n%s", tc.name, err, rendered)
		}
	}
}

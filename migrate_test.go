package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRewriteMCPJSONBytesRenamesServers(t *testing.T) {
	input := []byte(`{
  "mcpServers": {
    "acc-websearch": {"type": "stdio", "command": "azure", "args": ["mcp", "serve", "websearch"]},
    "other": {"type": "stdio", "command": "x"}
  }
}`)
	out := rewriteMCPJSONBytes(input)
	text := string(out)
	if strings.Contains(text, `"acc-websearch"`) {
		t.Fatalf("legacy server key still present: %s", text)
	}
	if !strings.Contains(text, `"azure-websearch"`) {
		t.Fatalf("azure server key missing: %s", text)
	}
	if !strings.Contains(text, `"other"`) {
		t.Fatalf("unrelated server removed: %s", text)
	}
}

func TestMigrateCodexACCIdentifiers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	original := `# BEGIN ACC CODEX OWNED
model_provider = "acc"
model_catalog_json = "/tmp/acc-models.json"
# END ACC CODEX OWNED

# ACC CODEX OWNED PROVIDER
[model_providers.acc]
name = "ACC"
`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	migrateCodexACCIdentifiers(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{
		"# BEGIN AZURE CODEX OWNED",
		`model_provider = "azure"`,
		"azure-models.json",
		"# AZURE CODEX OWNED PROVIDER",
		"[model_providers.azure]",
		`name = "Azure"`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	for _, forbidden := range []string{"ACC CODEX", `model_provider = "acc"`, "[model_providers.acc]", `name = "ACC"`, "acc-models.json"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("still contains %q in:\n%s", forbidden, text)
		}
	}
}

func TestMigrateCodexCatalogName(t *testing.T) {
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "acc-models.json")
	newPath := filepath.Join(dir, "azure-models.json")
	if err := os.WriteFile(oldPath, []byte(`{"models":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	migrateCodexCatalogName(dir)
	data, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"models":[]}` {
		t.Fatalf("catalog contents = %q", data)
	}
}

func TestEnsureAzureConfigMigratedCopiesLegacyDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	// Reset sync.Once by using isolated paths through env — ensureAzureConfigMigrated
	// uses UserHomeDir which respects HOME on Unix.
	legacy := filepath.Join(home, ".config", "acc")
	modern := filepath.Join(home, ".config", "azure")
	if err := os.MkdirAll(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "config.json"), []byte(`{"port":9999}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "mcp.json"), []byte(`{"mcpServers":{"acc-websearch":{"type":"stdio"}}}`), 0600); err != nil {
		t.Fatal(err)
	}

	// Directly exercise copy+rewrite helpers used by migration (Once already
	// may have fired in other tests in this package).
	if err := copyDirAll(legacy, modern); err != nil {
		t.Fatal(err)
	}
	rewriteMCPServerNames(filepath.Join(modern, "mcp.json"))

	cfg, err := os.ReadFile(filepath.Join(modern, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg) != `{"port":9999}` {
		t.Fatalf("config = %q", cfg)
	}
	mcp, err := os.ReadFile(filepath.Join(modern, "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(mcp), "acc-websearch") || !strings.Contains(string(mcp), "azure-websearch") {
		t.Fatalf("mcp.json = %s", mcp)
	}
}

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var azureConfigMigrateOnce sync.Once

// ensureAzureConfigMigrated one-shot copies ~/.config/acc → ~/.config/azure when
// the Azure config dir is missing, then rewrites Codex/MCP ACC identifiers in
// place. Safe to call repeatedly; work runs at most once per process.
func ensureAzureConfigMigrated() {
	azureConfigMigrateOnce.Do(func() {
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		legacy := filepath.Join(home, ".config", "acc")
		modern := filepath.Join(home, ".config", "azure")
		if _, err := os.Stat(modern); err != nil {
			if _, err := os.Stat(legacy); err == nil {
				if copyErr := copyDirAll(legacy, modern); copyErr != nil {
					fmt.Fprintf(os.Stderr, "  azure: could not migrate %s → %s: %v\n", legacy, modern, copyErr)
					return
				}
				fmt.Fprintf(os.Stderr, "  azure: migrated config %s → %s\n", legacy, modern)
			}
		}
		rewriteMCPServerNames(filepath.Join(modern, "mcp.json"))
		if p := defaultClaude3PConfigPath(); p != "" {
			rewriteClaude3PMCPNames(p)
		}
		migrateCodexACCIdentifiers(filepath.Join(home, ".codex", "config.toml"))
		migrateCodexCatalogName(filepath.Join(home, ".codex"))
	})
}

func copyDirAll(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm()|0700)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		return copyFile(path, target, info.Mode().Perm())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

func rewriteMCPServerNames(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	updated := rewriteMCPJSONBytes(data)
	if string(updated) == string(data) {
		return
	}
	_ = os.WriteFile(path, updated, 0600)
}

func rewriteMCPJSONBytes(data []byte) []byte {
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return data
	}
	servers, ok := root["mcpServers"].(map[string]any)
	if !ok || servers == nil {
		return data
	}
	renames := map[string]string{
		"acc-websearch":   "azure-websearch",
		"acc-mac-control": "azure-mac-control",
		"acc-osascript":   "azure-osascript",
	}
	changed := false
	for old, neu := range renames {
		if val, exists := servers[old]; exists {
			if _, taken := servers[neu]; !taken {
				servers[neu] = val
			}
			delete(servers, old)
			changed = true
		}
	}
	if !changed {
		return data
	}
	root["mcpServers"] = servers
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return data
	}
	return append(out, '\n')
}

func rewriteClaude3PMCPNames(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	updated := rewriteMCPJSONBytes(data)
	if string(updated) == string(data) {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	_ = os.WriteFile(path, updated, info.Mode().Perm())
}

func migrateCodexACCIdentifiers(configPath string) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return
	}
	text := string(data)
	updated := text
	updated = strings.ReplaceAll(updated, "# BEGIN ACC CODEX OWNED", "# BEGIN AZURE CODEX OWNED")
	updated = strings.ReplaceAll(updated, "# END ACC CODEX OWNED", "# END AZURE CODEX OWNED")
	updated = strings.ReplaceAll(updated, "# ACC CODEX OWNED PROVIDER", "# AZURE CODEX OWNED PROVIDER")
	updated = strings.ReplaceAll(updated, "[model_providers.acc]", "[model_providers.azure]")
	updated = strings.ReplaceAll(updated, `model_provider = "acc"`, `model_provider = "azure"`)
	updated = strings.ReplaceAll(updated, `name = "ACC"`, `name = "Azure"`)
	updated = strings.ReplaceAll(updated, "acc-models.json", "azure-models.json")
	if updated == text {
		return
	}
	_ = os.WriteFile(configPath, []byte(updated), 0600)
}

func migrateCodexCatalogName(codexDir string) {
	oldPath := filepath.Join(codexDir, "acc-models.json")
	newPath := filepath.Join(codexDir, "azure-models.json")
	if _, err := os.Stat(newPath); err == nil {
		return
	}
	if _, err := os.Stat(oldPath); err != nil {
		return
	}
	_ = copyFile(oldPath, newPath, 0600)
}

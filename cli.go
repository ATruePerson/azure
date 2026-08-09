package main

import (
	"bufio"
	_ "embed"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"
)

// providerInfo describes a known upstream provider for the setup wizard,
// doctor health check, and default config generation.
type providerInfo struct {
	Key       string // config provider name, e.g. "nvidia"
	Label     string // human name, e.g. "NVIDIA NIM"
	EnvVar    string // dotenv variable, e.g. "NVIDIA_NIM_API_KEY"
	BaseURL   string
	SignupURL string
}

func knownProviders() []providerInfo {
	return []providerInfo{
		{"nvidia", "NVIDIA NIM (free tier, fast)", "NVIDIA_NIM_API_KEY", "https://integrate.api.nvidia.com/v1", "https://build.nvidia.com"},
		{"opencode", "OpenCode Zen (free models)", "OPENCODE_API_KEY", "https://opencode.ai/zen/v1", "https://opencode.ai"},
		{"openrouter", "OpenRouter (many models)", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1", "https://openrouter.ai/keys"},
		{"gemini", "Google Gemini", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai", "https://aistudio.google.com/apikey"},
		{"zai", "Z.AI (GLM models)", "ZAI_API_KEY", "https://api.z.ai/api/paas/v4", "https://z.ai"},
	}
}

// dispatch handles `azure <subcommand>`. Returns true if a subcommand ran, so
// main() can skip starting the server. Unknown first args fall through to the
// normal flag-based server path.
func dispatch(args []string) bool {
	if len(args) < 2 {
		return false
	}
	switch args[1] {
	case "setup", "init":
		cmdSetup()
	case "doctor", "check":
		cmdDoctor()
	case "models", "list":
		cmdModels()
	case "bench":
		cmdBench()
	case "claude", "run":
		cmdClaude(args[2:])
	case "codex":
		cmdCodex(args[2:])
	case "auth":
		cmdAuth(args[2:])
	case "mcp":
		cmdMCP(args[2:])
	case "help", "--help", "-h":
		printHelp()
	default:
		return false
	}
	return true
}

func printHelp() {
	fmt.Print(`azure — point Claude Code at cheaper models

Usage:
  azure                 Start the proxy (use -tui for the dashboard)
  azure setup           Interactive first-time setup (keys + config)
  azure doctor          Test that your provider keys work
  azure models          List the model names you can use
  azure bench           Benchmark every persona + fallback, judged for quality
  azure claude [args]   Start the proxy and launch Claude Code through it
	azure codex setup      Back up Codex and point it directly at Azure
	azure codex start      Start an owned Azure service and verify Responses
	azure codex stop       Stop only the Azure process started by this command
	azure codex status     Show direct config, catalog, process, and auth state
	azure codex doctor     Run deterministic integration checks
	azure codex restore    Restore the previous Codex settings
	azure codex remove     Remove only Azure-owned Codex settings
		azure codex [path]     Legacy direct Azure launcher
	  azure auth list       List native authentication methods
	  azure auth login      Log in to kimi, xai/grok, or anthropic
	  azure auth status     Show safe provider login status
	  azure auth logout     Remove only one provider's Azure credential
  azure mcp install     Install Azure's bundled local tools for Claude Code
                      (use --claude-3p --include-obsidian for Obsidian)
  azure mcp doctor      Check bundled local tools
  azure help            Show this help

First time? Run:  azure setup
`)
}

// ---------- paths ----------

func azureDir() string {
	ensureAzureConfigMigrated()
	home, err := os.UserHomeDir()
	if err != nil {
		return ".config/azure"
	}
	return filepath.Join(home, ".config", "azure")
}

func defaultEnvPath() string    { return filepath.Join(azureDir(), ".env") }
func defaultConfigPath() string { return filepath.Join(azureDir(), "config.json") }

// ---------- setup wizard ----------

func cmdSetup() {
	in := bufio.NewReader(os.Stdin)
	fmt.Print(`
  azure setup
  ─────────
  This sets up azure so Claude Code can use cheaper models.
  You'll paste API keys for any providers you have. Skip the rest.

`)

	keys := map[string]string{}
	for _, p := range knownProviders() {
		fmt.Printf("  %s\n    Get a key: %s\n    Paste key (or press Enter to skip): ", p.Label, p.SignupURL)
		line, _ := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" {
			keys[p.EnvVar] = line
		}
		fmt.Println()
	}

	if len(keys) == 0 {
		fmt.Println("  No keys entered — nothing to save. Run `azure setup` again when you have one.")
		return
	}

	dir := azureDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		fmt.Printf("  Could not create %s: %v\n", dir, err)
		return
	}

	envPath := defaultEnvPath()
	if err := os.WriteFile(envPath, []byte(renderEnv(keys)), 0600); err != nil {
		fmt.Printf("  Could not write %s: %v\n", envPath, err)
		return
	}
	fmt.Printf("  Saved %d key(s) to %s\n", len(keys), envPath)

	cfgPath := defaultConfigPath()
	if _, err := os.Stat(cfgPath); err == nil {
		fmt.Printf("  Config already exists at %s — keeping it.\n", cfgPath)
	} else {
		if err := os.WriteFile(cfgPath, []byte(defaultConfigJSON), 0644); err != nil {
			fmt.Printf("  Could not write %s: %v\n", cfgPath, err)
			return
		}
		fmt.Printf("  Wrote default config to %s\n", cfgPath)
	}

	fmt.Print("\n  Testing your keys...\n\n")
	loadDotenv(envPath)
	for _, p := range knownProviders() {
		if _, ok := keys[p.EnvVar]; !ok {
			continue
		}
		printPing(p, keys[p.EnvVar])
	}

	fmt.Print(`
  Done. Start using it with:

      azure claude

  That launches Claude Code through azure. Happy hacking.
`)
}

// renderEnv produces dotenv file contents for the given key/value pairs,
// sorted for stable output.
func renderEnv(keys map[string]string) string {
	var names []string
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString("# azure provider API keys — keep this file private\n")
	for _, n := range names {
		fmt.Fprintf(&b, "%s=%s\n", n, keys[n])
	}
	return b.String()
}

// ---------- doctor ----------

func cmdDoctor() {
	envPath := defaultEnvPath()
	loadDotenv(envPath)

	fmt.Printf("\n  azure doctor — checking provider keys (%s)\n\n", envPath)
	any := false
	for _, p := range knownProviders() {
		key := os.Getenv(p.EnvVar)
		if key == "" {
			fmt.Printf("  --  %s\n        no key set (%s)\n", p.Label, p.EnvVar)
			continue
		}
		any = true
		printPing(p, key)
	}
	if !any {
		fmt.Print("\n  No keys configured yet. Run `azure setup`.\n")
	}
	fmt.Println()
}

// printPing tests one provider and prints a friendly status line.
func printPing(p providerInfo, key string) {
	switch pingProvider(p.BaseURL, key) {
	case pingOK:
		fmt.Printf("  OK  %s — key works\n", p.Label)
	case pingBadKey:
		fmt.Printf("  XX  %s — key rejected (check the key)\n", p.Label)
	default:
		fmt.Printf("  ??  %s — could not reach provider\n", p.Label)
	}
}

type pingResult int

const (
	pingUnreachable pingResult = iota
	pingBadKey
	pingOK
)

// pingProvider does a cheap GET /models to verify a key without spending
// tokens. 200 means good, 401/403 means the key is bad, anything else (or a
// network error) means unreachable.
func pingProvider(baseURL, key string) pingResult {
	req, err := http.NewRequest("GET", strings.TrimRight(baseURL, "/")+"/models", nil)
	if err != nil {
		return pingUnreachable
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return pingUnreachable
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return pingBadKey
	case resp.StatusCode < 500:
		return pingOK
	default:
		return pingUnreachable
	}
}

// ---------- models ----------

func cmdModels() {
	cfgPath := defaultConfigPath()
	var cfg *Config
	if c, err := loadConfig(cfgPath); err == nil {
		cfg = c
	}

	fmt.Print("\n  Model names you can give Claude Code (set as the model):\n\n")
	for _, d := range modelCatalog() {
		fmt.Printf("  anthropic/%-26s → %s (%s)\n", d.Canonical, d.Route.Model, d.Route.Provider)
	}
	if cfg != nil && len(cfg.Aliases) > 0 {
		fmt.Print("\n  Your custom aliases (from config.json):\n\n")
		var names []string
		for k := range cfg.Aliases {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			r := cfg.Aliases[k]
			fmt.Printf("  anthropic/%-26s → %s (%s)\n", normalizeModelID(k), r.Model, r.Provider)
		}
	}
	if cfg != nil && len(cfg.Models) > 0 {
		fmt.Print("\n  Codex models (from config.json):\n\n")
		for _, model := range codexNamedModels(cfg) {
			fmt.Printf("  %-26s -> %s (%s)\n", model.ID, model.Route.Model, model.Route.Provider)
		}
	}
	fmt.Print("\n  Or use the family names (opus / sonnet / haiku) — those follow config.json routes.\n\n")
}

// ---------- claude launcher ----------

func cmdClaude(extra []string) {
	cfg, err := loadConfig(defaultConfigPath())
	if err != nil {
		fmt.Printf("  No config found. Run `azure setup` first. (%v)\n", err)
		return
	}
	loadDotenv(defaultEnvPath())

	base := fmt.Sprintf("http://localhost:%d", cfg.Port)
	if !proxyAlive(base) {
		fmt.Printf("  Starting azure on port %d...\n", cfg.Port)
		if err := startProxyDetached(); err != nil {
			fmt.Printf("  Could not start azure: %v\n", err)
			return
		}
		if !waitForProxy(base, 10*time.Second) {
			fmt.Println("  azure did not come up in time. Try `azure` in another terminal.")
			return
		}
	}

	claude, err := exec.LookPath("claude")
	if err != nil {
		fmt.Printf("  Claude Code not found on PATH. azure is running at %s —\n  set ANTHROPIC_BASE_URL=%s in your client.\n", base, base)
		return
	}

	fmt.Printf("  Launching Claude Code through azure (%s)...\n\n", base)
	self, err := os.Executable()
	if err != nil {
		fmt.Printf("  Could not locate azure for MCP tools: %v\n", err)
		return
	}
	mcpConfig, err := ensureMCPConfig(self)
	if err != nil {
		fmt.Printf("  Could not prepare Azure MCP tools: %v\n", err)
		return
	}
	cmd := exec.Command(claude, claudeArgsWithMCP(extra, mcpConfig)...)
	cmd.Env = append(os.Environ(), "ANTHROPIC_BASE_URL="+base)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Run()
}

const codexExperimentalNotice = "EXPERIMENTAL: Codex integration is a work in progress and can still break. Run `azure codex restore` to return to your normal subscription."

// Kept as a stable offline seed for callers that need a constant. Runtime
// commands choose the first available real model from the generated catalog.
const defaultCodexModel = "nvidia/z-ai/glm-5.2"

func cmdCodex(args []string) {
	if len(args) > 0 {
		switch args[0] {
		case "setup", "start", "stop", "status", "doctor", "restore", "remove":
			cmdCodexLifecycle(args)
			return
		}
	}
	for _, arg := range args {
		if arg == "--restore" {
			cmdCodexLifecycle([]string{"restore"})
			return
		}
	}
	cmdCodexLegacy(args)
}

func cmdCodexLegacy(args []string) {
	flags := flag.NewFlagSet("azure codex", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	model := ""
	restore := false
	flags.StringVar(&model, "model", "", "Azure model alias to use")
	flags.StringVar(&model, "m", "", "Azure model alias to use")
	flags.BoolVar(&restore, "restore", false, "restore the previous Codex subscription settings")
	if err := flags.Parse(args); err != nil {
		fmt.Println("  Usage: azure codex [--model MODEL] [path] | azure codex restore")
		return
	}
	if len(flags.Args()) > 1 {
		fmt.Println("  Usage: azure codex [--model MODEL] [path] | azure codex restore")
		return
	}
	var cfg *Config
	if !restore {
		var err error
		cfg, err = loadConfig(defaultConfigPath())
		if err != nil {
			fmt.Printf("  No config found. Run `azure setup` first. (%v)\n", err)
			return
		}
		if model == "" {
			model, err = defaultCodexModelFor(cfg, nil)
			if err != nil {
				fmt.Printf("  %v\n", err)
				return
			}
		}
		if !isCodexModel(cfg, model) {
			fmt.Printf("  Unknown or disabled Azure model %q. Run `azure models` to list enabled model IDs.\n", model)
			return
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Printf("  Could not find your home directory: %v\n", err)
		return
	}
	codexConfig := filepath.Join(home, ".codex", "config.toml")
	codexCatalog := filepath.Join(home, ".codex", "azure-models.json")
	restoreState := filepath.Join(azureDir(), "codex-restore.json")
	path := "."
	if len(flags.Args()) == 1 {
		path = flags.Args()[0]
	}
	if restore {
		if err := restoreCodexApp(codexConfig, codexCatalog, restoreState); err != nil {
			fmt.Printf("  Could not restore Codex settings: %v\n", err)
			return
		}
		fmt.Println("  Restored your Codex subscription settings. Reopening Codex...")
		launchCodexDesktop(path)
		return
	}

	fmt.Printf("\n  %s\n", codexExperimentalNotice)

	loadDotenv(defaultEnvPath())

	base := fmt.Sprintf("http://localhost:%d", cfg.Port)
	if !proxyAlive(base) {
		fmt.Printf("  Starting azure on port %d...\n", cfg.Port)
		if err := startProxyDetached(); err != nil {
			fmt.Printf("  Could not start azure: %v\n", err)
			return
		}
		if !waitForProxy(base, 10*time.Second) {
			fmt.Println("  azure did not come up in time. Try `azure` in another terminal.")
			return
		}
	}

	app, err := findCodexDesktopApp()
	if err != nil {
		fmt.Printf("  ChatGPT desktop app not found: %v\n", err)
		return
	}
	apiBase := strings.TrimRight(base, "/") + "/v1"
	if err := configureCodexApp(codexConfig, codexCatalog, restoreState, apiBase, model, cfg); err != nil {
		fmt.Printf("  Could not configure Codex Desktop: %v\n", err)
		return
	}

	fmt.Printf("  Codex is using Azure model %s. Reopening Codex...\n\n", model)
	launchCodexDesktopWith(app, path)
}

func launchCodexDesktop(path string) {
	app, err := findCodexDesktopApp()
	if err != nil {
		fmt.Printf("  ChatGPT desktop app not found: %v\n", err)
		return
	}
	launchCodexDesktopWith(app, path)
}

func findCodexDesktopApp() (string, error) {
	home, _ := os.UserHomeDir()
	return findCodexDesktopAppFor(runtime.GOOS, home)
}

func findCodexDesktopAppFor(goos, home string) (string, error) {
	if goos != "darwin" {
		return "", fmt.Errorf("direct desktop launch is currently supported on macOS")
	}

	for _, candidate := range []string{
		filepath.Join(home, "Applications", "ChatGPT.app"),
		"/Applications/ChatGPT.app",
	} {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("install ChatGPT.app in Applications")
}

func codexOpenArgs(app, path string) []string {
	return []string{"-a", app, path}
}

func launchCodexDesktopWith(app, path string) {
	// Codex reads provider settings when its app server starts, so a running app
	// must close before `codex app` reopens it.
	if runtime.GOOS == "darwin" {
		script := `tell application "System Events"
set codexRunning to exists process "Codex"
set chatGPTRunning to exists process "ChatGPT"
end tell
if codexRunning then tell application "Codex" to quit
if chatGPTRunning then tell application "ChatGPT" to quit`
		_ = exec.Command("osascript", "-e", script).Run()
		time.Sleep(750 * time.Millisecond)
	}
	cmd := exec.Command("open", codexOpenArgs(app, path)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Printf("  Could not launch Codex Desktop: %v\n", err)
	}
}

func proxyAlive(base string) bool {
	client := &http.Client{Timeout: 1 * time.Second}
	resp, err := client.Get(base + "/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

func waitForProxy(base string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if proxyAlive(base) {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

// startProxyDetached launches this same binary as a background proxy.
func startProxyDetached() error {
	_, _, err := startProxyDetachedWithPID()
	return err
}

func startProxyDetachedWithPID() (int, string, error) {
	self, err := os.Executable()
	if err != nil {
		return 0, "", err
	}
	if err := os.MkdirAll(azureDir(), 0700); err != nil {
		return 0, "", err
	}
	logFile, err := os.OpenFile(filepath.Join(azureDir(), "proxy.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return 0, "", err
	}
	defer logFile.Close()

	executable := proxyExecutable(self)
	cmd := detachedProxyCommand(executable, "-config", defaultConfigPath(), "-env", defaultEnvPath())
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		return 0, "", err
	}
	pid := cmd.Process.Pid
	if err := cmd.Process.Release(); err != nil {
		return 0, "", err
	}
	return pid, executable, nil
}

func detachedProxyCommand(proxy string, args ...string) *exec.Cmd {
	cmd := exec.Command("nohup", append([]string{proxy}, args...)...)
	cmd.Stdin = nil
	// `azure codex` exits as soon as it reopens Desktop. A new session plus nohup
	// keeps the proxy alive after the launching terminal command is gone.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd
}

func proxyExecutable(commandPath string) string {
	managed := filepath.Join(filepath.Dir(commandPath), "azure-proxy")
	if info, err := os.Stat(managed); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
		return managed
	}
	return commandPath
}

// defaultConfigJSON is the config written by `azure setup`. Keeping it embedded
// from config.json prevents setup and the live template from drifting apart.
//
//go:embed config.json
var defaultConfigJSON string

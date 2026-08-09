# Updating Azure

Run:

```bash
azure update
```

The command selects the latest release asset for the current macOS or Linux architecture, downloads the release archive and its published SHA-256 file, verifies the checksum, extracts only the expected Azure binary, validates that the new binary can run, and atomically replaces the installed executable.

By default, Azure updates the executable currently running when it is a normal `azure` binary. Otherwise it installs to `~/.local/bin/azure`, matching `scripts/install.sh`. Set `AZURE_BINDIR` to choose another writable installation directory:

```bash
AZURE_BINDIR="$HOME/bin" azure update
```

The updater changes only the Azure executable. It does not edit `~/.config/azure/config.json`, provider keys, Codex settings, subscription baselines, login files, or authentication state.

Azure release binaries are currently provided for:

- macOS arm64
- macOS amd64
- Linux arm64
- Linux amd64

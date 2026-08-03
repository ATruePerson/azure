declare const lucide: { createIcons: () => void };

interface LogEntry {
  Timestamp: string;
  Model: string;
  Route: string;
  Status: number;
  TokensIn: number;
  TokensOut: number;
}

interface LogsResponse {
  uptime: string;
  logs: LogEntry[];
}

let lastLogCount = -1;

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing dashboard element #${id}`);
  return node as T;
}

function csrfToken(): string {
  const cookie = document.cookie.split("; ").find((part) => part.startsWith("acc_dashboard_csrf="));
  return cookie?.slice("acc_dashboard_csrf=".length) ?? "";
}

async function dashboardRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") {
    headers.set("X-ACC-CSRF", csrfToken());
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw new Error(`Dashboard request failed: ${response.status}`);
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  if (!body.trim()) return undefined as T;
  return JSON.parse(body) as T;
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character);
}

function renderLogs(logs: LogEntry[]): void {
  const container = element<HTMLDivElement>("logsContainer");
  if (logs.length === 0) {
    container.innerHTML = '<div class="no-logs"><i data-lucide="inbox" size="32"></i><p>No transactions captured yet. Launch queries from your terminal or client!</p></div>';
    lucide.createIcons();
    return;
  }

  const rows = [...logs].reverse().map((log, index) => {
    const isNew = index === 0 && lastLogCount !== -1;
    const statusClass = log.Status >= 400 ? "err" : "ok";
    const statusText = log.Status >= 400 ? `${log.Status} ERR` : `${log.Status} OK`;
    const icon = log.Status >= 400 ? "alert-triangle" : "check-circle";
    const time = new Date(log.Timestamp).toTimeString().split(" ")[0];
    return `<tr ${isNew ? 'class="new-row"' : ""}>
      <td class="time-col">${time}</td>
      <td class="model-name">${escapeHTML(log.Model)}</td>
      <td class="route-target">${escapeHTML(log.Route)}</td>
      <td><span class="status-badge ${statusClass}"><i data-lucide="${icon}" size="12"></i>${statusText}</span></td>
      <td><span class="tokens-pill">${log.TokensIn}</span></td>
      <td><span class="tokens-pill">${log.TokensOut}</span></td>
    </tr>`;
  }).join("");

  container.innerHTML = `<table><thead><tr><th>Timestamp</th><th>Requested Model</th><th>Translated Route</th><th>Status</th><th>Input Tokens</th><th>Output Tokens</th></tr></thead><tbody>${rows}</tbody></table>`;
  lucide.createIcons();
}

async function updateDashboard(): Promise<void> {
  try {
    const data = await dashboardRequest<LogsResponse>("/dashboard/api/logs");
    element("uptimeVal").innerText = data.uptime;
    if (data.logs.length !== lastLogCount) {
      renderLogs(data.logs);
      lastLogCount = data.logs.length;
    }
  } catch (error) {
    console.error("Error updating dashboard:", error);
  }
}

async function clearLogs(): Promise<void> {
  try {
    await dashboardRequest<unknown>("/dashboard/api/clear", { method: "POST" });
    lastLogCount = -1;
    await updateDashboard();
  } catch (error) {
    console.error("Clear logs failed:", error);
  }
}

async function restartProxy(): Promise<void> {
  const overlay = element<HTMLDivElement>("restartOverlay");
  overlay.classList.add("active");
  try {
    await dashboardRequest<unknown>("/dashboard/api/restart", { method: "POST" });
  } catch {
    // Expected network disruption while the proxy restarts.
  }

  let checks = 0;
  const interval = window.setInterval(async () => {
    checks += 1;
    try {
      const response = await fetch("/health");
      if (response.ok && (await response.text()).includes("acc-proxy")) {
        window.clearInterval(interval);
        window.setTimeout(() => window.location.reload(), 1000);
      }
    } catch {
      // Keep polling while the process is down.
    }
    if (checks > 40) {
      window.clearInterval(interval);
      element<HTMLParagraphElement>("restartOverlay").querySelector("p")!.innerText = "Restart is taking longer than expected. Please manually reload the page.";
    }
  }, 500);
}

element("portVal").innerText = window.location.port || "9999";
element<HTMLButtonElement>("clearBtn").addEventListener("click", () => void clearLogs());
element<HTMLButtonElement>("restartBtn").addEventListener("click", () => void restartProxy());
lucide.createIcons();
window.setInterval(() => void updateDashboard(), 1000);
void updateDashboard();

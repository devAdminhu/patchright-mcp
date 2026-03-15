# @devadminhu/patchright-mcp

> Powerful MCP server for real-time browser automation and debugging via Patchright (Playwright stealth fork).

Built on [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) and exposing **69 tools** via Model Context Protocol — from basic click/screenshot to route interception, raw Chrome DevTools Protocol, multi-tab orchestration, fingerprint spoofing, and token-cheap WebSocket/HTTP capture to disk.

---

## Highlights

- **Native stealth** — Patchright bypasses bot detection by default (webdriver=false, plugins, fingerprint)
- **Automatic capture** — every HTTP request/response, WS frame and console log written to JSONL per session
- **Token-cheap** — query tools (`tail_ws`, `query_network`, `list_endpoints`, `ws_summary`) return only what matters
- **Batch execution** — `fill_form` and `batch_actions` reduce N round-trips to 1
- **Raw CDP** — any Chrome DevTools Protocol command (`Network.*`, `Page.*`, `Runtime.*`, `Emulation.*`, `Fetch.*`)
- **Session forge** — cookies, localStorage, sessionStorage, headers, UA, geo, timezone, device emulation
- **Multi-tab** — multiple tabs with own IDs, switch/close/list

---

## Installation

```bash
npx -y @devadminhu/patchright-mcp
```

Or global:

```bash
npm i -g @devadminhu/patchright-mcp
```

### Register in your MCP client

Add to your MCP config (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "patchright-mcp": {
      "command": "npx",
      "args": ["-y", "@devadminhu/patchright-mcp"]
    }
  }
}
```

Tools will appear as `mcp__patchright-mcp__*`.

---

## Quickstart

### 1. Launch Chrome

```
launch_browser sessionId="x" headless=false
```

**Cloudflare / anti-bot bypass** (passes JS challenge even in headless):

```
launch_browser
  sessionId="x"
  headless=true
  cfBypass=true
  userDataDir="/path/to/profile"
```

`cfBypass=true` applies:
- `channel="chrome"` (real installed Chrome, not Chromium)
- Anti-detect args (`--disable-blink-features=AutomationControlled`, etc)
- `ignoreDefaultArgs=["--enable-automation"]`
- Real Chrome 147 UA (no "Headless")
- Auto `stealth_inject` (webdriver=undefined, plugins, hardware)

`userDataDir` + `lockProfile` (default true) persists `cf_clearance` across runs with fcntl-style lock to prevent two instances corrupting LevelDB.

Or connect to an already-running Chrome via CDP:

```bash
google-chrome --remote-debugging-port=9222 &
```
```
ws_connect_local sessionId="x"
```

### 2. Stealth + navigation

```
stealth_inject sessionId="x"
navigate sessionId="x" url="https://example.com"
```

### 3. Investigate

```
ws_summary sessionId="x"                    # WS URL summary + counts
tail_ws sessionId="x" limit=20 evt=send     # last 20 sent WS messages
list_endpoints sessionId="x"                # unique HTTP hosts/paths
query_network sessionId="x" urlPattern="api/login" limit=5
session_storage_info sessionId="x"          # captured file sizes
export_session sessionId="x"                # full dump as JSON
```

---

## Tools (69)

### Connection & Session
- `start_debug_session` — create session (with or without wsEndpoint)
- `ws_connect_local` — connect to local Chrome on port 9222
- `launch_browser` — launch Chrome (headful/headless, viewport, userDataDir)
- `list_sessions` — list active sessions
- `get_session_info` — detailed session info
- `close_session` — close and cleanup

### Navigation
- `navigate` — go to URL (customizable waitUntil)
- `reload`, `go_back`, `go_forward`
- `wait_for_navigation` — wait for load to complete
- `wait_for_response` — wait for response matching pattern

### DOM Interaction
- `click_element`, `hover`, `type_text`, `set_input`
- `press_key` (Enter, Escape, Ctrl+a, etc)
- `scroll_to`, `select_option`, `drag_drop`
- `upload_file`, `download_file`
- **`fill_form`** — batch fill multiple fields in one call
- **`batch_actions`** — action sequence (fill/click/wait/eval/press/select/hover/screenshot)

### Inspection
- `inspect_dom` — HTML, styles, rect, attributes
- `query_all` — all matching elements
- `find_by_text` — search by visible text
- `get_html`, `get_text`, `get_page_state`
- `wait_for_element`, `evaluate_script`

### Network
- **`intercept_route`** — abort/continue/fulfill (mock response, modify headers/body)
- `remove_route`, `block_resources`
- `debug_network`, `get_full_network`, `get_response_body`

### Token-cheap query (all captured to disk)
- **`list_endpoints`** — unique hosts/paths/methods with count
- **`query_network`** — filters (urlPattern, method, status, phase) + pagination
- **`tail_ws`** — last N WS messages with filters
- **`ws_summary`** — counts per URL (create/send/recv/close)
- `session_storage_info`, `clear_session_storage`, `export_session`

### Cookies & Storage
- `get_cookies`, `set_cookies`, `clear_cookies`
- `get_storage`, `set_storage`, `save_storage_state`

### Stealth & Spoof
- **`stealth_inject`** — webdriver=false, plugins, hardware masking
- `set_user_agent`, `set_geolocation`, `set_timezone`
- `set_extra_headers`, `emulate_device`

### Multi-Tab
- `new_tab`, `list_tabs`, `switch_tab`, `close_tab`

### Output
- `capture_screenshot`, `save_pdf`
- `start_video`, `stop_video`

### Power Mode
- **`cdp_command`** — raw Chrome DevTools Protocol command

### Debug
- `debug_console`, `get_performance_metrics`, `exec_accessibility_audit`

---

## Session storage

Everything is automatically written to `/tmp/mcp-patchright/<sessionId>/`:

```
network.jsonl    # all HTTP requests + responses
ws.jsonl         # all WebSocket frames (create/send/recv/close)
console.jsonl    # all console logs
```

Use **query tools** to search without dumping everything into context. Or `export_session` to get a single JSON file ready for external analysis.

---

## Notes

- **PDF (`save_pdf`)** only works in headless mode (Chromium limitation)
- **Raw CDP (`cdp_command`)** is dev mode — no validation, any CDP method accepted

---

## License

MIT — [devadminhu](https://github.com/devAdminhu)

#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { chromium, type Browser, type BrowserContext, type Page } from "patchright"
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, statSync, unlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const _REAL_CHROME_UA_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"

const _CF_BYPASS_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-site-isolation-trials",
  "--no-sandbox",
]

const _CF_IGNORE_DEFAULT_ARGS = ["--enable-automation"]

const _STALE_LOCK_AGE_MS = 5 * 60 * 1000

function acquireProfileLock(profilePath: string): { release: () => void } {
  mkdirSync(profilePath, { recursive: true })
  const lockFile = join(profilePath, ".mcp-patchright.lock")
  if (existsSync(lockFile)) {
    try {
      const age = Date.now() - statSync(lockFile).mtimeMs
      if (age > _STALE_LOCK_AGE_MS) {
        unlinkSync(lockFile)
      } else {
        throw new Error(
          `Profile ${profilePath} já em uso por outro processo (lock age ${Math.round(age / 1000)}s). Espere ou apague ${lockFile} se sabe que está orfão.`
        )
      }
    } catch (e) {
      if (existsSync(lockFile)) throw e
    }
  }
  const fd = openSync(lockFile, "wx")
  writeFileSync(lockFile, `${process.pid}\n${Date.now()}\n`)
  return {
    release: () => {
      try { closeSync(fd) } catch {}
      try { unlinkSync(lockFile) } catch {}
    },
  }
}

const STORAGE_ROOT = join(tmpdir(), "mcp-patchright")
mkdirSync(STORAGE_ROOT, { recursive: true })

function sessionDir(sessionId: string): string {
  const dir = join(STORAGE_ROOT, sessionId)
  mkdirSync(dir, { recursive: true })
  return dir
}

function appendJsonl(sessionId: string, file: string, obj: unknown) {
  try {
    appendFileSync(join(sessionDir(sessionId), file), JSON.stringify(obj) + "\n")
  } catch {}
}

function readJsonl<T = any>(sessionId: string, file: string): T[] {
  const path = join(sessionDir(sessionId), file)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l: string) => {
      try {
        return JSON.parse(l) as T
      } catch {
        return null
      }
    })
    .filter((x: any): x is T => x !== null)
}

interface NetworkRecord {
  method: string
  url: string
  headers: Record<string, string>
  postData?: string
  response?: {
    status: number
    headers: Record<string, string>
    body?: string
  }
  timestamp: number
}

interface DebugSession {
  browser: Browser | null
  context: BrowserContext | null
  page: Page | null
  pages: Map<string, Page>
  wsEndpoint: string | null
  status: "idle" | "connecting" | "connected" | "error"
  error?: string
  consoleLogs: string[]
  networkRequests: string[]
  networkRecords: NetworkRecord[]
  routes: Map<string, (route: any) => Promise<void> | void>
  launched: boolean
  videoPath?: string
  cdpSession?: any
  lockRelease?: () => void
}

const sessions: Map<string, DebugSession> = new Map()

function makeSession(opts: {
  wsEndpoint?: string | null
  status?: DebugSession["status"]
  launched?: boolean
}): DebugSession {
  return {
    browser: null,
    context: null,
    page: null,
    pages: new Map(),
    wsEndpoint: opts.wsEndpoint ?? null,
    status: opts.status ?? "idle",
    consoleLogs: [],
    networkRequests: [],
    networkRecords: [],
    routes: new Map(),
    launched: opts.launched ?? false,
  }
}

function attachPageHandlers(session: DebugSession, page: Page, sessionId: string) {
  page.on("console", (msg) => {
    const entry = `[${msg.type()}] ${msg.text()}`
    session.consoleLogs.push(entry)
    appendJsonl(sessionId, "console.jsonl", { t: Date.now(), type: msg.type(), text: msg.text() })
  })
  page.on("request", (req) => {
    session.networkRequests.push(`${req.method()} ${req.url()}`)
    const rec: NetworkRecord = {
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      postData: req.postData() || undefined,
      timestamp: Date.now(),
    }
    session.networkRecords.push(rec)
    appendJsonl(sessionId, "network.jsonl", { phase: "request", ...rec })
  })
  page.on("response", async (res) => {
    const rec = session.networkRecords.find(
      (r) => r.url === res.url() && !r.response
    )
    const responseData = {
      status: res.status(),
      url: res.url(),
      headers: res.headers(),
    }
    if (rec) {
      try {
        rec.response = { status: res.status(), headers: res.headers() }
      } catch {}
    }
    appendJsonl(sessionId, "network.jsonl", { phase: "response", t: Date.now(), ...responseData })
  })
  page.on("websocket", (ws) => {
    appendJsonl(sessionId, "ws.jsonl", { t: Date.now(), evt: "create", url: ws.url() })
    ws.on("framesent", (frame) => {
      appendJsonl(sessionId, "ws.jsonl", { t: Date.now(), evt: "send", url: ws.url(), payload: typeof frame.payload === "string" ? frame.payload.slice(0, 5000) : `[binary ${(frame.payload as Buffer).length}b]` })
    })
    ws.on("framereceived", (frame) => {
      appendJsonl(sessionId, "ws.jsonl", { t: Date.now(), evt: "recv", url: ws.url(), payload: typeof frame.payload === "string" ? frame.payload.slice(0, 5000) : `[binary ${(frame.payload as Buffer).length}b]` })
    })
    ws.on("close", () => {
      appendJsonl(sessionId, "ws.jsonl", { t: Date.now(), evt: "close", url: ws.url() })
    })
    ws.on("socketerror", (err) => {
      appendJsonl(sessionId, "ws.jsonl", { t: Date.now(), evt: "error", url: ws.url(), error: String(err) })
    })
  })
}

// Executa UMA ação do batch (sequencial ou paralelo) e devolve a linha de log de sucesso.
// Lança em erro/tipo desconhecido — quem chama decide se para ou só registra o ✗.
async function runAction(page: Page, a: Record<string, any>, i: number): Promise<string> {
  switch (a.type) {
    case "fill":
      await page.fill(a.selector, a.value)
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLInputElement
        el?.dispatchEvent(new Event("change", { bubbles: true }))
        el?.dispatchEvent(new Event("input", { bubbles: true }))
      }, a.selector)
      return `[${i}] ✓ fill ${a.selector}`
    case "click":
      await page.click(a.selector)
      return `[${i}] ✓ click ${a.selector}`
    case "press":
      await page.keyboard.press(a.key)
      return `[${i}] ✓ press ${a.key}`
    case "wait":
      if (a.selector) {
        await page.waitForSelector(a.selector, { timeout: a.timeout || 5000 })
        return `[${i}] ✓ wait selector ${a.selector}`
      }
      await new Promise((r) => setTimeout(r, a.ms || 1000))
      return `[${i}] ✓ wait ${a.ms || 1000}ms`
    case "eval": {
      const result = await page.evaluate(a.script)
      return `[${i}] ✓ eval → ${JSON.stringify(result).slice(0, 200)}`
    }
    case "select":
      await page.selectOption(a.selector, a.value)
      return `[${i}] ✓ select ${a.selector}=${a.value}`
    case "hover":
      await page.hover(a.selector)
      return `[${i}] ✓ hover ${a.selector}`
    case "screenshot":
      await page.screenshot({ path: a.path, fullPage: a.fullPage !== false })
      return `[${i}] ✓ screenshot ${a.path}`
    default:
      throw new Error(`unknown action type: ${a.type}`)
  }
}

const server = new Server(
  {
    name: "patchright-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

const tools: Tool[] = [
  {
    name: "start_debug_session",
    description: "Inicia sessão de debug conectando ao Chrome/Chromium via CDP",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string",
          description: "ID único da sessão",
        },
        wsEndpoint: {
          type: "string",
          description:
            "WebSocket CDP endpoint (ex: ws://localhost:9222/devtools/browser/...)",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "ws_connect_local",
    description:
      "Conecta automaticamente ao Chrome local em 9222 (convenience tool)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "launch_browser",
    description:
      "Lança Chrome (default headful) com captura automática de network/WS/console em arquivo. Suporta cfBypass pra passar Cloudflare/anti-bot em headless.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        headless: {
          type: "boolean",
          description: "Se true, roda sem janela. Default: false (com janela)",
        },
        viewport: {
          type: "object",
          description: "Tamanho da janela",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
          },
        },
        userDataDir: {
          type: "string",
          description: "Path pra perfil persistente (cookies/sessões salvos). Recomendado se cfBypass=true pra reusar cf_clearance entre execuções.",
        },
        cfBypass: {
          type: "boolean",
          description: "Aplica táticas anti-Cloudflare/anti-bot: Chrome real (channel=chrome), args anti-detect, ignore --enable-automation, UA real Chrome 147, auto stealth_inject. Default: false.",
        },
        lockProfile: {
          type: "boolean",
          description: "Aplica lock fcntl exclusivo no userDataDir (impede 2 instâncias corromperem LevelDB). Requer userDataDir. Default: true se userDataDir presente.",
        },
        userAgent: {
          type: "string",
          description: "UA customizado. Default quando cfBypass=true: Chrome real Linux 147 (sem 'Headless').",
        },
        extraArgs: {
          type: "array",
          items: { type: "string" },
          description: "Args extras pra Chrome (concatenados aos do cfBypass se ativo).",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "list_sessions",
    description: "Lista todas as sessões ativas",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "navigate",
    description: "Navega para URL",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        url: { type: "string" },
        waitUntil: {
          type: "string",
          description: "load|domcontentloaded|networkidle",
        },
      },
      required: ["sessionId", "url"],
    },
  },
  {
    name: "evaluate_script",
    description: "Executa JS com acesso ao contexto de página",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        script: { type: "string" },
      },
      required: ["sessionId", "script"],
    },
  },
  {
    name: "inspect_dom",
    description: "Inspeciona elemento: HTML, styles, rect, attributes",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
      },
      required: ["sessionId", "selector"],
    },
  },
  {
    name: "query_all",
    description: "Query todos os elementos matching selector",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
      },
      required: ["sessionId", "selector"],
    },
  },
  {
    name: "set_input",
    description: "Seta valor em input/textarea com trigger de eventos",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        value: { type: "string" },
      },
      required: ["sessionId", "selector", "value"],
    },
  },
  {
    name: "fill_form",
    description:
      "BATCH: Preenche múltiplos campos numa única chamada. fields = {seletor: valor}. Opcional: submitSelector pra clicar no botão de submit no fim.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        fields: {
          type: "object",
          description: "Objeto { 'css selector': 'valor', ... }",
        },
        submitSelector: {
          type: "string",
          description: "Opcional: selector do botão pra clicar após preencher",
        },
      },
      required: ["sessionId", "fields"],
    },
  },
  {
    name: "batch_actions",
    description:
      "BATCH MEGA: executa array de ações sequenciais numa só chamada. Cada ação: {type: 'fill'|'click'|'press'|'wait'|'eval'|'select', ...args}. Reduz round-trips drasticamente.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        actions: {
          type: "array",
          items: { type: "object" },
          description: "[{type:'fill', selector, value}, {type:'click', selector}, {type:'wait', ms}, {type:'press', key}, {type:'eval', script}, {type:'select', selector, value}]",
        },
        stopOnError: {
          type: "boolean",
          description: "Default true: para no primeiro erro",
        },
      },
      required: ["sessionId", "actions"],
    },
  },
  {
    name: "batch_parallel",
    description:
      "BATCH PARALELO: executa array de ações EM PARALELO (concorrente) via Promise.allSettled — dispara tudo de uma vez, uma falha não derruba as outras. Mesmos tipos do batch_actions (fill, click, press, wait, eval, select, hover, screenshot). Use SÓ pra ações independentes no mesmo page (ex: vários eval/leituras). Ações que disputam foco/navegação podem dar corrida — responsabilidade de quem chama. Log indexado na ordem de entrada.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        actions: {
          type: "array",
          items: { type: "object" },
          description: "[{type:'eval', script}, {type:'click', selector}, {type:'fill', selector, value}, {type:'wait', ms}, ...] — mesmos tipos do batch_actions",
        },
        concurrency: {
          type: "number",
          description: "Default ilimitado (todas de uma vez). Se passado, roda em lotes desse tamanho via pool na mão",
        },
      },
      required: ["sessionId", "actions"],
    },
  },
  {
    name: "click_element",
    description: "Click em elemento",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
      },
      required: ["sessionId", "selector"],
    },
  },
  {
    name: "wait_for_element",
    description: "Espera elemento aparecer no DOM",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        timeout: { type: "number", description: "ms" },
      },
      required: ["sessionId", "selector"],
    },
  },
  {
    name: "capture_screenshot",
    description: "Screenshot fullpage ou viewport",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
        fullPage: { type: "boolean" },
      },
      required: ["sessionId", "path"],
    },
  },
  {
    name: "debug_console",
    description: "Ver logs do console",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "debug_network",
    description: "Ver requisições de rede capturadas",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_page_state",
    description: "Dump: DOM, scripts, recursos, stylesheets",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_performance_metrics",
    description: "Coleta Core Web Vitals",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "exec_accessibility_audit",
    description: "Roda audit a11y (alt, labels, roles)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_session_info",
    description: "Info completa da sessão",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "intercept_route",
    description:
      "Intercepta requisições matching pattern. Pode bloquear, modificar headers/body ou retornar mock response. Pattern: glob (ex: '**/*.css', 'https://api.com/**')",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        pattern: { type: "string", description: "URL pattern (glob)" },
        action: {
          type: "string",
          enum: ["abort", "continue", "fulfill"],
          description: "abort=bloqueia, continue=modifica e prossegue, fulfill=mock response",
        },
        modify: {
          type: "object",
          description: "Para action=continue: { headers, postData, url, method }",
        },
        mockResponse: {
          type: "object",
          description: "Para action=fulfill: { status, headers, body, contentType }",
        },
      },
      required: ["sessionId", "pattern", "action"],
    },
  },
  {
    name: "remove_route",
    description: "Remove interceptação de pattern previamente setado",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        pattern: { type: "string" },
      },
      required: ["sessionId", "pattern"],
    },
  },
  {
    name: "get_cookies",
    description: "Lê cookies da sessão (filtra por URL opcional)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        urls: { type: "array", items: { type: "string" } },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "set_cookies",
    description: "Injeta cookies (forja sessão). Array de { name, value, domain, path, expires, httpOnly, secure, sameSite }",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        cookies: { type: "array", items: { type: "object" } },
      },
      required: ["sessionId", "cookies"],
    },
  },
  {
    name: "clear_cookies",
    description: "Limpa todos cookies do contexto",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_storage",
    description: "Dump localStorage + sessionStorage da página atual",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "set_storage",
    description: "Seta localStorage/sessionStorage. type: 'local'|'session'",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        type: { type: "string", enum: ["local", "session"] },
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["sessionId", "type", "key", "value"],
    },
  },
  {
    name: "save_storage_state",
    description: "Salva estado completo (cookies + storage) em JSON file. Use pra reusar login.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
      },
      required: ["sessionId", "path"],
    },
  },
  {
    name: "set_user_agent",
    description: "Spoofa User-Agent (precisa ser feito antes de navegar)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        userAgent: { type: "string" },
      },
      required: ["sessionId", "userAgent"],
    },
  },
  {
    name: "set_geolocation",
    description: "Spoofa geolocalização (lat, longitude)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        latitude: { type: "number" },
        longitude: { type: "number" },
        accuracy: { type: "number" },
      },
      required: ["sessionId", "latitude", "longitude"],
    },
  },
  {
    name: "set_timezone",
    description: "Spoofa timezone (ex: 'America/Sao_Paulo', 'America/New_York')",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["sessionId", "timezone"],
    },
  },
  {
    name: "set_extra_headers",
    description: "Adiciona headers customizados em todas as requisições",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        headers: { type: "object" },
      },
      required: ["sessionId", "headers"],
    },
  },
  {
    name: "block_resources",
    description: "Bloqueia tipos de recurso (image, font, stylesheet, media, etc) pra speed",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        types: {
          type: "array",
          items: { type: "string" },
          description: "image|font|stylesheet|media|script|xhr|fetch",
        },
      },
      required: ["sessionId", "types"],
    },
  },
  {
    name: "new_tab",
    description: "Abre nova aba na sessão. Retorna tabId pra usar com switch_tab",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        tabId: { type: "string" },
        url: { type: "string" },
      },
      required: ["sessionId", "tabId"],
    },
  },
  {
    name: "list_tabs",
    description: "Lista todas as abas com URLs e títulos",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "switch_tab",
    description: "Troca aba ativa pra tabId",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        tabId: { type: "string" },
      },
      required: ["sessionId", "tabId"],
    },
  },
  {
    name: "close_tab",
    description: "Fecha aba específica",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        tabId: { type: "string" },
      },
      required: ["sessionId", "tabId"],
    },
  },
  {
    name: "press_key",
    description: "Press tecla(s). Suporta combos: 'Control+a', 'Shift+Tab', 'Enter', 'Escape'",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        key: { type: "string" },
      },
      required: ["sessionId", "key"],
    },
  },
  {
    name: "type_text",
    description: "Digita texto com delay realista (simula humano)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        delay: { type: "number", description: "ms entre teclas (default 50)" },
      },
      required: ["sessionId", "selector", "text"],
    },
  },
  {
    name: "hover",
    description: "Hover em elemento (trigger menus/tooltips)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
      },
      required: ["sessionId", "selector"],
    },
  },
  {
    name: "scroll_to",
    description: "Scroll até elemento ou posição (x, y)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "select_option",
    description: "Seleciona option em <select>",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        value: { type: "string" },
      },
      required: ["sessionId", "selector", "value"],
    },
  },
  {
    name: "upload_file",
    description: "Upload arquivo em <input type='file'>",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        filePath: { type: "string" },
      },
      required: ["sessionId", "selector", "filePath"],
    },
  },
  {
    name: "download_file",
    description: "Click em link e salva arquivo baixado em path",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        selector: { type: "string" },
        savePath: { type: "string" },
      },
      required: ["sessionId", "selector", "savePath"],
    },
  },
  {
    name: "save_pdf",
    description: "Salva página atual como PDF (só headless)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
        format: { type: "string", description: "A4|Letter|Legal" },
      },
      required: ["sessionId", "path"],
    },
  },
  {
    name: "get_html",
    description: "Retorna HTML completo da página (full source)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_text",
    description: "Retorna texto visível da página (innerText)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "find_by_text",
    description: "Acha elementos por texto. Retorna até 10 matches.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        text: { type: "string" },
        regex: { type: "boolean" },
      },
      required: ["sessionId", "text"],
    },
  },
  {
    name: "get_full_network",
    description: "Dump completo de network: requests + responses + headers + bodies (JSON)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        urlPattern: { type: "string", description: "Filtro regex" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_response_body",
    description: "Pega body de uma response específica (URL match)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        urlContains: { type: "string" },
      },
      required: ["sessionId", "urlContains"],
    },
  },
  {
    name: "cdp_command",
    description:
      "POWER MODE: Executa comando CDP raw (Chrome DevTools Protocol). Ex: 'Network.clearBrowserCache', 'Page.captureScreenshot', etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        method: { type: "string" },
        params: { type: "object" },
      },
      required: ["sessionId", "method"],
    },
  },
  {
    name: "stealth_inject",
    description:
      "Injeta scripts antes do page load pra mascarar fingerprint (webdriver=false, plugins, hardware)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "start_video",
    description: "Inicia gravação de video da sessão (precisa setar antes do navigate)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
      },
      required: ["sessionId", "path"],
    },
  },
  {
    name: "stop_video",
    description: "Para gravação e salva video",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "emulate_device",
    description:
      "Emula device móvel. devices: iPhone 13|iPhone 14 Pro|Pixel 7|iPad Pro|etc",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        device: { type: "string" },
      },
      required: ["sessionId", "device"],
    },
  },
  {
    name: "drag_drop",
    description: "Drag from selector source to selector target",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        sourceSelector: { type: "string" },
        targetSelector: { type: "string" },
      },
      required: ["sessionId", "sourceSelector", "targetSelector"],
    },
  },
  {
    name: "wait_for_response",
    description: "Espera response matching URL pattern (útil pra esperar API call)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        urlPattern: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["sessionId", "urlPattern"],
    },
  },
  {
    name: "wait_for_navigation",
    description: "Espera navegação completar (após click que dispara nav)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        waitUntil: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "go_back",
    description: "Volta uma página no histórico",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "go_forward",
    description: "Avança uma página no histórico",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "reload",
    description: "Recarrega página atual",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "list_endpoints",
    description:
      "Lista hosts/paths/métodos únicos capturados (sem bodies). Token-cheap. Filtros opcionais.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        hostPattern: { type: "string", description: "Regex pra filtrar hosts" },
        groupBy: { type: "string", enum: ["host", "path", "method", "host+path"], description: "Default host+path" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "query_network",
    description:
      "Busca em network capturada com filtros e paginação. Retorna só matches (não dump completo).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        urlPattern: { type: "string", description: "Regex" },
        method: { type: "string" },
        statusMin: { type: "number" },
        statusMax: { type: "number" },
        phase: { type: "string", enum: ["request", "response", "both"] },
        limit: { type: "number", description: "Default 20" },
        offset: { type: "number", description: "Default 0" },
        fields: { type: "array", items: { type: "string" }, description: "Subset: url|method|status|headers|postData" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "tail_ws",
    description:
      "Últimas N mensagens WebSocket capturadas. Filtros: url, evt (send|recv|create|close), since timestamp.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        limit: { type: "number", description: "Default 30" },
        urlPattern: { type: "string" },
        evt: { type: "string", enum: ["send", "recv", "create", "close", "error", "all"] },
        since: { type: "number", description: "timestamp ms" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "ws_summary",
    description: "Resumo WebSocket: URLs únicas, count send/recv/create/close por URL, timestamps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "session_storage_info",
    description: "Mostra path do storage da sessão e tamanho de cada arquivo (network.jsonl, ws.jsonl, console.jsonl).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "clear_session_storage",
    description: "Limpa arquivos da sessão (network.jsonl, ws.jsonl, console.jsonl) e buffers em memória.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "export_session",
    description: "Exporta tudo (network + ws + console) pra um arquivo único JSON. Não retorna conteúdo, só o path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        path: { type: "string", description: "Default: <storage>/export.json" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "close_session",
    description: "Fecha sessão",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const sessionId = (args as Record<string, unknown>).sessionId as string

  try {
    switch (name) {
      case "start_debug_session": {
        const wsEndpoint = (args as Record<string, string>).wsEndpoint
        const session = makeSession({
          wsEndpoint: wsEndpoint || null,
          status: "connecting",
        })

        if (wsEndpoint) {
          try {
            session.browser = await chromium.connectOverCDP(wsEndpoint)
            session.status = "connected"
          } catch (e) {
            session.status = "error"
            session.error = `Failed to connect: ${e instanceof Error ? e.message : String(e)}`
          }
        }

        sessions.set(sessionId, session)
        return {
          content: [
            {
              type: "text",
              text: `Sessão ${sessionId} criada. Status: ${session.status}${session.error ? ` - ${session.error}` : ""}`,
            },
          ],
        }
      }

      case "ws_connect_local": {
        let session = sessions.get(sessionId)
        if (!session) {
          session = makeSession({})
          sessions.set(sessionId, session)
        }

        try {
          const response = await fetch("http://localhost:9222/json/version")
          const data = (await response.json()) as Record<string, string>
          const wsEndpoint = data.webSocketDebuggerUrl

          session.browser = await chromium.connectOverCDP(wsEndpoint)
          session.wsEndpoint = wsEndpoint
          session.status = "connected"

          return {
            content: [
              {
                type: "text",
                text: `Conectado a Chrome local. Endpoint: ${wsEndpoint}`,
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: Chrome não rodando em localhost:9222. Inicie com: google-chrome --remote-debugging-port=9222`,
              },
            ],
            isError: true,
          }
        }
      }

      case "launch_browser": {
        const headless =
          (args as Record<string, boolean>).headless === true
        const viewport = (args as Record<string, { width: number; height: number }>)
          .viewport || { width: 1280, height: 800 }
        const userDataDir = (args as Record<string, string>).userDataDir
        const cfBypass = (args as Record<string, boolean>).cfBypass === true
        const lockProfile =
          userDataDir &&
          (args as Record<string, boolean>).lockProfile !== false
        const customUA = (args as Record<string, string>).userAgent
        const extraArgs = ((args as Record<string, string[]>).extraArgs || []) as string[]

        let lockHandle: { release: () => void } | undefined
        if (lockProfile && userDataDir) {
          try {
            lockHandle = acquireProfileLock(userDataDir)
          } catch (e) {
            return {
              content: [{ type: "text", text: `Lock falhou: ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            }
          }
        }

        const launchArgs = [
          ...(cfBypass ? _CF_BYPASS_ARGS : []),
          ...extraArgs,
        ]
        const ignoreDefaultArgs = cfBypass ? _CF_IGNORE_DEFAULT_ARGS : undefined
        const effectiveUA = customUA || (cfBypass ? _REAL_CHROME_UA_LINUX : undefined)

        try {
          const session = makeSession({
            status: "connecting",
            launched: true,
          })
          if (lockHandle) session.lockRelease = lockHandle.release

          if (userDataDir) {
            const ctx = await chromium.launchPersistentContext(userDataDir, {
              headless,
              viewport,
              channel: "chrome",
              args: launchArgs.length ? launchArgs : undefined,
              ignoreDefaultArgs,
              userAgent: effectiveUA,
            })
            session.context = ctx
            session.page = ctx.pages()[0] || (await ctx.newPage())
          } else {
            const browser = await chromium.launch({
              headless,
              channel: "chrome",
              args: launchArgs.length ? launchArgs : undefined,
              ignoreDefaultArgs,
            })
            session.browser = browser
            const ctx = await browser.newContext({
              viewport,
              userAgent: effectiveUA,
            })
            session.context = ctx
            session.page = await ctx.newPage()
          }

          if (cfBypass && session.context) {
            await session.context.addInitScript(() => {
              try { delete (Navigator.prototype as any).webdriver } catch {}
              try {
                const fakePlugins = Object.create(PluginArray.prototype)
                const items = [
                  { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                  { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                  { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                  { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                  { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                ]
                items.forEach((p, i) => { (fakePlugins as any)[i] = p; (fakePlugins as any)[p.name] = p })
                Object.defineProperty(fakePlugins, "length", { get: () => items.length })
                Object.defineProperty(Navigator.prototype, "plugins", { get: () => fakePlugins, configurable: true })
              } catch {}
              try { Object.defineProperty(Navigator.prototype, "languages", { get: () => ["pt-BR", "pt", "en-US", "en"], configurable: true }) } catch {}
              try { Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => 8, configurable: true }) } catch {}
              try { Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => 8, configurable: true }) } catch {}
              ;(window as any).chrome = (window as any).chrome || { runtime: {}, app: { isInstalled: false }, csi: () => {}, loadTimes: () => {} }
              try {
                const origQuery = (window.navigator.permissions as any).query.bind(window.navigator.permissions)
                ;(window.navigator.permissions as any).query = (params: any) =>
                  params && params.name === "notifications"
                    ? Promise.resolve({ state: Notification.permission })
                    : origQuery(params)
              } catch {}
            })
          }

          attachPageHandlers(session, session.page, sessionId)
          session.status = "connected"
          sessions.set(sessionId, session)

          const flags = [
            headless ? "headless" : "headful",
            cfBypass ? "cfBypass" : "",
            lockHandle ? "locked" : "",
          ].filter(Boolean).join(", ")
          return {
            content: [
              {
                type: "text",
                text: `Chrome lançado (${flags}) - sessão ${sessionId}`,
              },
            ],
          }
        } catch (e) {
          if (lockHandle) lockHandle.release()
          return {
            content: [
              {
                type: "text",
                text: `Erro ao lançar: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "list_sessions": {
        const list = Array.from(sessions.entries()).map(([id, sess]) => ({
          id,
          status: sess.status,
          connected: !!sess.browser,
          logs: sess.consoleLogs.length,
          requests: sess.networkRequests.length,
        }))
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(list, null, 2),
            },
          ],
        }
      }

      case "navigate": {
        const session = sessions.get(sessionId)
        if (!session || (!session.browser && !session.context)) {
          return {
            content: [
              {
                type: "text",
                text: "Sessão não conectada",
              },
            ],
            isError: true,
          }
        }

        const url = (args as Record<string, string>).url
        const waitUntil = (args as Record<string, string>).waitUntil || "load"

        try {
          let page = session.page
          if (!page) {
            if (session.context) {
              page = session.context.pages()[0] || (await session.context.newPage())
            } else if (session.browser) {
              const ctx = session.browser.contexts()[0] || (await session.browser.newContext())
              page = ctx.pages()[0] || (await ctx.newPage())
              session.context = ctx
            }
            if (page) session.page = page
          }
          if (!page) throw new Error("Não foi possível obter página")

          await page.goto(url, { waitUntil: waitUntil as any })
          return {
            content: [
              {
                type: "text",
                text: `Navegou para ${url}`,
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro ao navegar: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "evaluate_script": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa. Navegue para uma URL primeiro.",
              },
            ],
            isError: true,
          }
        }

        const script = (args as Record<string, string>).script

        try {
          const result = await session.page.evaluate(script)
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "inspect_dom": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        const selector = (args as Record<string, string>).selector

        try {
          const info = await session.page.evaluate((sel) => {
            const el = document.querySelector(sel)
            if (!el) return null

            const rect = el.getBoundingClientRect()
            const styles = window.getComputedStyle(el)
            const attrs: Record<string, string> = {}
            for (const attr of el.attributes) {
              attrs[attr.name] = attr.value
            }

            return {
              tagName: el.tagName,
              className: el.className,
              id: el.id,
              html: el.outerHTML.substring(0, 500),
              text: el.textContent?.substring(0, 200) || "",
              attributes: attrs,
              styles: {
                display: styles.display,
                position: styles.position,
                visibility: styles.visibility,
                opacity: styles.opacity,
              },
              rect: {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
              },
            }
          }, selector)

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(info, null, 2),
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "query_all": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        const selector = (args as Record<string, string>).selector

        try {
          const elements = await session.page.evaluate((sel) => {
            return Array.from(document.querySelectorAll(sel)).map((el) => ({
              text: el.textContent?.substring(0, 100) || "",
              tag: el.tagName,
            }))
          }, selector)

          return {
            content: [
              {
                type: "text",
                text: `Found ${elements.length} elements:\n${JSON.stringify(elements, null, 2)}`,
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "set_input": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        const selector = (args as Record<string, string>).selector
        const value = (args as Record<string, string>).value

        try {
          await session.page.fill(selector, value)
          await session.page.evaluate(
            (sel) => {
              const el = document.querySelector(sel) as HTMLInputElement
              el?.dispatchEvent(new Event("change", { bubbles: true }))
              el?.dispatchEvent(new Event("input", { bubbles: true }))
            },
            selector
          )

          return {
            content: [
              {
                type: "text",
                text: `Input ${selector} setado para: ${value}`,
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "fill_form": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return { content: [{ type: "text", text: "Sem página" }], isError: true }
        }
        const fields = (args as Record<string, Record<string, string>>).fields || {}
        const submitSelector = (args as Record<string, string>).submitSelector
        const results: string[] = []
        const errors: string[] = []
        for (const [selector, value] of Object.entries(fields)) {
          try {
            await session.page.fill(selector, value)
            await session.page.evaluate((sel) => {
              const el = document.querySelector(sel) as HTMLInputElement
              el?.dispatchEvent(new Event("change", { bubbles: true }))
              el?.dispatchEvent(new Event("input", { bubbles: true }))
            }, selector)
            results.push(`✓ ${selector}`)
          } catch (e) {
            errors.push(`✗ ${selector}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (submitSelector) {
          try {
            await session.page.click(submitSelector)
            results.push(`✓ submit: ${submitSelector}`)
          } catch (e) {
            errors.push(`✗ submit ${submitSelector}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        return {
          content: [{ type: "text", text: `Filled ${results.length}/${Object.keys(fields).length + (submitSelector ? 1 : 0)}\n${results.join("\n")}${errors.length ? "\n" + errors.join("\n") : ""}` }],
          isError: errors.length > 0,
        }
      }

      case "batch_actions": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return { content: [{ type: "text", text: "Sem página" }], isError: true }
        }
        const actions = (args as Record<string, any[]>).actions || []
        const stopOnError = (args as Record<string, boolean>).stopOnError !== false
        const log: string[] = []
        const page = session.page
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i]
          try {
            log.push(await runAction(page, a, i))
          } catch (e) {
            log.push(`[${i}] ✗ ${a.type}: ${e instanceof Error ? e.message : String(e)}`)
            if (stopOnError) break
          }
        }
        return { content: [{ type: "text", text: log.join("\n") }] }
      }

      case "batch_parallel": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return { content: [{ type: "text", text: "Sem página" }], isError: true }
        }
        const actions = (args as Record<string, any[]>).actions || []
        const concurrency = (args as Record<string, number>).concurrency
        const page = session.page
        // log indexado na ordem de ENTRADA, não na de conclusão
        const log: string[] = new Array(actions.length)
        // dispara uma ação e registra ✓/✗ na posição i (nunca rejeita — Promise.allSettled cuida do resto)
        const run = (i: number) =>
          runAction(page, actions[i], i)
            .then((line) => { log[i] = line })
            .catch((e) => { log[i] = `[${i}] ✗ ${actions[i]?.type}: ${e instanceof Error ? e.message : String(e)}` })
        if (concurrency && concurrency > 0) {
          // pool simples na mão: lotes de tamanho concurrency
          for (let start = 0; start < actions.length; start += concurrency) {
            const batch = []
            for (let i = start; i < Math.min(start + concurrency, actions.length); i++) batch.push(run(i))
            await Promise.allSettled(batch)
          }
        } else {
          // sem limite: dispara tudo de uma vez
          await Promise.allSettled(actions.map((_, i) => run(i)))
        }
        return { content: [{ type: "text", text: log.join("\n") }] }
      }

      case "click_element": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        const selector = (args as Record<string, string>).selector

        try {
          await session.page.click(selector)
          return {
            content: [
              {
                type: "text",
                text: `Clicado em ${selector}`,
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "wait_for_element": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        const selector = (args as Record<string, string>).selector
        const timeout =
          ((args as Record<string, number>).timeout || 5000) as number

        try {
          await session.page.waitForSelector(selector, { timeout })
          return {
            content: [
              {
                type: "text",
                text: `Elemento ${selector} encontrado`,
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Timeout esperando ${selector}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "capture_screenshot": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        const path = (args as Record<string, string>).path
        const fullPage = (args as Record<string, boolean>).fullPage !== false

        try {
          await session.page.screenshot({ path, fullPage })
          return {
            content: [
              {
                type: "text",
                text: `Screenshot salvo em ${path}`,
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "debug_console": {
        const session = sessions.get(sessionId)
        if (!session) {
          return {
            content: [
              {
                type: "text",
                text: "Sessão não encontrada",
              },
            ],
            isError: true,
          }
        }

        const logs = session.consoleLogs
        return {
          content: [
            {
              type: "text",
              text:
                logs.length > 0 ? logs.join("\n") : "Nenhum log no console",
            },
          ],
        }
      }

      case "debug_network": {
        const session = sessions.get(sessionId)
        if (!session) {
          return {
            content: [
              {
                type: "text",
                text: "Sessão não encontrada",
              },
            ],
            isError: true,
          }
        }

        const requests = session.networkRequests
        return {
          content: [
            {
              type: "text",
              text:
                requests.length > 0
                  ? requests.join("\n")
                  : "Nenhuma requisição capturada",
            },
          ],
        }
      }

      case "get_page_state": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        try {
          const state = await session.page.evaluate(() => {
            return {
              title: document.title,
              url: window.location.href,
              headElements: {
                scripts: document.querySelectorAll("head script").length,
                links: document.querySelectorAll("head link").length,
                metas: document.querySelectorAll("head meta").length,
              },
              bodyElements: {
                scripts: document.querySelectorAll("body script").length,
                images: document.querySelectorAll("img").length,
                iframes: document.querySelectorAll("iframe").length,
                forms: document.querySelectorAll("form").length,
              },
            }
          })

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(state, null, 2),
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "get_performance_metrics": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        try {
          const metrics = await session.page.evaluate(() => {
            const paint = performance.getEntriesByType("paint")
            return {
              paint: paint.map((p) => ({
                name: p.name,
                startTime: p.startTime,
              })),
            }
          })

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(metrics, null, 2),
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "exec_accessibility_audit": {
        const session = sessions.get(sessionId)
        if (!session?.page) {
          return {
            content: [
              {
                type: "text",
                text: "Nenhuma página ativa",
              },
            ],
            isError: true,
          }
        }

        try {
          const audit = await session.page.evaluate(() => {
            const issues: Record<string, unknown[]> = {
              missingAlt: [],
              noLabels: [],
              noRole: [],
            }

            document.querySelectorAll("img").forEach((img) => {
              if (!img.alt) {
                issues.missingAlt.push({
                  src: img.src.substring(0, 50),
                })
              }
            })

            document.querySelectorAll("input").forEach((inp) => {
              const label = document.querySelector(`label[for="${inp.id}"]`)
              if (!inp.placeholder && !label) {
                issues.noLabels.push({
                  type: inp.type,
                  id: inp.id,
                })
              }
            })

            return issues
          })

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(audit, null, 2),
              },
            ],
          }
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Erro: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
            isError: true,
          }
        }
      }

      case "get_session_info": {
        const session = sessions.get(sessionId)
        if (!session) {
          return {
            content: [
              {
                type: "text",
                text: "Sessão não encontrada",
              },
            ],
            isError: true,
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: sessionId,
                  status: session.status,
                  wsEndpoint: session.wsEndpoint,
                  connected: !!session.browser,
                  consoleLogs: session.consoleLogs.length,
                  networkRequests: session.networkRequests.length,
                  error: session.error,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      case "intercept_route": {
        const session = sessions.get(sessionId)
        if (!session?.context && !session?.page) {
          return { content: [{ type: "text", text: "Sessão não conectada" }], isError: true }
        }
        const pattern = (args as Record<string, string>).pattern
        const action = (args as Record<string, string>).action
        const modify = (args as Record<string, any>).modify || {}
        const mockResponse = (args as Record<string, any>).mockResponse || {}

        const handler = async (route: any) => {
          if (action === "abort") return route.abort()
          if (action === "fulfill") {
            return route.fulfill({
              status: mockResponse.status || 200,
              headers: mockResponse.headers || {},
              body: mockResponse.body || "",
              contentType: mockResponse.contentType || "application/json",
            })
          }
          return route.continue({
            url: modify.url,
            method: modify.method,
            headers: modify.headers,
            postData: modify.postData,
          })
        }

        try {
          const target = session.context || session.page!
          await (target as any).route(pattern, handler)
          session.routes.set(pattern, handler)
          return { content: [{ type: "text", text: `Interceptando ${pattern} (${action})` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "remove_route": {
        const session = sessions.get(sessionId)
        if (!session) return { content: [{ type: "text", text: "Sessão não encontrada" }], isError: true }
        const pattern = (args as Record<string, string>).pattern
        const handler = session.routes.get(pattern)
        if (!handler) return { content: [{ type: "text", text: "Pattern não interceptado" }], isError: true }
        try {
          const target = session.context || session.page!
          await (target as any).unroute(pattern, handler)
          session.routes.delete(pattern)
          return { content: [{ type: "text", text: `Removido: ${pattern}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "get_cookies": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sessão sem contexto" }], isError: true }
        const urls = (args as Record<string, string[]>).urls
        try {
          const cookies = await session.context.cookies(urls)
          return { content: [{ type: "text", text: JSON.stringify(cookies, null, 2) }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "set_cookies": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sessão sem contexto" }], isError: true }
        const cookies = (args as Record<string, any[]>).cookies
        try {
          await session.context.addCookies(cookies)
          return { content: [{ type: "text", text: `${cookies.length} cookies injetados` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "clear_cookies": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sessão sem contexto" }], isError: true }
        try {
          await session.context.clearCookies()
          return { content: [{ type: "text", text: "Cookies limpos" }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "get_storage": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        try {
          const storage = await session.page.evaluate(() => ({
            local: { ...localStorage },
            session: { ...sessionStorage },
          }))
          return { content: [{ type: "text", text: JSON.stringify(storage, null, 2) }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "set_storage": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const type = (args as Record<string, string>).type
        const key = (args as Record<string, string>).key
        const value = (args as Record<string, string>).value
        try {
          await session.page.evaluate(
            ([t, k, v]) => {
              const store = t === "local" ? localStorage : sessionStorage
              store.setItem(k, v)
            },
            [type, key, value]
          )
          return { content: [{ type: "text", text: `${type}Storage[${key}] = ${value}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "save_storage_state": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sem contexto" }], isError: true }
        const path = (args as Record<string, string>).path
        try {
          await session.context.storageState({ path })
          return { content: [{ type: "text", text: `Estado salvo em ${path}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "set_user_agent": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const userAgent = (args as Record<string, string>).userAgent
        try {
          await session.page.setExtraHTTPHeaders({ "User-Agent": userAgent })
          return { content: [{ type: "text", text: `User-Agent: ${userAgent}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "set_geolocation": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sem contexto" }], isError: true }
        const latitude = (args as Record<string, number>).latitude
        const longitude = (args as Record<string, number>).longitude
        const accuracy = ((args as Record<string, number>).accuracy || 100) as number
        try {
          await session.context.setGeolocation({ latitude, longitude, accuracy })
          await session.context.grantPermissions(["geolocation"])
          return { content: [{ type: "text", text: `Geo: ${latitude}, ${longitude}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "set_timezone": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const timezone = (args as Record<string, string>).timezone
        try {
          if (session.cdpSession) {
            await session.cdpSession.send("Emulation.setTimezoneOverride", { timezoneId: timezone })
          } else if (session.page) {
            const cdp = await session.page.context().newCDPSession(session.page)
            session.cdpSession = cdp
            await cdp.send("Emulation.setTimezoneOverride", { timezoneId: timezone })
          }
          return { content: [{ type: "text", text: `Timezone: ${timezone}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "set_extra_headers": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sem contexto" }], isError: true }
        const headers = (args as Record<string, Record<string, string>>).headers
        try {
          await session.context.setExtraHTTPHeaders(headers)
          return { content: [{ type: "text", text: `Headers setados: ${Object.keys(headers).join(", ")}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "block_resources": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sem contexto" }], isError: true }
        const types = (args as Record<string, string[]>).types
        try {
          const handler = (route: any) => {
            if (types.includes(route.request().resourceType())) return route.abort()
            return route.continue()
          }
          await session.context.route("**/*", handler)
          session.routes.set("__block_resources__", handler)
          return { content: [{ type: "text", text: `Bloqueando: ${types.join(", ")}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "new_tab": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sem contexto" }], isError: true }
        const tabId = (args as Record<string, string>).tabId
        const url = (args as Record<string, string>).url
        try {
          const page = await session.context.newPage()
          attachPageHandlers(session, page, sessionId)
          if (url) await page.goto(url)
          session.pages.set(tabId, page)
          session.page = page
          return { content: [{ type: "text", text: `Aba ${tabId} aberta${url ? ` em ${url}` : ""}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "list_tabs": {
        const session = sessions.get(sessionId)
        if (!session?.context) return { content: [{ type: "text", text: "Sem contexto" }], isError: true }
        try {
          const tabsArr: any[] = []
          for (const [id, page] of session.pages.entries()) {
            tabsArr.push({ id, url: page.url(), title: await page.title() })
          }
          for (const page of session.context.pages()) {
            if (![...session.pages.values()].includes(page)) {
              tabsArr.push({ id: "untracked", url: page.url(), title: await page.title() })
            }
          }
          return { content: [{ type: "text", text: JSON.stringify(tabsArr, null, 2) }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "switch_tab": {
        const session = sessions.get(sessionId)
        if (!session) return { content: [{ type: "text", text: "Sessão não encontrada" }], isError: true }
        const tabId = (args as Record<string, string>).tabId
        const page = session.pages.get(tabId)
        if (!page) return { content: [{ type: "text", text: "tabId não encontrado" }], isError: true }
        try {
          await page.bringToFront()
          session.page = page
          return { content: [{ type: "text", text: `Aba ${tabId} ativa` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "close_tab": {
        const session = sessions.get(sessionId)
        if (!session) return { content: [{ type: "text", text: "Sessão não encontrada" }], isError: true }
        const tabId = (args as Record<string, string>).tabId
        const page = session.pages.get(tabId)
        if (!page) return { content: [{ type: "text", text: "tabId não encontrado" }], isError: true }
        try {
          await page.close()
          session.pages.delete(tabId)
          if (session.page === page) {
            session.page = session.context?.pages()[0] || null
          }
          return { content: [{ type: "text", text: `Aba ${tabId} fechada` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "press_key": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const key = (args as Record<string, string>).key
        try {
          await session.page.keyboard.press(key)
          return { content: [{ type: "text", text: `Pressed: ${key}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "type_text": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const selector = (args as Record<string, string>).selector
        const text = (args as Record<string, string>).text
        const delay = ((args as Record<string, number>).delay || 50) as number
        try {
          await session.page.type(selector, text, { delay })
          return { content: [{ type: "text", text: `Digitado em ${selector}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "hover": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const selector = (args as Record<string, string>).selector
        try {
          await session.page.hover(selector)
          return { content: [{ type: "text", text: `Hover em ${selector}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "scroll_to": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const selector = (args as Record<string, string>).selector
        const x = (args as Record<string, number>).x
        const y = (args as Record<string, number>).y
        try {
          if (selector) {
            await session.page.evaluate((sel) => {
              document.querySelector(sel)?.scrollIntoView({ behavior: "smooth" })
            }, selector)
          } else {
            await session.page.evaluate(([px, py]) => window.scrollTo(px, py), [x || 0, y || 0])
          }
          return { content: [{ type: "text", text: `Scrolled` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "select_option": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const selector = (args as Record<string, string>).selector
        const value = (args as Record<string, string>).value
        try {
          await session.page.selectOption(selector, value)
          return { content: [{ type: "text", text: `Selecionado ${value} em ${selector}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "upload_file": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const selector = (args as Record<string, string>).selector
        const filePath = (args as Record<string, string>).filePath
        try {
          await session.page.setInputFiles(selector, filePath)
          return { content: [{ type: "text", text: `Upload: ${filePath}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "download_file": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const selector = (args as Record<string, string>).selector
        const savePath = (args as Record<string, string>).savePath
        try {
          const [download] = await Promise.all([
            session.page.waitForEvent("download"),
            session.page.click(selector),
          ])
          await download.saveAs(savePath)
          return { content: [{ type: "text", text: `Baixado em ${savePath}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "save_pdf": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const path = (args as Record<string, string>).path
        const format = ((args as Record<string, string>).format || "A4") as any
        try {
          await session.page.pdf({ path, format })
          return { content: [{ type: "text", text: `PDF salvo em ${path}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)} (PDF só funciona em headless)` }], isError: true }
        }
      }

      case "get_html": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        try {
          const html = await session.page.content()
          return { content: [{ type: "text", text: html }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "get_text": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        try {
          const text = await session.page.evaluate(() => document.body.innerText)
          return { content: [{ type: "text", text }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "find_by_text": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const text = (args as Record<string, string>).text
        const regex = (args as Record<string, boolean>).regex || false
        try {
          const result = await session.page.evaluate(
            ([searchText, isRegex]: [string, boolean]) => {
              const matches: string[] = []
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
              let node
              while ((node = walker.nextNode())) {
                const content = node.textContent || ""
                const matched = isRegex ? new RegExp(searchText).test(content) : content.includes(searchText)
                if (matched && node.parentElement) {
                  matches.push(node.parentElement.outerHTML.substring(0, 200))
                }
                if (matches.length >= 10) break
              }
              return matches
            },
            [text, regex] as [string, boolean]
          )
          return { content: [{ type: "text", text: `Found ${result.length}:\n${result.join("\n---\n")}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "get_full_network": {
        const session = sessions.get(sessionId)
        if (!session) return { content: [{ type: "text", text: "Sessão não encontrada" }], isError: true }
        const urlPattern = (args as Record<string, string>).urlPattern
        let records = session.networkRecords
        if (urlPattern) {
          const re = new RegExp(urlPattern)
          records = records.filter((r) => re.test(r.url))
        }
        return { content: [{ type: "text", text: JSON.stringify({ count: records.length, records }, null, 2) }] }
      }

      case "get_response_body": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const urlContains = (args as Record<string, string>).urlContains
        try {
          const response = await session.page.waitForResponse((r) => r.url().includes(urlContains), { timeout: 10000 })
          const body = await response.text()
          return { content: [{ type: "text", text: body }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "cdp_command": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const method = (args as Record<string, string>).method
        const params = (args as Record<string, any>).params || {}
        try {
          if (!session.cdpSession) {
            session.cdpSession = await session.page.context().newCDPSession(session.page)
          }
          const result = await session.cdpSession.send(method, params)
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "stealth_inject": {
        const session = sessions.get(sessionId)
        if (!session) return { content: [{ type: "text", text: "Sessão não encontrada" }], isError: true }
        try {
          if (!session.context) {
            if (session.browser) {
              const ctx = session.browser.contexts()[0] || (await session.browser.newContext())
              session.context = ctx
            } else {
              return { content: [{ type: "text", text: "Sem browser conectado" }], isError: true }
            }
          }
          await session.context.addInitScript(() => {
            try { delete (Navigator.prototype as any).webdriver } catch {}
            try {
              const fakePlugins = Object.create(PluginArray.prototype)
              const items = [
                { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format" },
              ]
              items.forEach((p, i) => { (fakePlugins as any)[i] = p; (fakePlugins as any)[p.name] = p })
              Object.defineProperty(fakePlugins, "length", { get: () => items.length })
              Object.defineProperty(Navigator.prototype, "plugins", { get: () => fakePlugins, configurable: true })
            } catch {}
            try { Object.defineProperty(Navigator.prototype, "languages", { get: () => ["pt-BR", "pt", "en-US", "en"], configurable: true }) } catch {}
            try { Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: () => 8, configurable: true }) } catch {}
            try { Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => 8, configurable: true }) } catch {}
            ;(window as any).chrome = (window as any).chrome || { runtime: {}, app: { isInstalled: false }, csi: () => {}, loadTimes: () => {} }
            try {
              const origQuery = (window.navigator.permissions as any).query.bind(window.navigator.permissions)
              ;(window.navigator.permissions as any).query = (params: any) =>
                params && params.name === "notifications"
                  ? Promise.resolve({ state: Notification.permission })
                  : origQuery(params)
            } catch {}
          })
          return { content: [{ type: "text", text: "Stealth injetado (webdriver removido do prototype, plugins PluginArray real, permissions consistentes)" }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "start_video": {
        const session = sessions.get(sessionId)
        const path = (args as Record<string, string>).path
        if (!session) return { content: [{ type: "text", text: "Sessão não encontrada" }], isError: true }
        session.videoPath = path
        return {
          content: [{ type: "text", text: `Video path setado: ${path}. AVISO: vídeo precisa ser configurado no launch_browser. Use 'recordVideo' nas opções.` }],
        }
      }

      case "stop_video": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        try {
          const video = session.page.video()
          if (!video) return { content: [{ type: "text", text: "Video não estava sendo gravado" }], isError: true }
          await session.page.close()
          const finalPath = await video.path()
          return { content: [{ type: "text", text: `Video salvo: ${finalPath}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "emulate_device": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const device = (args as Record<string, string>).device
        const presets: Record<string, any> = {
          "iPhone 13": { viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1", deviceScaleFactor: 3, isMobile: true, hasTouch: true },
          "iPhone 14 Pro": { viewport: { width: 393, height: 852 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1", deviceScaleFactor: 3, isMobile: true, hasTouch: true },
          "Pixel 7": { viewport: { width: 412, height: 915 }, userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Mobile Safari/537.36", deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
          "iPad Pro": { viewport: { width: 1024, height: 1366 }, userAgent: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1", deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        }
        const preset = presets[device]
        if (!preset) return { content: [{ type: "text", text: `Device desconhecido. Use: ${Object.keys(presets).join(", ")}` }], isError: true }
        try {
          await session.page.setViewportSize(preset.viewport)
          await session.page.setExtraHTTPHeaders({ "User-Agent": preset.userAgent })
          return { content: [{ type: "text", text: `Emulando ${device}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "drag_drop": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const sourceSelector = (args as Record<string, string>).sourceSelector
        const targetSelector = (args as Record<string, string>).targetSelector
        try {
          await session.page.dragAndDrop(sourceSelector, targetSelector)
          return { content: [{ type: "text", text: `Drag ${sourceSelector} → ${targetSelector}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "wait_for_response": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const urlPattern = (args as Record<string, string>).urlPattern
        const timeout = ((args as Record<string, number>).timeout || 10000) as number
        try {
          const re = new RegExp(urlPattern)
          const response = await session.page.waitForResponse((r) => re.test(r.url()), { timeout })
          return { content: [{ type: "text", text: `Response: ${response.status()} ${response.url()}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "wait_for_navigation": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        const waitUntil = ((args as Record<string, string>).waitUntil || "load") as any
        const timeout = ((args as Record<string, number>).timeout || 30000) as number
        try {
          await session.page.waitForLoadState(waitUntil, { timeout })
          return { content: [{ type: "text", text: `Navegação completa: ${session.page.url()}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "go_back": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        try {
          await session.page.goBack()
          return { content: [{ type: "text", text: `Back: ${session.page.url()}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "go_forward": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        try {
          await session.page.goForward()
          return { content: [{ type: "text", text: `Forward: ${session.page.url()}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "reload": {
        const session = sessions.get(sessionId)
        if (!session?.page) return { content: [{ type: "text", text: "Sem página" }], isError: true }
        try {
          await session.page.reload()
          return { content: [{ type: "text", text: `Reloaded: ${session.page.url()}` }] }
        } catch (e) {
          return { content: [{ type: "text", text: `Erro: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
        }
      }

      case "list_endpoints": {
        const records = readJsonl<any>(sessionId, "network.jsonl").filter((r) => r.phase === "request")
        const hostPattern = (args as Record<string, string>).hostPattern
        const groupBy = ((args as Record<string, string>).groupBy || "host+path") as string
        const re = hostPattern ? new RegExp(hostPattern) : null
        const counts: Record<string, number> = {}
        for (const r of records) {
          let url: URL
          try { url = new URL(r.url) } catch { continue }
          if (re && !re.test(url.host)) continue
          let key = ""
          if (groupBy === "host") key = url.host
          else if (groupBy === "path") key = url.pathname
          else if (groupBy === "method") key = r.method
          else key = `${r.method} ${url.host}${url.pathname}`
          counts[key] = (counts[key] || 0) + 1
        }
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
        return { content: [{ type: "text", text: JSON.stringify({ total: records.length, unique: sorted.length, top: sorted.slice(0, 100) }, null, 2) }] }
      }

      case "query_network": {
        const all = readJsonl<any>(sessionId, "network.jsonl")
        const urlPattern = (args as Record<string, string>).urlPattern
        const method = (args as Record<string, string>).method
        const statusMin = (args as Record<string, number>).statusMin
        const statusMax = (args as Record<string, number>).statusMax
        const phase = (args as Record<string, string>).phase || "both"
        const limit = ((args as Record<string, number>).limit || 20) as number
        const offset = ((args as Record<string, number>).offset || 0) as number
        const fields = (args as Record<string, string[]>).fields
        const re = urlPattern ? new RegExp(urlPattern) : null
        let filtered = all.filter((r) => {
          if (phase !== "both" && r.phase !== phase) return false
          if (re && !re.test(r.url)) return false
          if (method && r.method !== method) return false
          if (statusMin !== undefined && (r.status === undefined || r.status < statusMin)) return false
          if (statusMax !== undefined && (r.status === undefined || r.status > statusMax)) return false
          return true
        })
        const total = filtered.length
        filtered = filtered.slice(offset, offset + limit)
        if (fields && fields.length) {
          filtered = filtered.map((r) => {
            const out: any = { phase: r.phase, t: r.t || r.timestamp }
            for (const f of fields) if (r[f] !== undefined) out[f] = r[f]
            return out
          })
        }
        return { content: [{ type: "text", text: JSON.stringify({ total, returned: filtered.length, offset, results: filtered }, null, 2) }] }
      }

      case "tail_ws": {
        const all = readJsonl<any>(sessionId, "ws.jsonl")
        const limit = ((args as Record<string, number>).limit || 30) as number
        const urlPattern = (args as Record<string, string>).urlPattern
        const evt = (args as Record<string, string>).evt
        const since = (args as Record<string, number>).since
        const re = urlPattern ? new RegExp(urlPattern) : null
        let filtered = all.filter((r) => {
          if (since && r.t < since) return false
          if (re && !re.test(r.url || "")) return false
          if (evt && evt !== "all" && r.evt !== evt) return false
          return true
        })
        const total = filtered.length
        filtered = filtered.slice(-limit)
        return { content: [{ type: "text", text: JSON.stringify({ total, returned: filtered.length, frames: filtered }, null, 2) }] }
      }

      case "ws_summary": {
        const all = readJsonl<any>(sessionId, "ws.jsonl")
        const byUrl: Record<string, any> = {}
        for (const r of all) {
          const url = r.url || "unknown"
          byUrl[url] = byUrl[url] || { create: 0, send: 0, recv: 0, close: 0, error: 0, firstT: r.t, lastT: r.t }
          byUrl[url][r.evt] = (byUrl[url][r.evt] || 0) + 1
          byUrl[url].lastT = r.t
        }
        return { content: [{ type: "text", text: JSON.stringify({ totalFrames: all.length, urls: byUrl }, null, 2) }] }
      }

      case "session_storage_info": {
        const dir = sessionDir(sessionId)
        const files = ["network.jsonl", "ws.jsonl", "console.jsonl"].map((f) => {
          const path = join(dir, f)
          let size = 0
          let lines = 0
          if (existsSync(path)) {
            const buf = readFileSync(path, "utf8")
            size = buf.length
            lines = buf.split("\n").filter(Boolean).length
          }
          return { file: f, path, size, lines }
        })
        return { content: [{ type: "text", text: JSON.stringify({ dir, files }, null, 2) }] }
      }

      case "clear_session_storage": {
        const session = sessions.get(sessionId)
        const dir = sessionDir(sessionId)
        for (const f of ["network.jsonl", "ws.jsonl", "console.jsonl"]) {
          try { writeFileSync(join(dir, f), "") } catch {}
        }
        if (session) {
          session.consoleLogs = []
          session.networkRequests = []
          session.networkRecords = []
        }
        return { content: [{ type: "text", text: `Storage da sessão ${sessionId} limpo` }] }
      }

      case "export_session": {
        const path = (args as Record<string, string>).path || join(sessionDir(sessionId), "export.json")
        const data = {
          sessionId,
          exportedAt: new Date().toISOString(),
          network: readJsonl(sessionId, "network.jsonl"),
          ws: readJsonl(sessionId, "ws.jsonl"),
          console: readJsonl(sessionId, "console.jsonl"),
        }
        writeFileSync(path, JSON.stringify(data, null, 2))
        return { content: [{ type: "text", text: `Exportado: ${path} (${data.network.length} net, ${data.ws.length} ws, ${data.console.length} console)` }] }
      }

      case "close_session": {
        const session = sessions.get(sessionId)
        if (session) {
          for (const page of session.pages.values()) {
            try { await page.close() } catch {}
          }
          if (session.page) {
            try { await session.page.close() } catch {}
          }
          if (session.context && !session.browser) {
            try { await session.context.close() } catch {}
          }
          if (session.browser) {
            try { await session.browser.close() } catch {}
          }
          if (session.lockRelease) {
            try { session.lockRelease() } catch {}
          }
        }
        sessions.delete(sessionId)
        return {
          content: [
            {
              type: "text",
              text: `Sessão ${sessionId} fechada`,
            },
          ],
        }
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Tool ${name} desconhecida`,
            },
          ],
          isError: true,
        }
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Erro fatal: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
server.connect(transport)

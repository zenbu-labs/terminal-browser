/* @jsx h */
import type { EngineInterface, Register, RenderInput, StateWrite } from 'claude-code'
import type { Browser } from './browser'
import { MAX_IMAGE_CELLS } from './surface.tsx'
import { normalizeUrl } from './urls.ts'
import { fillSlot, isScrollIn, offerChoice, placementIn, readPlacement, readShownTab, scrollsKey } from './pane-grid.ts'
import {
  isBridgeState,
  isInputMessage,
  isLaunchReport,
  isSizeMessage,
  takenItems,
  type BridgeState,
  type Frame,
} from './bridge-protocol.ts'



const PANE = 'browser'
// the name in .claude-plugin/plugin.json, which pane-grid keys this plugin's cell by
const PLUGIN = 'terminal-browser'
const IMAGE_KEY = 'view'
const IMAGE_ALT = ''
const OPEN_TOOL = 'mcp__terminal-browser__open'
const CLOSE_TOOL = 'mcp__terminal-browser__close'
const START_URL = 'terminal-browser://start'
const INSTALL_URL = 'https://terminal-browser.sh'
const REQUIRED_CAPABILITIES = ['embedding', 'image-frames']
const WATCH_RETRY_MS = 250
const DENIED_REDRAW_MS = 500
const DENIALS_BEFORE_LOGGING = 3


const state = {
  port: null as number | null,
  token: null as string | null,
  open: false,
  pendingUrl: null as string | null,
  region: null as { cols: number; rows: number } | null,
  last: null as BridgeState | null,
  frame: null as Frame | null,
  mounted: null as { cols: number; rows: number } | null,
  watcher: 0,
  // a hack to programatically trigger agent input focus
  viewGeneration: 0,
}

const bridgeUrl = (path: string) => `http://127.0.0.1:${state.port}${path}`
const authHeaders = () => ({ authorization: `Bearer ${state.token}` })
const viewKey = () => `view${state.viewGeneration}`


async function terminalBrowserCommand($: EngineInterface): Promise<string[]> {
  const checkoutCli = `${$.plugin.root}/../cli/dist/main.js`
  if (await $.fs.exists(checkoutCli)) return ['node', checkoutCli] // dev case
  return ['terminal-browser']
}

async function checkCapabilities($: EngineInterface, command: string[]): Promise<{ ok: true } | { ok: false; installed: boolean }> {
  let result: { stdout: string; exitCode: number }
  try {
    result = await $.process.run([...command, 'capabilities'], { timeoutMs: 10_000 })
  } catch {
    return { ok: false, installed: false }
  }
  let capabilities: string[] = []
  if (result.exitCode === 0) {
    const line = result.stdout.split('\n').find((text: string) => text.startsWith('{'))
    try {
      const parsed = line ? JSON.parse(line) : null
      if (parsed && Array.isArray(parsed.capabilities)) capabilities = parsed.capabilities
    } catch {}
  }
  const ok = REQUIRED_CAPABILITIES.every(need => capabilities.includes(need))
  return ok ? { ok: true } : { ok: false, installed: true }
}

async function startBridge($: EngineInterface): Promise<{ ok: true } | { ok: false; error: string }> {
  const command = await terminalBrowserCommand($)
  const check = await checkCapabilities($, command)
  if (!check.ok) {
    return {
      ok: false,
      error: check.installed
        ? 'Newer terminal-browser version required, run terminal-browser upgrade'
        : `Please install terminal-browser first - ${INSTALL_URL}`,
    }
  }
  let report: unknown = null
  try {
    const { stdout, stderr, exitCode } = await $.process.run([...command, 'claude-bridge', 'launch'], { timeoutMs: 20_000 })
    const line = stdout.split('\n').find((text: string) => text.startsWith('{'))
    report = line ? JSON.parse(line) : { error: stderr.trim() || `exit ${exitCode}`, code: 'start' }
  } catch (err) {
    report = { error: String(err), code: 'start' }
  }
  if (!isLaunchReport(report) || !('port' in report)) {
    const detail = isLaunchReport(report) && 'error' in report ? report.error : 'terminal-browser could not start'
    return { ok: false, error: `${detail}` }
  }
  state.port = report.port
  state.token = report.token
  void watchBridge($)
  return { ok: true }
}

async function post($: EngineInterface, path: string, body: unknown): Promise<unknown> {
  if (state.port === null) return null
  try {
    const response = await $.http.fetch(bridgeUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    })
    return response.ok ? JSON.parse(response.text || '{}') : null
  } catch {
    return null
  }
}

async function fetchState($: EngineInterface, version: number): Promise<BridgeState | null> {
  if (state.port === null) return null
  try {
    const response = await $.http.fetch(bridgeUrl(`/state?version=${version}`), { headers: authHeaders() })
    const parsed: unknown = response.ok ? JSON.parse(response.text) : null
    return isBridgeState(parsed) ? parsed : null
  } catch {
    return null
  }
}


function imageSource(frame: Frame) {
  return { shm: frame.shm, format: frame.format, width: frame.width, height: frame.height, generation: frame.generation }
}

function imageGrid(frame: Frame, cols: number, rows: number) {
  return {
    cols: Math.max(1, Math.min(frame.cols, cols, MAX_IMAGE_CELLS)),
    rows: Math.max(1, Math.min(frame.rows, rows, MAX_IMAGE_CELLS)),
  }
}

function fitsMounted(frame: Frame): boolean {
  const mounted = state.mounted
  if (!mounted || !state.region) return false
  const grid = imageGrid(frame, state.region.cols, state.region.rows)
  return grid.cols === mounted.cols && grid.rows === mounted.rows
}

type TerminalPane = RenderInput<'Pane', 'terminal'>

function paneSize(e: TerminalPane) {
  const rows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : Math.max(8, (e.viewport?.rows ?? 30) - 8)
  const cols = Math.max(1, e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 80))
  return { cols, rows }
}

// draws the browser cols by rows, in its own pane or in a pane-grid cell
async function drawBrowser($: EngineInterface, e: TerminalPane, cols: number, rows: number) {
  const { Box, Client, Image } = await $.ui.resolve(e)
  const frame = state.frame
  const grid = frame ? imageGrid(frame, cols, rows) : null
  state.mounted = grid
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {frame && grid ? (
        <Image key={IMAGE_KEY} source={imageSource(frame)} columns={grid.cols} rows={grid.rows} alt={IMAGE_ALT} />
      ) : null}
      <Box position="absolute" top={0} left={0} width={cols} height={rows}>
        <Client key={viewKey()} module="./surface.tsx" width={cols} height={rows} />
      </Box>
    </Box>
  )
}

async function watchBridge($: EngineInterface): Promise<void> {
  const watcher = ++state.watcher
  const live = () => state.watcher === watcher && state.port !== null
  let version = -1
  let denials = 0
  let lastDeniedRedraw = 0
  while (live()) {
    const fresh = await fetchState($, version)
    if (!live()) return
    if (!fresh) {
      await $.clock.sleep(WATCH_RETRY_MS)
      continue
    }
    version = fresh.version
    const previous = state.last
    state.last = fresh
    if (fresh.inbox > 0) await deliverAgentText($)
    if (!state.open) continue
    // in a pane-grid cell the Image is drawn in the grid pane, not in this plugin's own pane
    const placement = await readPlacement($, PLUGIN)
    const pictureGone = fresh.frame === null && state.frame !== null
    if (pictureGone) state.frame = null
    const paneChanged =
      !previous
      || pictureGone
      || previous.title !== fresh.title
      || previous.alive !== fresh.alive
      || previous.error !== fresh.error
    if (paneChanged) {
      $.ui.invalidate('ui.render')
      if (fresh.title && !placement) await $.ui.open({ id: PANE, title: fresh.title.slice(0, 40) })
    }
    const frame = fresh.frame
    if (!frame || frame.generation === state.frame?.generation) continue
    state.frame = frame
    // a hidden grid tab mounts no Image; the shown hook draws the last frame when the tab is shown again
    if (placement && await readShownTab($) !== placement.tab) continue
    if (!fitsMounted(frame)) {
      $.ui.invalidate('ui.render')
      continue
    }
    const result = await $.ui.blit({ requestId: placement ? placement.requestId : PANE, key: IMAGE_KEY, source: imageSource(frame) })
    if (!result.deny) {
      denials = 0
      continue
    }
    denials += 1
    if (denials === DENIALS_BEFORE_LOGGING) $.ui.log(`terminal-browser: frame blit refused: ${result.deny}`)
    const now = Date.now()
    if (now - lastDeniedRedraw >= DENIED_REDRAW_MS) {
      lastDeniedRedraw = now
      $.ui.invalidate('ui.render')
    }
  }
}

async function openBrowser($: EngineInterface, raw: string | null): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (state.port === null) {
    const started = await startBridge($)
    if (!started.ok) return started
  }
  const alive = state.last?.alive === true
  const url = raw ? normalizeUrl(raw) : (alive && state.last?.url ? state.last.url : START_URL)
  state.pendingUrl = url
  state.open = true
  // while placed in a pane-grid cell the browser is drawn there instead
  if (!(await readPlacement($, PLUGIN))) await $.ui.open({ id: PANE, title: 'browser', focus: true, rows: 24 })
  $.ui.invalidate('ui.render')
  if (state.region) {
    state.pendingUrl = null
    await post($, '/open', { url, ...state.region })
  }
  return { ok: true, url }
}

async function closeBrowser($: EngineInterface): Promise<boolean> {
  if (!state.open) return false
  if (await readPlacement($, PLUGIN)) {
    // no pane of its own to close: the pane-grid cell goes back to its hint
    await browserClosed($)
    $.ui.invalidate('ui.render')
    return true
  }
  await $.ui.close({ id: PANE })
  return true
}

// Moves the open browser between its own pane and its pane-grid cell; the browser keeps running.
// The pane opens again only when the cell was removed while the browser was open, so a closed browser stays closed.
async function placeOwnPane($: EngineInterface, layout: unknown, previous: unknown): Promise<void> {
  const isPlaced = placementIn(layout, PLUGIN) !== undefined
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isPlaced && isOpen) {
    await $.ui.close({ id: PANE })
    return
  }
  if (isPlaced || isOpen || !state.open || placementIn(previous, PLUGIN) === undefined) return
  await $.ui.open({ id: PANE, title: state.last?.title ? state.last.title.slice(0, 40) : 'browser', rows: 24 })
  $.ui.invalidate('ui.render')
}

async function browserClosed($: EngineInterface): Promise<void> {
  state.open = false
  state.pendingUrl = null
  state.region = null
  state.frame = null
  state.mounted = null
  await post($, '/browser/close', {})
}

async function deliverAgentText($: EngineInterface): Promise<void> {
  const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  const lines = takenItems(await post($, '/inbox/take', {}))
    .filter(item => item.text.trim() !== '')
    .flatMap(item => [oneLine(item.text), ...(item.screenshot ? [oneLine(item.screenshot)] : [])])
  if (lines.length === 0) return
  const { isFilled } = await $.prompt.fill({ text: `${lines.join('\n')}\n` })
  if (!isFilled) {
    // would need to see a case this happens before shipping
    // $.ui.toast('copied to clipboard')
    return
  }
  state.viewGeneration += 1
  $.ui.invalidate('ui.render')
}


export const register: Register = (on, options) => {
  const agentToolEnabled = options.agentTool === true

// this is a hack because the plugin api does not allow $ or the result of next to be passed to functions
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    const servedByHooks = () => { throw new Error('the browser noun is served by its hooks') }
    const browser: Browser = { open: servedByHooks, close: servedByHooks }
    return { ...built, browser }
  })

  on('browser.open', async ($, e) => {
    const opened = await openBrowser($, e.url ?? null)
    return { value: opened }
  })

  on('browser.close', async ($) => {
    return { value: await closeBrowser($) }
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    let surfaces: readonly string[] = []
    try {
      surfaces = await $.session.surfaces()
    } catch {}
    if (!surfaces.includes('terminal')) return r
    await $.command.register({
      name: 'browser',
      description: 'Open a browser to the right',
      argumentHint: '[url]',
      immediate: true,
    }).catch(err => $.ui.log(`terminal-browser: /browser not registered: ${err}`))
    if (agentToolEnabled) {
      await $.tool.register({
        name: 'open',
        description: 'Open terminal-browser directly inside claude code. Control the open page with the terminal-browser action CLI.',
        inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The page to open, as a full url or a host name' } } },
      }).catch(err => $.ui.log(`terminal-browser: open tool not registered: ${err}`))
      await $.tool.register({ name: 'close', description: 'Close the terminal-browser pane.' }).catch(err => $.ui.log(`terminal-browser: close tool not registered: ${err}`))
    }
    return r
  })

  on('command.run', { command: 'browser' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close' || (!arg && state.open)) {
      await closeBrowser($)
      return { text: 'Closed terminal-browser' }
    }
    const opened = await openBrowser($, arg || null)
    if (!opened.ok) return { text: opened.error }
    const placement = await readPlacement($, PLUGIN)
    return { text: placement ? `Opened terminal-browser in pane-grid cell ${placement.cell} of ${placement.tab}` : 'Opened terminal-browser' }
  })

  on('tool.call', { tool: new RegExp(`^${OPEN_TOOL}$`) }, async ($, e) => {
    const url = (e as { url?: unknown }).url
    const opened = await openBrowser($, typeof url === 'string' ? url : null)
    if (!opened.ok) return { deny: `could not open the browser: ${opened.error}` }
    return { result: [{ type: 'text', text: `opened ${opened.url} ` }] }
  })

  on('tool.call', { tool: new RegExp(`^${CLOSE_TOOL}$`) }, async ($) => {
    const closed = await closeBrowser($)
    return { result: [{ type: 'text', text: closed ? 'browser pane closed' : 'no browser pane was open (maybe the user closed it?)' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Box } = await $.ui.resolve(e)
      return <Box />
    }
    const { cols, rows } = paneSize(e)
    return drawBrowser($, e, cols, rows)
  })

  // the browser in a pane-grid cell: https://github.com/hwanyong/pane-grid/blob/main/docs/add-pane-grid-cell.md
  // plugin: 'pane-grid' because Claude Code 2.1.325 fills a missing plugin with this plugin's name, and pane-grid opens every grid pane
  on('ui.render', { component: 'Pane', requestId: /^grid-/, plugin: 'pane-grid' }, async ($, e, next) => {
    const placement = await readPlacement($, PLUGIN)
    const below = await next(e)
    const { Box, Button, Text } = await $.ui.resolve(e)
    const offered = offerChoice(below, PLUGIN, placement, choice => <Button key={choice.key} plain label={choice.label} hotkey={choice.hotkey} onPress={() => {}} />)
    if (!placement || placement.requestId !== e.requestId) return offered
    let content
    if (e.surface !== 'terminal') content = <Box />
    else if (!state.open) content = <Text dimColor>Run /browser [url] to open a page here</Text>
    else {
      const size = paneSize(e)
      const cols = Math.max(1, placement.columns > 0 ? placement.columns : size.cols)
      const rows = Math.max(1, placement.rows > 0 ? placement.rows : size.rows)
      content = await drawBrowser($, e, cols, rows)
    }
    const cell = (
      <Box key={`cell:${PLUGIN}`} flexDirection="column">
        <Box key={scrollsKey(PLUGIN)} />
        {content}
      </Box>
    )
    return fillSlot(offered, PLUGIN, cell) ?? <Box flexDirection="column">{offered}{cell}</Box>
  })

  on('state.set', { plugin: 'pane-grid' as never, key: 'layout' as never }, async ($, e, next) => {
    const write = e as StateWrite
    const result = await next(e)
    await placeOwnPane($, write.value, write.previous)
    return result
  })

  on('state.set', { plugin: 'pane-grid' as never, key: 'shown' as never }, async ($, e, next) => {
    const write = e as StateWrite
    const result = await next(e)
    const placement = await readPlacement($, PLUGIN)
    // frames are not blitted while the cell's grid tab is hidden: draw the last one now that it shows
    if (state.open && placement && write.value === placement.tab) $.ui.invalidate('ui.render')
    return result
  })

  on('ui.message', async ($, e, next) => {
    const isOurs = e.requestId === PANE || e.requestId === (await readPlacement($, PLUGIN))?.requestId
    if (!isOurs || state.port === null) return next(e)
    if (isSizeMessage(e.data)) {
      state.region = { cols: e.data.cols, rows: e.data.rows }
      if (state.pendingUrl) {
        const url = state.pendingUrl
        state.pendingUrl = null
        await post($, '/open', { url, ...state.region })
      } else {
        await post($, '/size', state.region)
      }
    } else if (isInputMessage(e.data)) {
      await post($, '/input', { events: e.data.events })
    }
    return next(e)
  })

  on('ui.scroll', { requestId: [PANE, /^grid-/] }, async ($, e, next) => {
    const placement = e.requestId === PANE ? undefined : await readPlacement($, PLUGIN)
    if (e.requestId !== PANE && !isScrollIn(placement, e)) return next(e)
    if (state.port === null || !state.open || e.by === 0) return {}
    const kind = e.by < 0 ? 'scrollup' : 'scrolldown'
    const ticks = Math.min(Math.round(Math.abs(e.by)) || 1, 10)
    // in a cell the pointer counts from the grid pane's body; the browser counts from the cell
    const x = e.pointer ? e.pointer.column - (placement?.column ?? 0) : Math.floor((state.region?.cols ?? 0) / 2)
    const y = e.pointer ? e.pointer.row - (placement?.row ?? 0) : Math.floor((state.region?.rows ?? 0) / 2)
    const events = Array.from({ length: ticks }, () => ({ type: 'mouse', kind, x, y }))
    await post($, '/input', { events })
    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    // the pane closes for a pane-grid cell: the browser goes on there
    if (!(await readPlacement($, PLUGIN))) await browserClosed($)
    return r
  })
}

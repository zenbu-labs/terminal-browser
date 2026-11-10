import type { EngineInterface, RenderElement, RenderNode, UiScrollInput } from 'claude-code'

// pane-grid reading module. Copy this file to <your mod>/hooks/pane-grid.ts unchanged.
// Source: https://github.com/hwanyong/pane-grid/blob/main/skills/add-pane-grid-cell/pane-grid.ts
// Guide: https://github.com/hwanyong/pane-grid/blob/main/docs/add-pane-grid-cell.md
//
// pane-grid's state types live in the pane-grid repository only, so this module checks the values it reads at run time.
// When pane-grid is not installed every read is undefined and your mod keeps drawing in its own pane or band.
//
// Load order does not matter. When your mod loads after pane-grid, next(e) holds nothing of pane-grid's and your
// `cell:<plugin>` Box goes after it, where pane-grid collects it. When your mod loads before pane-grid, next(e) holds
// pane-grid's drawing: fillSlot puts your cell into the `slot:<plugin>` Box pane-grid drew for it, and offerChoice adds
// your Button to each empty cell's `choices:<cell>` Box. pane-grid's ui.press hook answers that Button by its key.

const GRID_LAYOUT = { plugin: 'pane-grid', key: 'layout' } as const
const GRID_SHOWN = { plugin: 'pane-grid', key: 'shown' } as const
const GRID_VERSION = 1
const SLOT_KEY = 'slot:'
const CHOICES_KEY = 'choices:'
const ACTIVE_SUFFIX = ':active'
const NONE_KEY = 'none:'
const PLACE_KEY = 'place:'
const SCROLLS_KEY = 'scrolls:'
// Empty-cell choices take hotkeys 1-9 in the active cell only.
const CHOICE_HOTKEYS = 9

// tab: the layout holding the cell. requestId: that layout's grid pane id (`grid-<tab>`).
// columns and rows: the size to draw in. Both are 0 until pane-grid has measured the pane.
// column and row: the top left of that area in the grid pane's body, as `UiScrollPointer` counts. isActive: the cell
// is the active or the zoomed one. pane-grid writes these three from 0.4.0; they are undefined before.
type GridPlacement = { tab: string; requestId: string; cell: string; columns: number; rows: number; column?: number; row?: number; isActive?: boolean }

const isPlacement = (value: unknown): value is GridPlacement => {
  if (typeof value != 'object' || value == null) return false
  const placement = value as Record<string, unknown>
  return typeof placement.tab == 'string' && typeof placement.requestId == 'string'
    && typeof placement.columns == 'number' && typeof placement.rows == 'number'
}

// Finds this mod's cell in a pane-grid layout value. Also used on a `state.set` hook's `value` and `previous`.
export const placementIn = (layout: unknown, plugin: string): GridPlacement | undefined => {
  if (typeof layout != 'object' || layout == null) return undefined
  const { version, placed } = layout as { version?: unknown; placed?: unknown }
  if (version != GRID_VERSION || typeof placed != 'object' || placed == null) return undefined
  const placement = (placed as Record<string, unknown>)[plugin]
  return isPlacement(placement) ? placement : undefined
}

// The two functions below are function declarations, not arrow functions:
// `claude plugin validate` follows `$` across an import only through function declarations.

// This mod's cell. Called while drawing, the drawing is redrawn when pane-grid changes the layout.
export async function readPlacement($: EngineInterface, plugin: string): Promise<GridPlacement | undefined> {
  const read = await $.state.get(GRID_LAYOUT as never) as { value?: unknown }
  return placementIn(read.value, plugin)
}

// The name of the grid layout on screen; null when no grid pane is shown or pane-grid is not installed.
// Only a mod that runs timers (an animation, polling) needs it. Delete it otherwise.
export async function readShownTab($: EngineInterface): Promise<string | null> {
  const read = await $.state.get(GRID_SHOWN as never) as { value?: unknown }
  return typeof read.value == 'string' ? read.value : null
}

// What offerChoice hands your Button maker: draw `<Button key={choice.key} plain label={choice.label} hotkey={choice.hotkey} onPress={() => {}} />`.
// The press is pane-grid's to answer (its ui.press hook reads the key), so onPress does nothing.
type GridChoice = { key: string; label: string; hotkey?: string }

const keyOf = (node: RenderNode) => {
  if (typeof node == 'string') return undefined
  const props: Record<string, unknown> | undefined = 'props' in node ? node.props : undefined
  const key = props?.key
  return typeof key == 'string' ? key : undefined
}

const childrenOf = (node: RenderElement): readonly RenderNode[] => ('children' in node && Array.isArray(node.children) ? node.children : [])

// Copies the tree only along the path to each node `change` replaces; the drawing next(e) handed you is frozen.
const rewrite = (element: RenderElement, change: (element: RenderElement) => RenderElement | undefined): RenderElement => {
  const changed = change(element)
  if (changed) return changed
  const children = childrenOf(element)
  const rewritten = children.map(child => (typeof child == 'string' ? child : rewrite(child, change)))
  return rewritten.every((child, index) => child === children[index]) ? element : ({ ...element, children: rewritten } as RenderElement)
}

// Puts `cell` into the slot pane-grid drew for this mod. undefined when next(e) holds no such slot (your mod loads
// after pane-grid, so pane-grid has not drawn yet): append the cell after next(e) instead, keyed `cell:<plugin>`.
export const fillSlot = (below: RenderElement, plugin: string, cell: RenderElement): RenderElement | undefined => {
  let isFilled = false
  const filled = rewrite(below, element => {
    if (keyOf(element) != `${SLOT_KEY}${plugin}`) return undefined
    isFilled = true
    return { ...element, children: [cell] } as RenderElement
  })
  return isFilled ? filled : undefined
}

// Adds this mod's Button to every empty cell's choices pane-grid drew. Unchanged when next(e) holds none.
// `placement` is this mod's current cell, if any: the label then says the press moves it from there.
export const offerChoice = (below: RenderElement, plugin: string, placement: GridPlacement | undefined, makeButton: (choice: GridChoice) => RenderElement): RenderElement =>
  rewrite(below, element => {
    const key = keyOf(element)
    if (!key?.startsWith(CHOICES_KEY)) return undefined
    const isActive = key.endsWith(ACTIVE_SUFFIX)
    const cell = key.slice(CHOICES_KEY.length, isActive ? -ACTIVE_SUFFIX.length : undefined)
    const choiceKey = `${PLACE_KEY}${cell}:${plugin}`
    const children = childrenOf(element).filter(child => !keyOf(child)?.startsWith(NONE_KEY))
    if (children.some(child => keyOf(child) == choiceKey)) return undefined
    const count = children.filter(child => keyOf(child)?.startsWith(PLACE_KEY)).length
    const hotkey = isActive && count < CHOICE_HOTKEYS ? String(count + 1) : undefined
    const label = placement ? `${plugin} (move from ${placement.cell})` : plugin
    return { ...element, children: [...children, makeButton({ key: choiceKey, label, hotkey })] } as RenderElement
  })

// A mod that scrolls its own rows in the cell draws an empty Box with this key inside its `cell:<plugin>` Box. pane-grid
// then hands that cell's `ui.scroll` to your hook instead of moving the cell itself. Without the Box pane-grid moves it.
export const scrollsKey = (plugin: string) => `${SCROLLS_KEY}${plugin}`

// Whether a `ui.scroll` on a grid pane is for this mod's cell: the wheel over the cell's area, or a scroll key while the
// cell is the active one. The row in your cell is `e.pointer.row - placement.row`. false with pane-grid before 0.4.0.
// Answer it without next(e), as `ui.scroll` documents for a hook drawing its own rows; call next(e) for every other event.
export const isScrollIn = (placement: GridPlacement | undefined, e: UiScrollInput): boolean => {
  if (!placement || placement.requestId != e.requestId || placement.column == undefined || placement.row == undefined) return false
  if (!e.pointer) return placement.isActive == true
  const { column, row } = e.pointer
  return column >= placement.column && column < placement.column + placement.columns && row >= placement.row && row < placement.row + placement.rows
}

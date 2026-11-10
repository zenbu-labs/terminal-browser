// we cannot use libraries inside the claude code sandbox, hence this gross code


export type Frame = {
  shm: string
  format: 'rgba' | 'rgb'
  width: number
  height: number
  generation: number
  cols: number
  rows: number
}

export type BridgeState = {
  version: number
  frame: Frame | null
  title: string
  url: string | null
  alive: boolean
  error: string | null
  inbox: number
}

export type LaunchReport =
  | { port: number; token: string }
  | { error: string; code: 'tty' | 'start' }

export type SizeMessage = { type: 'size'; cols: number; rows: number }
export type InputMessage = { type: 'input'; events: unknown[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const isFrame = (value: unknown): value is Frame =>
  isRecord(value)
  && typeof value.shm === 'string'
  && (value.format === 'rgba' || value.format === 'rgb')
  && Number.isInteger(value.width)
  && Number.isInteger(value.height)
  && Number.isInteger(value.generation)
  && Number.isInteger(value.cols)
  && Number.isInteger(value.rows)

export const isBridgeState = (value: unknown): value is BridgeState =>
  isRecord(value)
  && Number.isInteger(value.version)
  && typeof value.alive === 'boolean'
  && 'frame' in value
  && (value.frame === null || isFrame(value.frame))

export const isLaunchReport = (value: unknown): value is LaunchReport =>
  isRecord(value) && (typeof value.port === 'number' || typeof value.error === 'string')

export const isSizeMessage = (data: unknown): data is SizeMessage =>
  isRecord(data) && data.type === 'size' && Number.isInteger(data.cols) && Number.isInteger(data.rows)

export const isInputMessage = (data: unknown): data is InputMessage =>
  isRecord(data) && data.type === 'input' && Array.isArray(data.events)

export type AgentText = { text: string; screenshot: string | null }

const isAgentText = (value: unknown): value is AgentText =>
  isRecord(value) && typeof value.text === 'string' && (value.screenshot === null || typeof value.screenshot === 'string')

export const takenItems = (value: unknown): AgentText[] =>
  isRecord(value) && Array.isArray(value.items) ? value.items.filter(isAgentText) : []

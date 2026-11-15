import { SEED_ROWS } from './seed'
import type { EntryRow, GovernanceState } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'lake-govern-config:entries'

type StoredDocument = {
  modules: Record<string, EntryRow[]>
  governance: GovernanceState
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function emptyGovernance(): GovernanceState {
  return { disposals: {}, alerts: {}, hits: [], lastSignatures: {} }
}

function normalizeGovernance(value: unknown): GovernanceState {
  const fallback = emptyGovernance()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback
  }
  const parsed = value as Partial<GovernanceState>
  // 老版本缺失字段时逐项兜底，避免裁决页读到 undefined。
  return {
    disposals: parsed.disposals ?? {},
    alerts: parsed.alerts ?? {},
    hits: Array.isArray(parsed.hits) ? parsed.hits : [],
    lastSignatures: parsed.lastSignatures ?? {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析存储文档，兼容两种历史格式：
 * 1. 初始版本直接存 `{ 模块key: EntryRow[] }`；
 * 2. 当前版本存 `{ modules, governance }`，让清单和裁决状态同一次写入。
 */
function parseDocument(raw: string | null): StoredDocument | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) {
      return null
    }
    if (isRecord(parsed.modules)) {
      return {
        modules: parsed.modules as Record<string, EntryRow[]>,
        governance: normalizeGovernance(parsed.governance),
      }
    }
    // 老格式：整个对象就是模块清单。
    return {
      modules: parsed as Record<string, EntryRow[]>,
      governance: emptyGovernance(),
    }
  } catch {
    return null
  }
}

let documentCache: StoredDocument | null = null

function readDocument(): StoredDocument {
  if (documentCache !== null) {
    return documentCache
  }
  const fallbackModules = clone(SEED_ROWS)
  let stored: StoredDocument | null = null
  if (typeof window !== 'undefined' && window.localStorage) {
    stored = parseDocument(window.localStorage.getItem(STORAGE_KEY))
    if (stored === null) {
      // 首次打开或历史数据损坏：写入示例数据。
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        modules: fallbackModules,
        governance: emptyGovernance(),
      }))
    }
  }
  // 种子模块始终保留，历史里缺的模块回落到示例数据。
  documentCache = {
    modules: { ...fallbackModules, ...(stored?.modules ?? {}) },
    governance: stored?.governance ?? emptyGovernance(),
  }
  return documentCache
}

function persist(document: StoredDocument): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    // 单文档写入：清单和裁决状态要么一起成功，要么一起保持旧值。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document))
  }
  // 只有落盘成功后才替换内存缓存；抛错时缓存仍是旧状态。
  documentCache = document
}

export function allRows(): Record<string, EntryRow[]> {
  return readDocument().modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/**
 * 一次性提交业务清单与治理裁决状态。
 * 同一次 setItem 写入，避免「规则清单已变但质量告警没落」的半套状态。
 */
export function saveTransaction(rows: Record<string, EntryRow[]>, governance: GovernanceState): void {
  persist({ modules: rows, governance })
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const current = readDocument()
  persist({ modules: { ...current.modules, [key]: rows }, governance: current.governance })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/* ---------------- 治理裁决状态 ---------------- */

export function readGovernanceState(): GovernanceState {
  return readDocument().governance
}

/** 重置治理规则时同时清空裁决状态，避免旧处置指向已经不存在的规则。 */
export function resetGovernanceState(): void {
  const current = readDocument()
  persist({ modules: current.modules, governance: emptyGovernance() })
}

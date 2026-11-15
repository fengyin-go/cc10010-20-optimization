import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  readGovernanceState,
  resetGovernanceState,
  resetRows,
  saveRows,
  saveTransaction,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  GovernanceBoard,
  GovernanceObjectSummary,
  GovernanceRuleView,
  GovernanceTriggerResult,
  ModuleMeta,
  OverviewResult,
  PageResult,
  QualityAlertRecord,
} from '@/data/types'
import {
  applyConflictDecision,
  buildPriorityLabel,
  isDisposalSnapshotStale,
  isEligibleStatus,
  rankRules,
  scopeRankOf,
  statusRankOf,
  thresholdRankOf,
} from './governance-engine'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  // 治理规则回退到示例数据时，裁决状态也必须一起清空，否则旧处置会指向不存在的规则。
  if (key === 'govern') {
    resetGovernanceState()
    triggerLocks.clear()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

/* ---------------- 湖仓治理：冲突裁决 ---------------- */

/** 每个对象同一时刻只允许一个触发在途，并发触发直接合并成一次。 */
const triggerLocks = new Map<string, Promise<GovernanceTriggerResult>>()

function toRuleView(row: EntryRow): GovernanceRuleView {
  const scope = String(row['影响范围'] ?? '')
  const threshold = String(row['触发阈值'] ?? '')
  const status = String(row.status ?? '')
  return {
    ruleId: Number(row.id),
    ruleNo: String(row['规则编号'] ?? `RULE-${row.id}`),
    ruleType: String(row['治理类型'] ?? ''),
    action: String(row['执行动作'] ?? ''),
    scope,
    threshold,
    status,
    eligible: isEligibleStatus(status) && String(row['治理对象'] ?? '').trim() !== '',
    priorityLabel: buildPriorityLabel(scope, threshold, status),
    priorityRanks: {
      scopeRank: scopeRankOf(scope).rank,
      thresholdRank: thresholdRankOf(threshold).rank,
      thresholdText: threshold,
      statusRank: statusRankOf(status),
    },
  }
}

/** 治理规则 + 裁决状态的只读看板，供湖仓治理页与质量监控页共用。 */
export function loadGovernanceBoard(): GovernanceBoard {
  const state = readGovernanceState()
  const groups = new Map<string, EntryRow[]>()
  for (const row of listRows('govern')) {
    const objectId = String(row['治理对象'] ?? '').trim()
    if (!objectId) {
      continue
    }
    const group = groups.get(objectId)
    if (group) {
      group.push(row)
    } else {
      groups.set(objectId, [row])
    }
  }

  const objects: GovernanceObjectSummary[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([objectId, rows]) => {
      const disposal = state.disposals[objectId]
      return {
        objectId,
        rules: rankRules(rows)
          .map((item) => {
            const row = rows.find((candidate) => Number(candidate.id) === item.ruleId)
            return row ? toRuleView(row) : null
          })
          .filter((item): item is GovernanceRuleView => item !== null),
        disposal,
        disposalStale: disposal ? isDisposalSnapshotStale(disposal, rows) : false,
      }
    })

  return {
    objects,
    hits: [...state.hits].sort((a, b) => b.at.localeCompare(a.at)),
    alerts: Object.values(state.alerts).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)),
  }
}

/**
 * 触发某个治理对象的冲突裁决。
 * 同一对象的并发调用共享同一个 Promise，因此只会执行一次处置。
 */
export function triggerGovernance(objectId: string): Promise<GovernanceTriggerResult> {
  const trimmed = objectId.trim()
  if (!trimmed) {
    return Promise.resolve({
      ok: false,
      duplicate: false,
      message: '请先指定治理对象',
      evaluations: [],
    })
  }
  const inFlight = triggerLocks.get(trimmed)
  if (inFlight) {
    // 同一对象的并发触发合并到同一次执行：不再写入，只把结果回给调用方。
    return inFlight.then((result) =>
      result.ok
        ? { ...result, duplicate: true, message: `${trimmed} 的并发触发已合并为同一次裁决，不重复执行` }
        : result,
    )
  }
  const task = Promise.resolve().then(() => executeTrigger(trimmed))
  triggerLocks.set(trimmed, task)
  return task.finally(() => {
    triggerLocks.delete(trimmed)
  })
}

function executeTrigger(objectId: string): GovernanceTriggerResult {
  const ruleRows = listRows('govern').filter(
    (row) => String(row['治理对象'] ?? '').trim() === objectId,
  )
  if (ruleRows.length === 0) {
    return {
      ok: false,
      duplicate: false,
      message: `${objectId} 没有匹配的治理规则`,
      evaluations: [],
    }
  }

  const state = readGovernanceState()
  const next = applyConflictDecision({ objectId, ruleRows, state, now: new Date().toISOString() })
  if (next.state === state) {
    // 相同冲突重复到达：不写盘、不改变处置。
    return next.result
  }

  // 胜出处置同时同步到质量监控：告警级别跟治理结论走，不再各自生成重复告警。
  try {
    const rows = allRows()
    const governRows = rows.govern ?? []
    const qualityRows = rows.quality ?? []
    const updatedQuality = syncQualityAlerts(qualityRows, next.result.alert)
    saveTransaction(
      { ...rows, govern: governRows, quality: updatedQuality },
      next.state,
    )
  } catch (error) {
    // 写入失败：内存与存储都保持旧处置，返回失败让页面提示。
    return {
      ok: false,
      duplicate: false,
      message: `裁决写入失败，已保持旧处置：${error instanceof Error ? error.message : '未知错误'}`,
      evaluations: next.result.evaluations,
    }
  }

  return next.result
}

/** 质量监控里每个对象只保留优先级最高的治理结论，重复触发不会叠加告警。 */
function syncQualityAlerts(rows: EntryRow[], alert: QualityAlertRecord | undefined): EntryRow[] {
  if (!alert) {
    return rows
  }
  const marker = `治理裁决 ${alert.ruleNo}`
  const matched = rows.some((row) => String(row['监控对象'] ?? '').trim() === alert.objectId)
  if (!matched) {
    return rows
  }
  // 只覆盖告警结论相关字段，不擅自推动质量指标的状态流转。
  return rows.map((row) => {
    if (String(row['监控对象'] ?? '').trim() !== alert.objectId) {
      return row
    }
    return {
      ...row,
      '告警级别': alert.conclusion,
      '通知渠道': marker,
      '恢复策略': alert.priorityLabel,
      abnormal: true,
    }
  })
}


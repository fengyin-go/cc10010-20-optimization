import type {
  EntryRow,
  GovernanceDisposal,
  GovernanceHit,
  GovernancePriority,
  GovernanceRuleEvaluation,
  GovernanceState,
  GovernanceTriggerResult,
  QualityAlertRecord,
} from '@/data/types'

/**
 * 冲突裁决优先级（按字典序比较，越靠前越优先）：
 * 1. 影响范围：全湖级 > 业务域级 > 分区级 > 表级 > 字段级；
 * 2. 触发阈值：同一范围下阈值更严格者优先（数值越小越严格）；
 * 3. 当前生效状态：已启用 > 待校验 > 草稿 > 已停用。
 *
 * 生效状态既是排序项也是执行门槛：只有「已启用」的规则能改变对象，
 * 其余状态仍作为命中留痕（ineligible），用于审计与解释。
 * 三项完全相同时按规则编号升序，保证同一冲突每次裁决结果一致。
 */
const SCOPE_RANKS: Array<{ keyword: string; rank: number; label: string }> = [
  { keyword: '全湖', rank: 100, label: '全湖级' },
  { keyword: '业务域', rank: 80, label: '业务域级' },
  { keyword: '域', rank: 80, label: '业务域级' },
  { keyword: '分区', rank: 60, label: '分区级' },
  { keyword: '字段', rank: 20, label: '字段级' },
  { keyword: '表', rank: 40, label: '表级' },
]

const STATUS_RANKS: Record<string, number> = {
  已启用: 40,
  待校验: 30,
  草稿: 20,
  已停用: 10,
}

const NUMERIC_THRESHOLD = /^[<>=]*\s*-?\d+(?:\.\d+)?\s*%?$/

export function scopeRankOf(scope: string): { rank: number; label: string } {
  const text = scope.trim()
  for (const item of SCOPE_RANKS) {
    if (text.includes(item.keyword)) {
      return { rank: item.rank, label: item.label }
    }
  }
  return { rank: 0, label: text || '未标注' }
}

/** 触发阈值：只有纯数值/比较式才按「越小越严格」排序，文本阈值退化为稳定字典序。 */
export function thresholdRankOf(threshold: string): { rank: number; label: string } {
  const text = threshold.trim()
  if (text === '') {
    return { rank: Number.POSITIVE_INFINITY, label: '未标注' }
  }
  if (NUMERIC_THRESHOLD.test(text)) {
    const numeric = Number.parseFloat(text.replace(/[^0-9.+-]/g, ''))
    if (Number.isFinite(numeric)) {
      return { rank: numeric, label: text }
    }
  }
  return { rank: Number.POSITIVE_INFINITY, label: text }
}

export function statusRankOf(status: string): number {
  return STATUS_RANKS[status.trim()] ?? 0
}

/** 只有「已启用」的规则在触发时生效；其余状态保留为可追溯命中但不改变对象。 */
export function isEligibleStatus(status: string): boolean {
  return status.trim() === '已启用'
}

function priorityOf(scopeRank: number, thresholdRank: number, thresholdText: string, statusRank: number): GovernancePriority {
  return { scopeRank, thresholdRank, thresholdText, statusRank }
}

/** 字典序比较：返回正数表示 a 优先于 b，0 表示完全同级。 */
export function comparePriority(a: GovernancePriority, b: GovernancePriority): number {
  if (a.scopeRank !== b.scopeRank) {
    return a.scopeRank - b.scopeRank
  }
  const aFinite = Number.isFinite(a.thresholdRank)
  const bFinite = Number.isFinite(b.thresholdRank)
  if (aFinite && bFinite && a.thresholdRank !== b.thresholdRank) {
    // 阈值越小越严格，因此反向比较。
    return b.thresholdRank - a.thresholdRank
  }
  if (aFinite !== bFinite) {
    // 有明确数值阈值的规则优先于纯文本阈值。
    return aFinite ? 1 : -1
  }
  if (!aFinite && !bFinite && a.thresholdText !== b.thresholdText) {
    // 文本阈值：空值最弱，其余按字典序稳定比较。
    if (a.thresholdText === '') {
      return -1
    }
    if (b.thresholdText === '') {
      return 1
    }
    return a.thresholdText < b.thresholdText ? 1 : -1
  }
  return a.statusRank - b.statusRank
}

export function buildPriorityLabel(scope: string, threshold: string, status: string): string {
  const scopeInfo = scopeRankOf(scope)
  const thresholdInfo = thresholdRankOf(threshold)
  const statusRank = statusRankOf(status)
  return `影响范围=${scopeInfo.label}(${scopeInfo.rank}) / 阈值=${thresholdInfo.label} / 状态=${status || '未标注'}(${statusRank})`
}

function readRule(row: EntryRow) {
  return {
    ruleId: Number(row.id),
    ruleNo: String(row['规则编号'] ?? `RULE-${row.id}`),
    ruleType: String(row['治理类型'] ?? ''),
    action: String(row['执行动作'] ?? ''),
    scope: String(row['影响范围'] ?? ''),
    threshold: String(row['触发阈值'] ?? ''),
    status: String(row.status ?? ''),
    objectId: String(row['治理对象'] ?? '').trim(),
    launchAt: String(row['生效时间'] ?? row['上线时间'] ?? ''),
  }
}

export type RuleEvaluationCandidate = GovernanceRuleEvaluation & {
  objectId: string
}

/** 评估一条规则；不改变任何状态，供列表与触发共用。 */
export function evaluateRule(row: EntryRow): RuleEvaluationCandidate {
  const rule = readRule(row)
  const scopeInfo = scopeRankOf(rule.scope)
  const thresholdInfo = thresholdRankOf(rule.threshold)
  const statusRank = statusRankOf(rule.status)
  const eligible = isEligibleStatus(rule.status) && rule.objectId !== ''
  const priorityLabel = buildPriorityLabel(rule.scope, rule.threshold, rule.status)
  let reason = '参与冲突裁决'
  if (rule.objectId === '') {
    reason = '未标注治理对象，不参与裁决'
  } else if (!isEligibleStatus(rule.status)) {
    reason = `规则当前为「${rule.status || '未知'}」，未生效`
  }
  return {
    ruleId: rule.ruleId,
    ruleNo: rule.ruleNo,
    ruleType: rule.ruleType,
    action: rule.action,
    scope: rule.scope,
    scopeRank: scopeInfo.rank,
    threshold: rule.threshold,
    thresholdRank: thresholdInfo.rank,
    status: rule.status,
    statusRank,
    launchAt: rule.launchAt,
    eligible,
    priorityLabel,
    reason,
    objectId: rule.objectId,
  }
}

function toPriority(evaluation: GovernanceRuleEvaluation): GovernancePriority {
  return priorityOf(evaluation.scopeRank, evaluation.thresholdRank, evaluation.threshold, evaluation.statusRank)
}

/** 对同一对象的一组规则排序：最强的排在最前。 */
export function rankRules(rows: EntryRow[]): RuleEvaluationCandidate[] {
  return rows
    .map(evaluateRule)
    .sort((a, b) => {
      const byPriority = comparePriority(toPriority(a), toPriority(b))
      if (byPriority !== 0) {
        return -byPriority
      }
      return a.ruleId - b.ruleId
    })
}

/**
 * 冲突指纹：对象 + 参与裁决的规则关键字段 + 当前胜出者。
 * 规则集合、范围、阈值、状态都没变时指纹一致，视为同一冲突。
 */
export function conflictSignature(objectId: string, rows: EntryRow[], winnerRuleId: number | null): string {
  const parts = rows
    .map((row) => {
      const rule = readRule(row)
      return [rule.ruleId, rule.ruleNo, rule.scope, rule.threshold, rule.status, rule.action, rule.objectId].join('|')
    })
    .sort()
  return [objectId, winnerRuleId ?? 'none', ...parts].join('::')
}

export function triggerIdOf(objectId: string, signature: string): string {
  let hash = 0
  for (const char of signature) {
    hash = (hash * 33 + char.charCodeAt(0)) % 1000000007
  }
  return `TRIG-${objectId}-${hash.toString(36)}`
}

export type DecideInput = {
  objectId: string
  ruleRows: EntryRow[]
  /** 触发时刻；测试可注入固定值。 */
  now?: string
}

export type DecideOutput = {
  evaluations: GovernanceRuleEvaluation[]
  winner: GovernanceRuleEvaluation | null
  disposal: GovernanceDisposal | null
  supersededRules: string[]
  signature: string
  triggerId: string
}

/**
 * 对单个对象做一次冲突裁决。纯函数：不读写存储，调用方决定是否提交。
 * 同一对象只产生一个胜出处置；其余命中只标记为 superseded/ineligible。
 */
export function decideObject(input: DecideInput): DecideOutput {
  const now = input.now ?? new Date().toISOString()
  const ranked = rankRules(input.ruleRows)
  const eligible = ranked.filter((item) => item.eligible)
  const winner = eligible.length > 0 ? eligible[0] : null
  const supersededRules = eligible.filter((item) => item.ruleId !== winner?.ruleId).map((item) => item.ruleNo)

  const evaluations: GovernanceRuleEvaluation[] = ranked.map(({ objectId: _objectId, ...rest }) => {
    if (!rest.eligible) {
      return rest
    }
    if (rest.ruleId === winner?.ruleId) {
      return { ...rest, reason: '优先级最高，产生唯一有效处置' }
    }
    return { ...rest, reason: '命中但被更高优先级规则压制，仅留痕' }
  })

  const signature = conflictSignature(input.objectId, input.ruleRows, winner?.ruleId ?? null)
  const triggerId = triggerIdOf(input.objectId, signature)

  if (!winner) {
    return { evaluations, winner: null, disposal: null, supersededRules, signature, triggerId }
  }

  const disposal: GovernanceDisposal = {
    objectId: input.objectId,
    ruleId: winner.ruleId,
    ruleNo: winner.ruleNo,
    ruleType: winner.ruleType,
    conclusion: winner.action || `${winner.ruleType || '治理'}结论`,
    scope: winner.scope,
    threshold: winner.threshold,
    priorityLabel: winner.priorityLabel,
    priorityRanks: toPriority(winner),
    decidedAt: now,
    triggerId,
    triggerSignature: signature,
    supersededRules,
    // 处置冻结胜出规则上线时的定义，后续规则改动不会回写既有处置。
    ruleSnapshot: {
      ruleNo: winner.ruleNo,
      ruleType: winner.ruleType,
      action: winner.action,
      scope: winner.scope,
      threshold: winner.threshold,
      status: winner.status,
    },
  }

  return { evaluations, winner, disposal, supersededRules, signature, triggerId }
}

function toHit(
  objectId: string,
  evaluation: GovernanceRuleEvaluation,
  triggerId: string,
  at: string,
  winnerRuleId: number | null,
): GovernanceHit {
  let outcome: GovernanceHit['outcome'] = 'superseded'
  if (!evaluation.eligible) {
    outcome = 'ineligible'
  } else if (evaluation.ruleId === winnerRuleId) {
    outcome = 'winner'
  }
  return {
    hitId: `${triggerId}-${evaluation.ruleId}`,
    objectId,
    ruleId: evaluation.ruleId,
    ruleNo: evaluation.ruleNo,
    action: evaluation.action,
    outcome,
    reason: evaluation.reason,
    priorityLabel: evaluation.priorityLabel,
    triggerId,
    at,
  }
}

export type ApplyConflictInput = {
  objectId: string
  ruleRows: EntryRow[]
  state: GovernanceState
  now?: string
}

function appendHits(state: GovernanceState, hits: GovernanceHit[]): GovernanceHit[] {
  if (hits.length === 0) {
    return state.hits
  }
  // 命中台账按 hitId 去重，同一触发不会刷屏。
  const existing = new Set(state.hits.map((hit) => hit.hitId))
  const fresh = hits.filter((hit) => !existing.has(hit.hitId))
  return fresh.length === 0 ? state.hits : [...state.hits, ...fresh]
}

/**
 * 把一次触发的裁决结果合并进治理状态（不落盘，由调用方原子提交）。
 * 相同冲突连续到达（指纹一致且已有处置）直接返回 duplicate，不重复计算、不改对象。
 */
export function applyConflictDecision(
  input: ApplyConflictInput,
): { state: GovernanceState; result: GovernanceTriggerResult } {
  const now = input.now ?? new Date().toISOString()
  const previous = input.state.disposals[input.objectId]
  const ranked = rankRules(input.ruleRows)
  const eligible = ranked.filter((item) => item.eligible)
  const signature = conflictSignature(input.objectId, input.ruleRows, eligible[0]?.ruleId ?? null)

  // 指纹相同说明是同一冲突连续到达：不再重复计算，也不改变任何状态。
  if (input.state.lastSignatures[input.objectId] === signature) {
    return {
      state: input.state,
      result: {
        ok: true,
        duplicate: true,
        message: `${input.objectId} 的相同冲突已裁决过，本次不重复执行`,
        evaluations: ranked.map(({ objectId: _objectId, ...rest }) => rest),
        disposal: previous,
        alert: input.state.alerts[input.objectId],
        signature,
      },
    }
  }

  const decided = decideObject({
    objectId: input.objectId,
    ruleRows: input.ruleRows,
    now,
  })

  if (!decided.winner || !decided.disposal) {
    // 没有生效规则：保留旧处置，只记录未生效命中，避免对象被清空。
    const hits = appendHits(
      input.state,
      decided.evaluations.map((item) => toHit(input.objectId, item, decided.triggerId, now, null)),
    )
    return {
      state: {
        ...input.state,
        hits,
        lastSignatures: { ...input.state.lastSignatures, [input.objectId]: signature },
      },
      result: {
        ok: true,
        duplicate: false,
        message: `${input.objectId} 没有生效中的治理规则，保留旧处置`,
        evaluations: decided.evaluations,
        disposal: previous,
        alert: input.state.alerts[input.objectId],
        signature,
      },
    }
  }

  const disposal = decided.disposal
  const candidateAlert: QualityAlertRecord = {
    alertId: `ALERT-${input.objectId}-${disposal.ruleId}`,
    objectId: input.objectId,
    ruleId: disposal.ruleId,
    ruleNo: disposal.ruleNo,
    conclusion: disposal.conclusion,
    priorityLabel: disposal.priorityLabel,
    priorityRanks: disposal.priorityRanks,
    decidedAt: disposal.decidedAt,
    triggerId: disposal.triggerId,
    supersededRules: disposal.supersededRules,
  }
  // 跨模块的质量告警只保留优先级最高的治理结论：较弱的新结论不覆盖更强的旧告警。
  const previousAlert = input.state.alerts[input.objectId]
  const alert = previousAlert && comparePriority(previousAlert.priorityRanks, candidateAlert.priorityRanks) > 0
    ? previousAlert
    : candidateAlert
  const hits = appendHits(
    input.state,
    decided.evaluations.map((item) => toHit(input.objectId, item, disposal.triggerId, disposal.decidedAt, disposal.ruleId)),
  )

  return {
    state: {
      disposals: { ...input.state.disposals, [input.objectId]: disposal },
      // 每个对象只保留一个告警结论，重复规则命中不会叠加告警。
      alerts: { ...input.state.alerts, [input.objectId]: alert },
      hits,
      lastSignatures: { ...input.state.lastSignatures, [input.objectId]: signature },
    },
    result: {
      ok: true,
      duplicate: false,
      message: `${input.objectId} 由规则 ${disposal.ruleNo} 产生唯一有效处置「${disposal.conclusion}」`,
      evaluations: decided.evaluations,
      winner: decided.winner,
      disposal,
      alert,
      signature,
    },
  }
}

/** 判断处置快照与当前规则定义是否一致：不一致说明处置按上线时旧规则保留。 */
export function isDisposalSnapshotStale(disposal: GovernanceDisposal, ruleRows: EntryRow[]): boolean {
  const current = ruleRows.find((row) => Number(row.id) === disposal.ruleId)
  if (!current) {
    return true
  }
  const rule = readRule(current)
  const snapshot = disposal.ruleSnapshot
  return (
    rule.ruleNo !== snapshot.ruleNo ||
    rule.ruleType !== snapshot.ruleType ||
    rule.action !== snapshot.action ||
    rule.scope !== snapshot.scope ||
    rule.threshold !== snapshot.threshold ||
    rule.status !== snapshot.status
  )
}

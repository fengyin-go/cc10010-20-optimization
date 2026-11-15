/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 优先级三元组：影响范围 > 触发阈值 > 生效状态，越大越优先。 */
export type GovernancePriority = {
  scopeRank: number
  /** 数值化后的阈值；非数值阈值记为 Infinity，排序时再用原始文本兜底。 */
  thresholdRank: number
  thresholdText: string
  statusRank: number
}

/** 治理规则参与冲突裁决时的评估结果。 */
export type GovernanceRuleEvaluation = {
  ruleId: number
  ruleNo: string
  ruleType: string
  action: string
  scope: string
  scopeRank: number
  threshold: string
  thresholdRank: number
  status: string
  statusRank: number
  launchAt: string
  eligible: boolean
  /** 可读的优先级依据，例如「影响范围=业务域级(80) / 阈值=1 / 状态=已启用」。 */
  priorityLabel: string
  /** 胜出、被压制或未生效的原因。 */
  reason: string
}

/** 同一治理对象最终只保留一个有效处置，处置里冻结胜出规则当时的快照。 */
export type GovernanceDisposal = {
  objectId: string
  ruleId: number
  ruleNo: string
  ruleType: string
  conclusion: string
  scope: string
  threshold: string
  priorityLabel: string
  priorityRanks: GovernancePriority
  decidedAt: string
  triggerId: string
  triggerSignature: string
  supersededRules: string[]
  ruleSnapshot: {
    ruleNo: string
    ruleType: string
    action: string
    scope: string
    threshold: string
    status: string
  }
}

/** 规则命中台账：胜出、被压制、未生效的命中都留痕，但只有胜出者改变对象。 */
export type GovernanceHit = {
  hitId: string
  objectId: string
  ruleId: number
  ruleNo: string
  action: string
  outcome: 'winner' | 'superseded' | 'ineligible'
  reason: string
  priorityLabel: string
  triggerId: string
  at: string
}

/** 跨模块质量告警记录：每个对象只保留优先级最高的治理结论。 */
export type QualityAlertRecord = {
  alertId: string
  objectId: string
  ruleId: number
  ruleNo: string
  conclusion: string
  priorityLabel: string
  priorityRanks: GovernancePriority
  decidedAt: string
  triggerId: string
  supersededRules: string[]
}

export type GovernanceRuleView = {
  ruleId: number
  ruleNo: string
  ruleType: string
  action: string
  scope: string
  threshold: string
  status: string
  eligible: boolean
  priorityLabel: string
  priorityRanks: GovernancePriority
}

export type GovernanceObjectSummary = {
  objectId: string
  rules: GovernanceRuleView[]
  disposal?: GovernanceDisposal
  /** 处置快照与当前规则定义不一致：说明处置仍按上线时旧规则保留。 */
  disposalStale: boolean
}

export type GovernanceBoard = {
  objects: GovernanceObjectSummary[]
  hits: GovernanceHit[]
  alerts: QualityAlertRecord[]
}

export type GovernanceTriggerResult = {
  ok: boolean
  duplicate: boolean
  message: string
  evaluations: GovernanceRuleEvaluation[]
  winner?: GovernanceRuleEvaluation
  disposal?: GovernanceDisposal
  alert?: QualityAlertRecord
  signature?: string
}

/** 与业务清单一起持久化的裁决状态，保证处置、命中台账、告警结论同一次写入。 */
export type GovernanceState = {
  disposals: Record<string, GovernanceDisposal>
  alerts: Record<string, QualityAlertRecord>
  hits: GovernanceHit[]
  /** 每个对象最近一次处理的冲突指纹，用于「相同冲突连续到达只计算一次」。 */
  lastSignatures: Record<string, string>
}

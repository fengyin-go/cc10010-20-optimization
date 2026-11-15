import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  downloadEntries,
  listEntries,
  loadGovernanceBoard,
  moduleMeta,
  resetModule,
  runAction as applyAction,
  triggerGovernance,
} from '@/api/local-service'
import type { EntryRow, GovernanceBoard, GovernanceTriggerResult, GovernanceObjectSummary } from '@/data/types'
const meta = moduleMeta('govern')
const columns = [
  "规则编号",
  "治理对象",
  "治理类型",
  "触发阈值",
  "执行动作",
  "执行频率",
  "影响范围",
  "回滚策略",
]
const actions = ["提交校验", "启用治理", "停用治理"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [
  { label: "治理规则总数", value: 0 },
  { label: "已启用规则", value: 0 },
  { label: "待校验规则", value: 0 },
]

const OUTCOME_LABELS: Record<string, string> = {
  winner: '胜出',
  superseded: '被压制',
  ineligible: '未生效',
}

export default function GovernView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [board, setBoard] = useState<GovernanceBoard>({ objects: [], hits: [], alerts: [] })
  const [triggering, setTriggering] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<GovernanceTriggerResult | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setBoard(loadGovernanceBoard())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '湖仓治理列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function resetGovernance() {
    resetModule(meta.key)
    setLastResult(null)
    setNotice('治理规则与裁决状态已一起重置')
    reload()
  }

  async function trigger(objectId: string) {
    if (triggering) {
      return
    }
    setTriggering(objectId)
    setErrorMessage('')
    setNotice('')
    try {
      const result = await triggerGovernance(objectId)
      setLastResult(result)
      if (!result.ok) {
        setErrorMessage(result.message)
      } else if (result.duplicate) {
        setNotice(result.message)
      } else {
        setNotice(result.message)
      }
    } finally {
      setTriggering(null)
      reload()
    }
  }

  const statsValue = [
    total,
    rows.filter((row) => String(row.status) === '已启用').length,
    rows.filter((row) => String(row.status) === '待校验').length,
  ]

  return (
    <section className="page" data-module="govern">
      <header className="page-head">
        <div>
          <h2>湖仓治理管理</h2>
          <p className="page-desc">
            多条规则命中同一对象时按「影响范围 &gt; 触发阈值 &gt; 生效状态」裁决，每个对象只保留一个有效处置。
            已存在处置按旧规则保留，下一次触发才切换到新优先级。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('治理规则登记入口尚未接入审批流')}>
            登记治理规则
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出湖仓治理清单
          </button>
          <button className="btn ghost" type="button" onClick={resetGovernance}>
            重置治理数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item, index) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{statsValue[index]}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <ConflictBoard
        board={board}
        triggering={triggering}
        lastResult={lastResult}
        onTrigger={trigger}
      />

      <h3 className="section-title">治理规则清单</h3>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无湖仓治理数据，可先登记治理规则</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条湖仓治理记录</span>
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}

function ConflictBoard({
  board,
  triggering,
  lastResult,
  onTrigger,
}: {
  board: GovernanceBoard
  triggering: string | null
  lastResult: GovernanceTriggerResult | null
  onTrigger: (objectId: string) => void
}) {
  return (
    <div className="conflict-board">
      <h3 className="section-title">冲突裁决看板</h3>
      {board.objects.length === 0 && (
        <p className="empty-hint">还没有带治理对象的规则；在「治理对象」列填上同一个对象名才会形成冲突组。</p>
      )}
      <div className="object-grid">
        {board.objects.map((object) => (
          <ObjectCard
            key={object.objectId}
            object={object}
            busy={triggering === object.objectId}
            onTrigger={onTrigger}
            isLast={lastResult?.disposal?.objectId === object.objectId}
          />
        ))}
      </div>

      {lastResult && lastResult.evaluations.length > 0 && (
        <div className="decision-detail">
          <h4>本次裁决明细 · {lastResult.disposal?.objectId ?? lastResult.evaluations[0].ruleNo}</h4>
          <p className={lastResult.ok ? 'notice-text' : 'error-text'}>{lastResult.message}</p>
          <table className="data-table compact">
            <thead>
              <tr><th>规则</th><th>优先级依据</th><th>结论</th></tr>
            </thead>
            <tbody>
              {lastResult.evaluations.map((item) => (
                <tr key={item.ruleId}>
                  <td>{item.ruleNo}</td>
                  <td>{item.priorityLabel}</td>
                  <td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="trace-grid">
        <div>
          <h4>命中台账（可追溯，不再重复改变对象）</h4>
          <table className="data-table compact">
            <thead>
              <tr><th>对象</th><th>规则</th><th>结果</th><th>时间</th></tr>
            </thead>
            <tbody>
              {board.hits.slice(0, 12).map((hit) => (
                <tr key={hit.hitId}>
                  <td>{hit.objectId}</td>
                  <td>{hit.ruleNo}</td>
                  <td><span className={`outcome-tag ${hit.outcome}`}>{OUTCOME_LABELS[hit.outcome]}</span></td>
                  <td>{formatTime(hit.at)}</td>
                </tr>
              ))}
              {board.hits.length === 0 && (
                <tr><td className="empty-state" colSpan={4}>暂无命中记录，触发一次冲突裁决后会留痕</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          <h4>质量告警结论（每对象仅保留最高优先级）</h4>
          <table className="data-table compact">
            <thead>
              <tr><th>对象</th><th>胜出规则</th><th>治理结论</th></tr>
            </thead>
            <tbody>
              {board.alerts.map((alert) => (
                <tr key={alert.alertId}>
                  <td>{alert.objectId}</td>
                  <td>{alert.ruleNo}</td>
                  <td>{alert.conclusion}</td>
                </tr>
              ))}
              {board.alerts.length === 0 && (
                <tr><td className="empty-state" colSpan={3}>暂无跨模块告警结论</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function ObjectCard({
  object,
  busy,
  onTrigger,
  isLast,
}: {
  object: GovernanceObjectSummary
  busy: boolean
  onTrigger: (objectId: string) => void
  isLast: boolean
}) {
  const disposal = object.disposal
  const stale = object.disposalStale
  const hasConflict = object.rules.length > 1
  return (
    <article className={`object-card${isLast ? ' active' : ''}`}>
      <header className="object-head">
        <strong>{object.objectId}</strong>
        <span className="rule-count">{object.rules.length} 条规则</span>
        {hasConflict && <span className="conflict-tag">存在冲突</span>}
      </header>
      <ul className="rule-list">
        {object.rules.map((rule, index) => (
          <li key={rule.ruleId} className={index === 0 && rule.eligible ? 'rule-first' : ''}>
            <span className="rule-no">{rule.ruleNo}</span>
            <span className="rule-status">{rule.status}</span>
            <span className="rule-priority">{rule.priorityLabel}</span>
          </li>
        ))}
      </ul>
      {disposal ? (
        <div className={`disposal-box${stale ? ' stale' : ''}`}>
          <span className="disposal-label">当前有效处置</span>
          <strong>{disposal.conclusion}</strong>
          <span className="disposal-meta">
            胜出规则 {disposal.ruleNo} · {formatTime(disposal.decidedAt)}
          </span>
          {disposal.supersededRules.length > 0 && (
            <span className="disposal-meta">压制规则：{disposal.supersededRules.join('、')}</span>
          )}
          {stale && <span className="stale-hint">规则已更新，处置按上线时旧规则保留，下一次触发才重新裁决</span>}
        </div>
      ) : (
        <p className="empty-hint">尚未触发，触发后只保留一个有效处置</p>
      )}
      <button
        className="btn primary"
        type="button"
        disabled={busy || triggeringDisabled(object)}
        onClick={() => onTrigger(object.objectId)}
      >
        {busy ? '裁决中…' : '触发裁决'}
      </button>
    </article>
  )
}

function triggeringDisabled(object: GovernanceObjectSummary): boolean {
  return object.rules.every((rule) => !rule.eligible)
}

function formatTime(value: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

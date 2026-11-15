import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, loadGovernanceBoard, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow, GovernanceBoard, QualityAlertRecord } from '@/data/types'

const meta = moduleMeta('quality')
const columns = [
  "指标编号",
  "监控对象",
  "指标类型",
  "阈值范围",
  "检测周期",
  "告警级别",
  "通知渠道",
  "恢复策略"
]
const actions = [
  "提交校验",
  "启用监控",
  "停用监控"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]
const stats = [
  {
    "label": "质量指标总数",
    "value": 0
  },
  {
    "label": "已启用指标",
    "value": 0
  },
  {
    "label": "待校验指标",
    "value": 0
  }
]

export default function QualityView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [board, setBoard] = useState<GovernanceBoard>({ objects: [], hits: [], alerts: [] })
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setBoard(loadGovernanceBoard())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '质量监控列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  return (
    <section className="page" data-module="quality">
      <header className="page-head">
        <div>
          <h2>质量监控管理</h2>
          <p className="page-desc">维护质量监控指标的输入、执行约束与结果记录，为质量监控提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('质量指标登记入口尚未接入审批流')}>
            登记质量指标
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出质量监控清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
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

      <AlertSummary alerts={board.alerts} />

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
              <td className="empty-state" colSpan={columns.length + 2}>暂无质量监控数据，可先登记质量指标</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条质量监控记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}

function AlertSummary({ alerts }: { alerts: QualityAlertRecord[] }) {
  return (
    <div className="alert-summary">
      <h3 className="section-title">治理告警结论（按对象只保留优先级最高的一条）</h3>
      {alerts.length === 0 ? (
        <p className="empty-hint">暂无治理告警；在湖仓治理页触发冲突裁决后，结论会同步到这里。</p>
      ) : (
        <table className="data-table compact">
          <thead>
            <tr><th>监控对象</th><th>胜出规则</th><th>优先级依据</th><th>治理结论</th><th>压制规则</th></tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr key={alert.alertId}>
                <td>{alert.objectId}</td>
                <td>{alert.ruleNo}</td>
                <td>{alert.priorityLabel}</td>
                <td>{alert.conclusion}</td>
                <td>{alert.supersededRules.length > 0 ? alert.supersededRules.join('、') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

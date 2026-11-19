import { useMemo, useState } from 'react';
import { fmtDate, fmtDuration, useApp, useData } from '../api.js';
import { TrendChart } from '../charts.jsx';
import { addDaysClient } from '../util-dates.js';
import { Icon, Kpi, Loading, PctBar } from '../ui.jsx';

const PRESETS = [
  { id: '7', label: '7 days', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom' },
];

export default function Reports() {
  const { info, slug } = useApp();
  const today = info.today;
  const [preset, setPreset] = useState('30');
  const [custom, setCustom] = useState({ from: addDaysClient(today, -29), to: today });
  const [batchId, setBatchId] = useState('');
  const [sort, setSort] = useState({ key: 'pct', dir: 1 });
  const { data: batches } = useData('/batches');

  const range = useMemo(() => {
    const p = PRESETS.find((x) => x.id === preset);
    if (p.days) return { from: addDaysClient(today, -(p.days - 1)), to: today };
    if (preset === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
    return custom;
  }, [preset, custom, today]);

  const qs = `from=${range.from}&to=${range.to}${batchId ? `&batchId=${batchId}` : ''}`;
  const { data: r, error } = useData(`/reports?${qs}`);

  const students = useMemo(() => {
    if (!r) return [];
    const k = sort.key;
    return [...r.students].sort((a, b) => {
      const va = a[k] ?? -1;
      const vb = b[k] ?? -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sort.dir;
    });
  }, [r, sort]);
  const th = (key, label, cls) => (
    <th className={cls}>
      <button onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))}>{label} {sort.key === key ? (sort.dir > 0 ? '↑' : '↓') : ''}</button>
    </th>
  );

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Reports</h1>
          <p className="muted">{fmtDate(range.from, { day: 'numeric', month: 'short', year: 'numeric' })} – {fmtDate(range.to, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
        </div>
        <a className="btn ghost" href={`/api/i/${slug}/reports.csv?${qs}`} download><Icon name="download" /> Export CSV</a>
      </div>

      <div className="range">
        <div className="seg" role="tablist">
          {PRESETS.map((p) => (
            <button key={p.id} role="tab" aria-selected={preset === p.id} className={preset === p.id ? 'on' : ''} onClick={() => setPreset(p.id)}>{p.label}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <>
            <input className="input auto" type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
            <span className="muted">to</span>
            <input className="input auto" type="date" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
          </>
        )}
        <select className="select auto" value={batchId} onChange={(e) => setBatchId(e.target.value)} aria-label="Batch">
          <option value="">All batches</option>
          {batches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {error && <p className="error-text">{error.message}</p>}
      {!r ? (
        <Loading height={420} />
      ) : (
        <>
          <div className="kpis">
            <Kpi label="Attendance" value={r.totals.pct == null ? '–' : `${r.totals.pct}%`} tone={r.totals.pct < 75 ? 'bad' : 'ok'} hint={`${r.totals.P + r.totals.T} of ${r.totals.total} attended (${r.totals.T} late)`} />
            <Kpi label="WhatsApp alerts" value={r.alerts.sent} hint={`${r.alerts.replyRate ?? 0}% replied`} />
            <Kpi label="Parents reply in" value={r.alerts.avgReplyMin == null ? '–' : `${r.alerts.avgReplyMin} min`} hint="on average, after the WhatsApp" />
            <Kpi label="Parents told within" value={r.alerts.avgMinToAlert == null ? '–' : `${Math.round(r.alerts.avgMinToAlert)} min`} hint={`${fmtDuration(r.alerts.avgMinBeforeClassEnd)} before class ends`} tone="ok" />
            <Kpi label="Calls made" value={r.calls.done} hint={`${r.calls.unreachable} unreachable`} />
            <Kpi label="Bunks caught" value={r.calls.bunks} tone={r.calls.bunks ? 'bad' : ''} />
          </div>

          <section className="card">
            <div className="card-head">
              <h3>Daily attendance</h3>
              <div className="legend">
                <span><i style={{ background: 'var(--green)' }} /> Present</span>
                <span><i style={{ background: 'var(--amber)' }} /> Late</span>
                <span><i style={{ background: 'var(--blue)' }} /> Leave</span>
                <span><i style={{ background: 'var(--red)' }} /> Absent</span>
              </div>
            </div>
            <TrendChart series={r.series} />
          </section>

          <div className="report-grid">
            <section className="card flush">
              <div className="card-head" style={{ padding: '16px 16px 0' }}><h3>Batches</h3></div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Batch</th><th>Classes</th><th>Attendance</th><th className="hide-sm">Absent</th></tr></thead>
                  <tbody>
                    {r.batches.map((b) => (
                      <tr key={b.id}>
                        <td><b>{b.name}</b></td>
                        <td className="num">{b.sessions}</td>
                        <td style={{ minWidth: 150 }}><PctBar pct={b.pct} /></td>
                        <td className="num hide-sm">{b.A}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card">
              <div className="card-head"><h3>Needs attention</h3><span className="chip bad">{r.atRisk.length}</span></div>
              {r.atRisk.length ? (
                <ul className="risk-list">
                  {r.atRisk.map((s) => (
                    <li key={s.id}>
                      <div className="grow">
                        <a href={`#/students/${s.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{s.name}</a>
                        <div className="muted tiny">{s.batchName} · {s.riskReasons.join(' · ')}</div>
                      </div>
                      <span className="pill s-A">{s.pct ?? '–'}%</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No one is below 75% or missing classes repeatedly.</p>
              )}
            </section>
          </div>

          <section className="card flush">
            <div className="card-head" style={{ padding: '16px 16px 0' }}><h3>Students</h3><span className="muted small">{students.length}</span></div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {th('name', 'Student')}
                    {th('batchName', 'Batch', 'hide-sm')}
                    {th('P', 'Present')}
                    {th('T', 'Late')}
                    {th('L', 'Leave')}
                    {th('A', 'Absent')}
                    {th('bunks', 'Bunks', 'hide-sm')}
                    {th('pct', 'Attendance')}
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr key={s.id}>
                      <td><a href={`#/students/${s.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{s.name}</a></td>
                      <td className="small hide-sm">{s.batchName}</td>
                      <td className="num s-P">{s.P}</td>
                      <td className="num s-T">{s.T}</td>
                      <td className="num s-L">{s.L}</td>
                      <td className="num s-A">{s.A}</td>
                      <td className="num hide-sm">{s.bunks}</td>
                      <td style={{ minWidth: 140 }}><PctBar pct={s.pct} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

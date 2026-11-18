import { useState } from 'react';
import { addDaysClient, fmtDate } from './util-dates.js';

/** Daily attendance: stacked bars (present / leave / absent) with holidays marked. */
export function TrendChart({ series, height = 220 }) {
  const [hover, setHover] = useState(null);
  const W = 760;
  const H = height;
  const pad = { l: 34, r: 8, t: 10, b: 26 };
  const max = Math.max(1, ...series.map((d) => d.total));
  const n = series.length || 1;
  const bw = (W - pad.l - pad.r) / n;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];
  const every = Math.ceil(n / 8);
  const d = hover != null ? series[hover] : null;

  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily attendance chart" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}
        {series.map((s, i) => {
          const x = pad.l + i * bw + bw * 0.15;
          const w = Math.max(2, bw * 0.7);
          const segs = [
            ['P', s.P, 'var(--green)'],
            ['L', s.L, 'var(--amber)'],
            ['A', s.A, 'var(--red)'],
          ];
          let acc = 0;
          return (
            <g key={s.date} onMouseEnter={() => setHover(i)} opacity={hover == null || hover === i ? 1 : 0.55}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {s.holiday && <rect x={x} y={pad.t} width={w} height={H - pad.t - pad.b} rx="3" fill="var(--blue-soft)" />}
              {segs.map(([k, v, c]) => {
                if (!v) return null;
                const y1 = y(acc + v);
                const h = y(acc) - y1;
                acc += v;
                return <rect key={k} x={x} y={y1} width={w} height={Math.max(0, h - 1)} rx="2" fill={c} />;
              })}
              {i % every === 0 && (
                <text x={x + w / 2} y={H - 8} textAnchor="middle">{fmtDate(s.date)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-tip">
        {d ? (
          d.holiday ? (
            <span>{fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: holiday ({d.holiday})</span>
          ) : d.total ? (
            <span>
              {fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: <b className="s-P">{d.P} present</b> ·{' '}
              <b className="s-L">{d.L} leave/late</b> · <b className="s-A">{d.A} absent</b> · {d.pct}% attendance
            </span>
          ) : (
            <span>{fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: no classes</span>
          )
        ) : (
          <span>Hover a day for details</span>
        )}
      </div>
    </div>
  );
}

/** Tiny line of attendance % values. */
export function Sparkline({ values, width = 120, height = 32 }) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return <span className="muted small">–</span>;
  const n = values.length - 1 || 1;
  const min = Math.min(60, ...pts.map(([, v]) => v));
  const x = (i) => (i / n) * (width - 4) + 2;
  const y = (v) => height - 3 - ((v - min) / (100 - min || 1)) * (height - 6);
  const dpath = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const [li, lv] = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={dpath} fill="none" stroke="var(--green)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(li)} cy={y(lv)} r="3" fill="var(--green)" />
    </svg>
  );
}

/** GitHub-style calendar of the last ~13 weeks. */
export function Heatmap({ from, to, days, holidays }) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const hol = new Map(holidays.map((h) => [h.date, h.label]));
  // Start on the Sunday on/before `from` so rows are weekdays.
  const startDow = new Date(`${from}T00:00:00Z`).getUTCDay();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push({ key: `pad${i}`, out: true });
  for (let d = from; d <= to; d = addDaysClient(d, 1)) {
    const rec = byDate.get(d);
    const cls = hol.has(d) ? 'H' : rec?.status ?? '';
    const title = hol.has(d)
      ? `${fmtDate(d)}: ${hol.get(d)}`
      : rec
        ? `${fmtDate(d)}: ${{ P: 'Present', A: 'Absent', L: 'Leave / late' }[rec.status]}${rec.note ? ` (${rec.note})` : ''}`
        : `${fmtDate(d)}: no class`;
    cells.push({ key: d, cls, title });
  }
  return (
    <div>
      <div className="heatmap">
        {cells.map((c) => (c.out ? <span key={c.key} className="heat out" /> : <span key={c.key} className={`heat ${c.cls}`} title={c.title} />))}
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        <span><i style={{ background: 'var(--green)' }} /> Present</span>
        <span><i style={{ background: 'var(--amber)' }} /> Leave / late</span>
        <span><i style={{ background: 'var(--red)' }} /> Absent</span>
        <span><i style={{ background: 'var(--blue-soft)', border: '1px solid var(--blue)' }} /> Holiday</span>
        <span><i style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }} /> No class</span>
      </div>
    </div>
  );
}

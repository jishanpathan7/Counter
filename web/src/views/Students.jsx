import { useMemo, useState } from 'react';
import { fmtDate, fmtPhone, fmtTime, navigate, useApp, useData } from '../api.js';
import { Heatmap } from '../charts.jsx';
import { Avatar, Drawer, Empty, Icon, Loading, Modal, PctBar } from '../ui.jsx';

function StudentForm({ initial, batches, onSave, onCancel, saveLabel = 'Save' }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
      <div className="grid2">
        <label className="field">Student name<input className="input" value={f.name} onChange={set('name')} required autoFocus /></label>
        <label className="field">
          Batch
          <select className="select" value={f.batchId} onChange={set('batchId')} required>
            {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      </div>
      <div className="grid2">
        <label className="field">Parent name<input className="input" value={f.parentName ?? ''} onChange={set('parentName')} placeholder="e.g. Mr. Verma" /></label>
        <label className="field">Parent WhatsApp<input className="input" inputMode="tel" value={f.parentPhone} onChange={set('parentPhone')} required placeholder="98765 43210" /></label>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn primary">{saveLabel}</button>
      </div>
    </form>
  );
}

function Profile({ id, batches, onClose }) {
  const { api, toast, info } = useApp();
  const { data: p, error } = useData(`/students/${id}`);
  const [editing, setEditing] = useState(false);

  const save = async (f) => {
    try {
      await api.patch(`/students/${id}`, { ...f, batchId: Number(f.batchId) });
      setEditing(false);
      toast('Saved');
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${p.name}? Their past attendance is kept in reports.`)) return;
    try {
      await api.del(`/students/${id}`);
      toast(`${p.name} removed`);
      onClose();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  const head = p ? (
    <div className="who">
      <Avatar name={p.name} lg />
      <div className="grow">
        <h2 className="ellipsis">{p.name}</h2>
        <div className="muted small">{p.batch.name}</div>
      </div>
    </div>
  ) : <b>Student</b>;

  return (
    <Drawer onClose={onClose} head={head}>
      {error && <p className="error-text">{error.message}</p>}
      {!p ? (
        <Loading height={300} />
      ) : (
        <>
          {p.stats30.atRisk && (
            <div className="banner" style={{ background: 'var(--red-soft)', color: 'var(--red)', borderColor: 'var(--red-line)' }}>
              <Icon name="alert" /> Needs attention: {p.stats30.riskReasons.join(' · ')}
            </div>
          )}
          <section className="card stack tight">
            <div className="row between">
              <div>
                <div className="eyebrow">Parent</div>
                <b>{p.parentName || 'Parent'}</b> <span className="muted small">{fmtPhone(p.parentPhone)}</span>
              </div>
              <div className="row">
                <a className="btn small primary" href={`tel:+${p.parentPhone}`}><Icon name="phone" /> Call</a>
                <a className="btn small ghost" href={`https://wa.me/${p.parentPhone}`} target="_blank" rel="noreferrer"><Icon name="chat" /> WhatsApp</a>
              </div>
            </div>
          </section>

          <div className="stat-tiles">
            <div className="stat-tile"><b className={p.stats30.pct < 75 ? 's-A' : 's-P'}>{p.stats30.pct ?? '–'}%</b><span>last 30 days</span></div>
            <div className="stat-tile"><b>{p.stats90.pct ?? '–'}%</b><span>last 90 days</span></div>
            <div className="stat-tile">
              {p.absentStreak ? <><b className="s-A">{p.absentStreak}</b><span>absent in a row</span></> : <><b className="s-P">{p.presentStreak}</b><span>present in a row</span></>}
            </div>
            <div className="stat-tile"><b className={p.stats90.bunks ? 's-A' : ''}>{p.stats90.bunks}</b><span>bunks (90 d)</span></div>
          </div>

          <section className="card">
            <div className="card-head"><h3>Last 90 days</h3><span className="muted small">{p.stats90.P} present · {p.stats90.L} leave/late · {p.stats90.A} absent</span></div>
            <Heatmap from={p.from} to={p.today} days={p.days} holidays={p.holidays} />
          </section>

          <section className="card">
            <div className="card-head"><h3>WhatsApp alerts</h3><span className="muted small">{p.alerts.length} shown</span></div>
            {p.alerts.length ? (
              <ul className="risk-list">
                {p.alerts.map((a) => (
                  <li key={a.id}>
                    <div className="grow">
                      <b className="small">{fmtDate(a.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b>{' '}
                      <span className="muted small">· {a.batchName} · sent {fmtTime(a.sentAt)}</span>
                      <div className="small">
                        {a.reply ? (
                          <span className="ok-text">Parent replied “{a.reply}” in {a.replyMinutes} min</span>
                        ) : a.outcome ? (
                          <span className="error-text">No reply → {a.outcome}</span>
                        ) : (
                          <span className="muted">{a.status === 'sent' ? 'Waiting for reply' : 'Call pending'}</span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No absences have needed an alert. 👏</p>
            )}
          </section>

          <section className="card">
            {editing ? (
              <StudentForm
                initial={{ name: p.name, parentName: p.parentName ?? '', parentPhone: p.parentPhone, batchId: p.batch.id }}
                batches={batches}
                onSave={save}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <div className="row between">
                <span className="muted small">Details out of date?</span>
                <div className="row">
                  <button className="btn ghost small" onClick={() => setEditing(true)}><Icon name="edit" /> Edit details</button>
                  {info.role === 'owner' && <button className="btn ghost small" style={{ color: 'var(--red)' }} onClick={remove}><Icon name="trash" /> Remove</button>}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}

function Import({ batches, onClose }) {
  const { api, toast } = useApp();
  const [csv, setCsv] = useState('');
  const [batchId, setBatchId] = useState(batches[0]?.id ?? '');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun) => {
    setBusy(true);
    try {
      const r = await api.post('/students/import', { csv, batchId: Number(batchId), dryRun });
      if (dryRun) setPreview(r);
      else {
        toast(`${r.added} students added`);
        onClose();
      }
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const readFile = async (file) => {
    if (file) {
      setCsv(await file.text());
      setPreview(null);
    }
  };

  return (
    <Modal title="Import students" onClose={onClose} wide>
      <div className="stack">
        <p className="muted small">
          Paste from Excel / Google Sheets, or upload a CSV. One student per line: <b>name, parent name, phone, batch</b>. The batch column is optional;
          rows without it go into the batch you pick below.
        </p>
        <textarea className="textarea" style={{ minHeight: 160, fontFamily: 'ui-monospace, monospace', fontSize: 13 }} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} placeholder={'Aarav Sharma, Mr. Sharma, 98765 43210, Class 10 · Batch B\nDiya Iyer, Mrs. Iyer, 98765 43211'} />
        <div className="row">
          <label className="btn ghost small"><Icon name="upload" /> Upload CSV<input type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => readFile(e.target.files?.[0])} /></label>
          <label className="row small">Default batch
            <select className="select auto" value={batchId} onChange={(e) => { setBatchId(e.target.value); setPreview(null); }}>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <span className="grow" />
          <button className="btn ghost" disabled={!csv.trim() || busy} onClick={() => run(true)}>Check</button>
          <button className="btn primary" disabled={!preview?.valid || busy} onClick={() => run(false)}>Import {preview?.valid ?? ''} students</button>
        </div>
        {preview && (
          <div className="card flush table-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
            <table className="table">
              <thead><tr><th>Line</th><th>Student</th><th>Parent</th><th>Phone</th><th>Batch</th><th>Status</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line}>
                    <td className="muted">{r.line}</td>
                    <td>{r.name}</td>
                    <td>{r.parentName}</td>
                    <td className="num">{r.error ? r.phone : fmtPhone(r.phone)}</td>
                    <td>{r.batchName}</td>
                    <td>{r.error ? <span className="error-text small">{r.error}</span> : <span className="ok-text small">Ready</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function Students() {
  const { route, api, toast, info } = useApp();
  const { data: batches } = useData('/batches');
  const { data } = useData('/students');
  const [q, setQ] = useState('');
  const [batch, setBatch] = useState('');
  const [riskOnly, setRiskOnly] = useState(false);
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const openId = Number(route[0]) || null;

  const rows = useMemo(() => {
    let r = data ?? [];
    if (batch) r = r.filter((s) => s.batchId === Number(batch));
    if (riskOnly) r = r.filter((s) => s.atRisk);
    if (q.trim()) {
      const t = q.toLowerCase();
      r = r.filter((s) => s.name.toLowerCase().includes(t) || (s.parentName ?? '').toLowerCase().includes(t) || s.parentPhone.includes(t.replace(/\D/g, '') || '§'));
    }
    const k = sort.key;
    return [...r].sort((a, b) => {
      const va = a[k] ?? -1;
      const vb = b[k] ?? -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sort.dir;
    });
  }, [data, batch, riskOnly, q, sort]);

  const th = (key, label) => (
    <th>
      <button onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : key === 'name' || key === 'batchName' ? 1 : -1 }))}>
        {label} {sort.key === key ? (sort.dir > 0 ? '↑' : '↓') : ''}
      </button>
    </th>
  );

  const add = async (f) => {
    try {
      await api.post('/students', { ...f, batchId: Number(f.batchId) });
      toast(`${f.name} added`);
      setAdding(false);
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  const atRisk = (data ?? []).filter((s) => s.atRisk).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Students</h1>
          <p className="muted">{data ? `${data.length} students · ${atRisk} need attention` : 'Loading…'} · attendance over the last 30 days</p>
        </div>
        <div className="row">
          {info.role === 'owner' && <button className="btn ghost" onClick={() => setImporting(true)} disabled={!batches?.length}><Icon name="upload" /> Import</button>}
          <button className="btn primary" onClick={() => setAdding(true)} disabled={!batches?.length}><Icon name="plus" /> Add student</button>
        </div>
      </div>

      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <input className="input" placeholder="Search name, parent or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search students" />
        </div>
        <select className="select auto" value={batch} onChange={(e) => setBatch(e.target.value)} aria-label="Filter by batch">
          <option value="">All batches</option>
          {batches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={riskOnly} onChange={(e) => setRiskOnly(e.target.checked)} /> Needs attention</label>
      </div>

      {!data ? (
        <Loading height={300} />
      ) : rows.length ? (
        <div className="card flush table-wrap">
          <table className="table">
            <thead>
              <tr>
                {th('name', 'Student')}
                {th('batchName', 'Batch')}
                <th className="hide-sm">Parent</th>
                {th('pct', 'Attendance')}
                {th('A', 'Absent')}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => navigate(`#/students/${s.id}`)}>
                  <td>
                    <div className="who">
                      <Avatar name={s.name} />
                      <div className="ellipsis"><b>{s.name}</b></div>
                    </div>
                  </td>
                  <td className="small">{s.batchName}</td>
                  <td className="small hide-sm">{s.parentName}<div className="muted tiny">{fmtPhone(s.parentPhone)}</div></td>
                  <td style={{ minWidth: 140 }}><PctBar pct={s.pct} /></td>
                  <td className="num">{s.A}{s.bunks ? <span className="muted tiny"> · {s.bunks} bunk</span> : ''}</td>
                  <td>{s.atRisk && <span className="chip bad" title={s.riskReasons.join(', ')}>At risk</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title={data.length ? 'No students match' : 'No students yet'} icon="users">
          {data.length ? 'Try a different search or filter.' : 'Add students one by one, or import a list from Excel.'}
        </Empty>
      )}

      {adding && batches && (
        <Modal title="Add a student" onClose={() => setAdding(false)}>
          <StudentForm initial={{ name: '', parentName: '', parentPhone: '', batchId: batch || batches[0]?.id }} batches={batches} onSave={add} onCancel={() => setAdding(false)} saveLabel="Add student" />
        </Modal>
      )}
      {importing && batches && <Import batches={batches} onClose={() => setImporting(false)} />}
      {openId && batches && <Profile id={openId} batches={batches} onClose={() => navigate('#/students')} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api, fmtPhone, fmtTime24, useData, useLive } from '../api.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function SettingsCard() {
  const { toast } = useLive();
  const { data } = useData('/settings');
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (data && !form) setForm(data);
  }, [data, form]);
  if (!form) return null;
  const save = async (e) => {
    e.preventDefault();
    try {
      setForm(await api.patch('/settings', form));
      toast('Settings saved');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  return (
    <form className="card stack" onSubmit={save}>
      <h2>Institute</h2>
      <label className="field">
        <span>Institute name</span>
        <input className="input" value={form.instituteName} onChange={(e) => setForm({ ...form, instituteName: e.target.value })} />
      </label>
      <div className="row2">
        <label className="field">
          <span>Verify absentees after (min)</span>
          <input className="input" type="number" min="0" max="240" step="0.5" value={form.verifyAfterMinutes} onChange={(e) => setForm({ ...form, verifyAfterMinutes: e.target.value })} />
        </label>
        <label className="field">
          <span>Call task if no reply in (min)</span>
          <input className="input" type="number" min="0" max="240" step="0.5" value={form.replyTimeoutMinutes} onChange={(e) => setForm({ ...form, replyTimeoutMinutes: e.target.value })} />
        </label>
      </div>
      <p className="muted small">Tip for demos: set both to 0.5 and use “Start class now” on the dashboard.</p>
      <div>
        <button className="btn primary" type="submit">Save</button>
      </div>
    </form>
  );
}

function BatchForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState(initial ?? { name: '', startTime: '16:00', days: [1, 2, 3, 4, 5, 6] });
  const toggle = (d) => setF({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] });
  return (
    <form
      className="batch-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(f);
      }}
    >
      <input className="input" placeholder="Batch name, e.g. Class 10 – Batch B" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <input className="input time" type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} />
      <div className="days">
        {DAYS.map((d, i) => (
          <button type="button" key={d} className={`day ${f.days.includes(i) ? 'on' : ''}`} onClick={() => toggle(i)}>
            {d}
          </button>
        ))}
      </div>
      <div className="row-actions">
        <button className="btn primary small" type="submit">{initial ? 'Save' : 'Add batch'}</button>
        {onCancel && <button className="btn ghost small" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function StudentForm({ batchId, onDone }) {
  const { toast } = useLive();
  const empty = { name: '', parentName: '', parentPhone: '' };
  const [f, setF] = useState(empty);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/students', { ...f, batchId });
      setF(empty);
      toast(`${f.name} added`);
      onDone?.();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  return (
    <form className="student-form" onSubmit={submit}>
      <input className="input" placeholder="Student name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <input className="input" placeholder="Parent name" value={f.parentName} onChange={(e) => setF({ ...f, parentName: e.target.value })} />
      <input className="input" placeholder="Parent WhatsApp, e.g. 98765 43210" inputMode="tel" value={f.parentPhone} onChange={(e) => setF({ ...f, parentPhone: e.target.value })} />
      <button className="btn primary small" type="submit">Add</button>
    </form>
  );
}

function BatchCard({ batch }) {
  const { toast } = useLive();
  const [editing, setEditing] = useState(false);
  const { data: students } = useData(`/students?batchId=${batch.id}`);

  const save = async (f) => {
    try {
      await api.patch(`/batches/${batch.id}`, f);
      setEditing(false);
      toast('Batch updated');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${batch.name}? Past attendance is kept.`)) return;
    await api.del(`/batches/${batch.id}`).catch((err) => toast(err.message, 'bad'));
  };
  const removeStudent = async (s) => {
    if (!window.confirm(`Remove ${s.name}? Past attendance is kept.`)) return;
    await api.del(`/students/${s.id}`).catch((err) => toast(err.message, 'bad'));
  };

  return (
    <section className="card stack">
      {editing ? (
        <BatchForm initial={{ name: batch.name, startTime: batch.startTime, days: batch.days }} onSave={save} onCancel={() => setEditing(false)} />
      ) : (
        <div className="session-head">
          <div>
            <h2>{batch.name}</h2>
            <div className="muted small">
              {fmtTime24(batch.startTime)} · {batch.days.length === 7 ? 'Every day' : batch.days.map((d) => DAYS[d]).join(', ')} · {batch.studentCount} students
            </div>
          </div>
          <div className="row-actions">
            <button className="btn ghost small" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn ghost small danger" onClick={remove}>Remove</button>
          </div>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Student</th>
            <th>Parent</th>
            <th>WhatsApp</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {students?.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.parentName || <span className="muted">–</span>}</td>
              <td className="mono">{fmtPhone(s.parentPhone)}</td>
              <td className="right">
                <button className="link danger" onClick={() => removeStudent(s)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <StudentForm batchId={batch.id} />
    </section>
  );
}

export default function Setup() {
  const { toast } = useLive();
  const { data: batches } = useData('/batches');
  const addBatch = async (f) => {
    try {
      await api.post('/batches', f);
      toast('Batch added');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Setup</h1>
          <p className="muted">Batches, students and their parents’ WhatsApp numbers.</p>
        </div>
      </div>
      <SettingsCard />
      <section className="card stack">
        <h2>New batch</h2>
        <BatchForm key={batches?.length ?? 0} onSave={addBatch} />
      </section>
      {batches?.map((b) => (
        <BatchCard key={b.id} batch={b} />
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { fmtPhone, fmtTime, initials, useApp, useData } from '../api.js';
import { Empty, Icon, Loading } from '../ui.jsx';

export default function Messages() {
  const { info, api, toast } = useApp();
  const simulator = info.mode === 'simulator';
  const { data: threads } = useData('/messages/threads');
  const [phone, setPhone] = useState(null);
  const { data: messages } = useData(phone ? `/messages?phone=${phone}` : null);
  const [text, setText] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    if (threads?.length && !threads.some((t) => t.phone === phone)) setPhone(threads[0].phone);
  }, [threads, phone]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const reply = async (body) => {
    try {
      const r = await api.post('/simulator/reply', { phone, ...body });
      if (!r.matched) toast("Couldn't tell if that means leave or late. Staff will follow up.", 'warn');
      setText('');
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  const thread = threads?.find((t) => t.phone === phone);
  const lastWithButtons = messages ? [...messages].reverse().find((m) => m.direction === 'out' && m.buttons) : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{simulator ? 'WhatsApp simulator' : 'WhatsApp'}</h1>
          <p className="muted">
            {simulator
              ? 'No WhatsApp account is connected yet, so messages land here. Tap a reply button as the parent and watch the register update.'
              : 'Every alert sent and reply received through the WhatsApp Cloud API.'}
          </p>
        </div>
        {simulator && info.role === 'owner' && <a className="btn ghost" href="#/settings/whatsapp"><Icon name="wifi" /> Connect WhatsApp</a>}
      </div>

      {!threads && <Loading height={300} />}
      {threads && !threads.length && (
        <Empty title="No messages yet" icon="chat">Alerts appear here once a class is verified and someone is absent.</Empty>
      )}

      {threads?.length > 0 && (
        <div className="wa-layout">
          <ul className="card wa-threads" aria-label="Conversations">
            {threads.map((t) => (
              <li key={t.phone}>
                <button className={`wa-thread ${t.phone === phone ? 'active' : ''}`} onClick={() => setPhone(t.phone)}>
                  <div className="row between" style={{ flexWrap: 'nowrap' }}>
                    <b className="ellipsis">{t.parentName || fmtPhone(t.phone)}</b>
                    <span className="muted tiny">{fmtTime(t.lastAt)}</span>
                  </div>
                  <div className="muted small ellipsis">{t.students ? `${t.students} · ` : ''}{t.lastBody}</div>
                </button>
              </li>
            ))}
          </ul>

          <div className="phone">
            <div className="phone-head">
              <div className="avatar">{initials(thread?.parentName || '?')}</div>
              <div>
                <div className="phone-title">{thread?.parentName || 'Parent'}</div>
                <div className="phone-sub">{phone && fmtPhone(phone)}{thread?.students ? ` · ${thread.students}` : ''}</div>
              </div>
            </div>
            <div className="phone-body">
              {messages?.map((m) => (
                <div key={m.id} className={`bubble-wrap ${m.direction}`}>
                  <div className={`bubble ${m.direction}`}>
                    {m.direction === 'out' && <div className="bubble-from">{info.institute.name}</div>}
                    <div>{m.body}</div>
                    <div className="bubble-time">
                      {fmtTime(m.createdAt)}
                      {m.direction === 'out' && m.status && m.status !== 'failed' && (
                        <span className={`ticks ${m.status}`} title={m.status}>{m.status === 'sent' ? ' ✓' : ' ✓✓'}</span>
                      )}
                      {m.error && <span className="error-text"> · failed: {m.error}</span>}
                    </div>
                  </div>
                  {m.buttons && (
                    <div className="bubble-buttons">
                      {m.buttons.map((b) => (
                        <button key={b.id} disabled={!simulator || m.id !== lastWithButtons?.id} onClick={() => reply({ payload: b.id, text: b.title })}>
                          ↩ {b.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <div ref={endRef} />
            </div>
            {simulator && (
              <form className="phone-input" onSubmit={(e) => { e.preventDefault(); if (text.trim()) reply({ text }); }}>
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply as the parent, e.g. “aaj chutti hai”" aria-label="Reply as the parent" />
                <button type="submit" aria-label="Send"><Icon name="send" /></button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

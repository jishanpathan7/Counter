import { useCallback, useState } from 'react';

/**
 * Screen text in English and Hindi. Starts with the teacher's screen, the one used by the most
 * people every day; other screens can add their keys here.
 */
const STRINGS = {
  en: {
    'teacher.title': 'Take attendance',
    'teacher.intro': 'Everyone is present unless you tap Absent, Late or Leave. Then send the list to the office.',
    'status.A': 'Absent',
    'status.T': 'Late',
    'status.L': 'Leave',
    'status.P': 'Present',
    'status.onLeave': 'On leave',
    'teacher.inClass': (n, total) => `${n} of ${total} in class`,
    'teacher.counts': (a, t, l) => `${a} absent · ${t} late · ${l} on leave`,
    'teacher.send': 'Send to office',
    'teacher.sent': (time) => `Sent ${time}`,
    'teacher.sentToast': 'Sent to the office',
    'teacher.noStudents': 'No students in this batch yet.',
    'teacher.noBatches': 'No batches assigned to you',
    'teacher.askOwner': 'Ask the owner to assign your batches in Settings → Team.',
    'teacher.after.verified': 'Parents have been alerted. Marking someone absent now alerts their parent right away.',
    'teacher.after.sent': (time) => `Parents of absent students get a WhatsApp at ${time}. You can still change marks until then.`,
    'teacher.after.notSent': (time) => `Parents are only alerted after you send the list. The office expects it by ${time}.`,
    'teacher.exceptionsFor': (name) => `Exceptions for ${name}`,
  },
  hi: {
    'teacher.title': 'हाज़िरी लें',
    'teacher.intro': 'सब हाज़िर माने जाते हैं। सिर्फ़ ग़ैरहाज़िर, देर से या छुट्टी वाले बच्चों पर टैप करें, फिर सूची ऑफ़िस भेजें।',
    'status.A': 'ग़ैरहाज़िर',
    'status.T': 'देर से',
    'status.L': 'छुट्टी',
    'status.P': 'हाज़िर',
    'status.onLeave': 'छुट्टी पर',
    'teacher.inClass': (n, total) => `${total} में से ${n} क्लास में`,
    'teacher.counts': (a, t, l) => `${a} ग़ैरहाज़िर · ${t} देर से · ${l} छुट्टी पर`,
    'teacher.send': 'ऑफ़िस भेजें',
    'teacher.sent': (time) => `${time} पर भेजा गया`,
    'teacher.sentToast': 'सूची ऑफ़िस भेज दी गई',
    'teacher.noStudents': 'इस बैच में अभी कोई बच्चा नहीं है।',
    'teacher.noBatches': 'आपको अभी कोई बैच नहीं दिया गया है',
    'teacher.askOwner': 'मालिक से कहें कि Settings → Team में आपके बैच जोड़ दें।',
    'teacher.after.verified': 'माता-पिता को संदेश भेज दिया गया है। अब किसी को ग़ैरहाज़िर करने पर उनके माता-पिता को तुरंत संदेश जाएगा।',
    'teacher.after.sent': (time) => `ग़ैरहाज़िर बच्चों के माता-पिता को ${time} पर WhatsApp जाएगा। तब तक आप बदलाव कर सकते हैं।`,
    'teacher.after.notSent': (time) => `सूची भेजने के बाद ही माता-पिता को संदेश जाता है। ऑफ़िस को सूची ${time} तक चाहिए।`,
    'teacher.exceptionsFor': (name) => `${name} के लिए`,
  },
};

export const LANGS = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'हिंदी' },
];

function initialLang() {
  try {
    const saved = localStorage.getItem('lang');
    if (saved && STRINGS[saved]) return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('hi') ? 'hi' : 'en';
}

/** [t, lang, setLang]: t('key', ...args) falls back to English for anything not translated yet. */
export function useT() {
  const [lang, setLangState] = useState(initialLang);
  const setLang = useCallback((l) => {
    setLangState(l);
    try {
      localStorage.setItem('lang', l);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const t = useCallback(
    (key, ...args) => {
      const v = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
      return typeof v === 'function' ? v(...args) : v;
    },
    [lang],
  );
  return [t, lang, setLang];
}

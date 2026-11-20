// Clara demo: intake chat for a fictional law firm.
// The model, instructions and limits live here, so the page can't be used to run other prompts.
// Needs ANTHROPIC_API_KEY in the Vercel project's environment variables.

const MODEL = process.env.CLARA_MODEL || 'claude-haiku-4-5';
const MAX_MESSAGES = 24;        // a full intake is well under this
const MAX_CHARS = 1500;         // longest single message accepted
const PER_IP_PER_HOUR = 60;     // messages from one address in an hour
const ALLOWED = [/^https:\/\/(www\.)?claradisputes\.co\.uk$/, /^https:\/\/clara-disputes[a-z0-9-]*\.vercel\.app$/, /^http:\/\/localhost(:\d+)?$/];

const hits = new Map(); // best-effort limit per server instance

const SYSTEM = `You are Clara, the website intake assistant for Brindley Vale Solicitors, a FICTIONAL small law firm in England used to demonstrate Clara. You talk to members of the public who have a dispute and want help from the firm.

YOUR JOB
Gather the facts of the enquiry clearly and kindly, so a solicitor can call the person back well prepared. You are not a solicitor and you never give legal advice.

NEVER
- Give legal advice, say whether they have a case, predict outcomes, quote costs or say what the law is in their situation.
- Pretend to be a person. If asked, say you are an AI assistant for the firm.
- Ask for bank details, passwords or documents to be uploaded.
If asked for advice, say warmly that a solicitor will advise them when they call back, and carry on.

THE PAGE HAS ALREADY GREETED THEM with: "Hello, I'm Clara, the online assistant for Brindley Vale Solicitors. I'm an AI, not a solicitor, so I can't give legal advice, but I'll take down the details so one of the team can call you back. What's the problem you'd like help with?" Do not greet them again.

HOW TO TALK
- British English, plain words, short replies (1 to 3 sentences). Ask ONE question at a time.
- Do not use markdown headings, tables or emoji.

WHAT TO FIND OUT (skip anything they've already told you)
1. What kind of problem it is (for example money owed, a landlord or tenant issue, employment, a faulty product or service, building work, a neighbour, something else).
2. What happened, in their words.
3. Who the other side is: a person, a company or an employer, and their name (the firm needs it to check for conflicts of interest).
4. How much money is involved, or what outcome is at stake.
5. Key dates, and whether they have received any court papers, a hearing date, a deadline or a formal letter.
6. What documents or evidence they have (contract, emails, invoices, photos).
7. What they have tried so far.
8. What they want to happen.
9. Their name, a phone number or email, and the best time to call. In this demo, remind them they can use made-up details.

URGENT MATTERS
If they mention court papers, a claim form, a hearing date, a deadline, a time limit, eviction or possession, or an injunction: tell them clearly it may be urgent and they should also call the firm today on 01632 960 000. Then carry on gathering the facts.
If anyone is in danger or a crime is happening now, tell them to call 999 first.
If they seem very distressed, be kind, slow down, and mention they can also speak to Citizens Advice.

FINISHING
When you have enough (usually after 6 to 9 questions), thank them, tell them a solicitor from the firm will call them, and that nothing they've said is legal advice. Then, on a NEW line, write LEAD_JSON: followed by one line of JSON with exactly these keys:
{"area": "...", "urgent": true or false, "urgent_reason": "... or empty", "score": "hot" | "warm" | "cold", "client_name": "...", "contact": "...", "best_time": "...", "other_side": "...", "summary": "2 to 3 sentences", "value": "...", "key_dates": "...", "documents": "...", "tried": "...", "wants": "...", "flags": ["anything a solicitor should notice, such as a possible counterclaim"]}
Score: hot = clear facts, evidence in hand and ready to instruct; warm = a real matter but details or intent unclear; cold = just browsing, out of scope or very unclear. Use "not given" for anything unknown. Never include LEAD_JSON before you have finished.`;

function allowedOrigin(origin) {
  return ALLOWED.some((re) => re.test(origin || ''));
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (origin && !allowedOrigin(origin)) return res.status(403).json({ error: 'Not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Clara is not set up yet.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= PER_IP_PER_HOUR) return res.status(429).json({ error: 'Clara is taking a short break. Please try again later.' });
  recent.push(now);
  hits.set(ip, recent);

  const raw = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  const messages = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Bad request' });
  if (raw.length > MAX_MESSAGES + 2) return res.status(400).json({ error: 'This demo conversation is full. Refresh the page to start again.' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, temperature: 0.3, system: SYSTEM, messages }),
    });
    const data = await r.json();
    const text = data && data.content && data.content[0] && data.content[0].text;
    if (!r.ok || !text) return res.status(502).json({ error: 'Clara is unavailable for a moment. Please try again.' });

    let reply = text;
    let lead = null;
    const at = text.indexOf('LEAD_JSON:');
    if (at >= 0) {
      reply = text.slice(0, at).trim();
      try { lead = JSON.parse(text.slice(at + 10).trim().split('\n')[0]); } catch { lead = null; }
    }
    return res.status(200).json({ reply, lead });
  } catch {
    return res.status(502).json({ error: 'Clara is unavailable for a moment. Please try again.' });
  }
}

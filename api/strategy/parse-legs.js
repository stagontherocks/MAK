// Reads a pasted/uploaded screenshot of a broker or options-tool positions
// screen (Kite mobile, Opstra, etc.) and extracts each leg as structured
// JSON, using Gemini's vision API -- there's no OCR anywhere in this
// codebase, and screenshot layouts vary too much for a fixed parser.
// Raw fetch against the generateContent REST endpoint (no SDK), matching
// this repo's existing zero-dependency style for the Fyers endpoints.
const MODEL = 'gemini-2.5-flash'; // bump this if a newer Gemini model is available when you read this
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT = `You are given a screenshot of a trading/options positions screen from a brokerage or options-analytics tool (e.g. Zerodha Kite, Opstra, a custom trade tracker). Extract every individual position/leg visible in the image.

For each leg, return:
- "ticker": the contract description as shown or reconstructed (e.g. "HDFCBANK 29SEP2026 780CE", "RELIANCE 30OCT2026 1500PE", or a plain equity/futures ticker if that's all that's shown).
- "tradeType": "Buy" or "Sell" -- infer from a Buy/Sell badge, a negative quantity/lots (Sell), or "Buy Avg"/"Sell Avg" fields (whichever one is non-zero/filled indicates the side).
- "qty": the signed quantity as a number (negative for Sell, positive for Buy). If only lots are shown, use the signed lot count, not multiplied by lot size.
- "entryPrice": the average entry/buy/sell price as a plain number (no currency symbol).

Also try to identify a single common "underlying" symbol (the stock/index name shared by the legs, e.g. "HDFCBANK"), or null if the legs span multiple underlyings or none is clear.

Respond with ONLY a JSON object of this exact shape, no markdown fences, no explanation:
{"underlying": string|null, "legs": [{"ticker": string, "tradeType": "Buy"|"Sell", "qty": number, "entryPrice": number}]}`;

function stripJsonFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'not_configured', message: 'GEMINI_API_KEY is not set' });
    return;
  }

  const dataUrl = req.body && req.body.image;
  if (!dataUrl || typeof dataUrl !== 'string') {
    res.status(400).json({ error: 'missing_image' });
    return;
  }

  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    res.status(400).json({ error: 'invalid_image' });
    return;
  }
  const [, mimeType, base64Data] = match;

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mimeType, data: base64Data } },
          ],
        }],
        // Gemini can be told to only emit JSON -- still stripped defensively
        // below in case a future model wraps it in fences anyway.
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    const body = await geminiRes.json();
    if (!geminiRes.ok) {
      throw new Error(`Gemini API error: ${JSON.stringify(body)}`);
    }

    const candidate = body.candidates && body.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
    if (!text) throw new Error('Empty response from model');

    const parsed = JSON.parse(stripJsonFences(text));
    if (!parsed || !Array.isArray(parsed.legs)) throw new Error('Unexpected response shape from model');

    res.status(200).json({ status: 'ok', underlying: parsed.underlying || null, legs: parsed.legs });
  } catch (err) {
    res.status(502).json({ error: 'parse_failed', message: err.message });
  }
};

import { cfg } from './config.js';

/**
 * OpenAI-compatible /chat/completions with SSE streaming.
 * Yields text deltas. If LLM_BASE_URL is unset, echoes the user's last
 * message so the audio pipeline works without any LLM configured.
 */
export async function* streamChat(messages) {
  if (!cfg.llmBaseUrl) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const quoted = lastUser ? lastUser.content.replace(/[.!?…\s]+$/, '') : '';
    const echo = lastUser
      ? `Echo mode. I heard you say: ${quoted}. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the dot-env file to plug in your OpenAI compatible endpoint.`
      : 'Echo mode. Say something and I will repeat it back.';
    for (const word of echo.split(' ')) {
      yield word + ' ';
      await new Promise((r) => setTimeout(r, 25));
    }
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.llmApiKey) headers.Authorization = `Bearer ${cfg.llmApiKey}`;

  const res = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.llmModel,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 300,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${detail.slice(0, 200)}`);
  }

  let buf = '';
  const decoder = new TextDecoder();
  outer: for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break outer;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* partial/non-JSON keep-alive line */ }
    }
  }
}

/**
 * Incrementally pull complete sentences out of a streaming reply so TTS can
 * start on the first sentence while the LLM keeps talking.
 * Returns {sentences: string[], rest: string}.
 */
export function extractSentences(buffer) {
  const parts = buffer.split(/(?<=[.!?…])\s+|\n+/);
  const sentences = parts.slice(0, -1).map(cleanForSpeech).filter(Boolean);
  return { sentences, rest: parts[parts.length - 1] };
}

export function cleanForSpeech(text) {
  return text
    .replace(/_/g, ' ')
    .replace(/[*`#>~[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

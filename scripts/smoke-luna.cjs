// Six small, billable requests using fictional data only. No database writes.
// Loads the ignored local key without printing it or including it in errors.
const assert = require('node:assert/strict');
const { createLoader } = require('./load-typescript.cjs');
require('@next/env').loadEnvConfig(process.cwd());
const usageRows = [];
const load = createLoader({
  '@/lib/usage': { recordUsage: async (feature, usage, model) => usageRows.push({ feature, usage, model }) },
  'node:fs/promises': { appendFile: async () => {} }, // no classification debug files
});
const { normalizeUsage } = load('lib/usage-tokens.ts');
const results = [];
const request = (body) => new Request('http://localhost/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function runJson(route, body, validate) {
  const before = usageRows.length;
  const start = Date.now();
  const response = await route.POST(request(body));
  assert.equal(response.status, 200, 'API route did not succeed; inspect provider access/billing');
  const data = await response.json();
  validate(data);
  const row = usageRows.slice(before).at(-1);
  assert.ok(row?.usage, 'No metered provider usage returned');
  const tokens = normalizeUsage(row.usage, row.model);
  results.push({ feature: row.feature, ms: Date.now() - start, ...tokens });
}

async function main() {
  assert.ok(process.env.OPENAI_API_KEY, 'Set OPENAI_API_KEY in .env.local first');
  const classify = load('app/api/classify-moment/route.ts');
  for (let i = 0; i < 3; i++) {
    await runJson(classify, {
      utterances: [
        { speaker: 'interviewer', text: ['Tell me about a difficult engineering project.',
          'How did you measure the impact of your work?', 'How do you prioritize reliability improvements?'][i] },
        { speaker: 'candidate', text: 'In my previous role I worked on a small team and owned the implementation and evaluation.' },
      ], currentState: 'idle', msSinceLastTranscript: 4000,
    }, data => assert.ok(['interviewer_speaking', 'question_finalized', 'candidate_questioning', 'closing'].includes(data.state)));
  }

  const commentary = load('app/api/commentary/route.ts');
  for (let i = 0; i < 2; i++) {
    const before = usageRows.length;
    const start = Date.now();
    const response = await commentary.POST(request({
      jd: 'Fictional Acme: backend engineer responsible for reliable APIs, observability and cross-team collaboration.',
      resume: 'Fictional candidate: built a Python API, added monitoring, and reduced p95 latency from 500ms to 250ms.',
      question: i === 0 ? 'Tell me about an API improvement.' : 'How did you measure the result?',
      answer: i === 0 ? 'I added monitoring and optimized a slow database query. The API became faster.' :
        'We compared p95 latency before and after the change, from 500ms to 250ms, with similar traffic.',
      lang: 'en', mode: 'answer',
    }));
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = ''; let firstChunkMs;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      firstChunkMs ??= Date.now() - start;
      raw += decoder.decode(chunk.value, { stream: true });
    }
    const events = raw.split('\n').filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6)));
    assert.ok(!events.some(x => x.type === 'error'), 'Streaming provider error');
    assert.ok(events.some(x => x.type === 'done'), 'Missing SSE completion');
    const text = events.filter(x => x.type === 'delta').map(x => x.text).join('');
    assert.match(text, /---SAY---/);
    assert.match(text, /Try:/);
    const row = usageRows.slice(before).at(-1);
    assert.ok(row?.usage, 'No streamed usage returned');
    results.push({ feature: 'commentary', ms: Date.now() - start, firstChunkMs,
      ...normalizeUsage(row.usage, row.model) });
  }

  await runJson(load('app/api/detect-question/route.ts'), {
    utterance: 'Can you tell me about a time you improved an API?', recentContext: 'Let us begin the interview.',
  }, data => assert.equal(data.isQuestion, true));

  console.log(JSON.stringify({ model: 'gpt-6-luna', results, cacheObserved: results.some(x => x.cached > 0),
    estimatedCostUsd: results.reduce((sum, x) => sum + (x.input * 0.10 + x.cached * 0.01 + x.written * 0.125 + x.output * 0.50) / 1e6, 0),
  }, null, 2));
  assert.ok(results.slice(1, 3).some(x => x.cached > 0), 'Classifier prefix did not hit cache; investigate before deployment');
  assert.ok(results[4].cached > 0, 'Commentary rules did not hit cache; investigate before deployment');
}

// Next.js and HTTP clients may retain background handles after the checks.
// The script has no DB/background writes to drain once main completes.
main().then(() => process.exit(0)).catch(error => {
  // No raw provider error/body/headers: they can contain credentials or data.
  console.error(JSON.stringify({ check: 'luna-smoke', failed: true,
    errorType: error.name, status: error.status,
    message: error.name === 'AssertionError' ? error.message : 'Provider request failed; inspect key permissions, quota and connectivity',
    completed: results,
  }, null, 2));
  process.exit(1);
});

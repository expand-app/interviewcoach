const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./load-typescript.cjs');
const load = createLoader();
const { prepareLunaRequest } = load('lib/luna-request.ts');
const { normalizeUsage } = load('lib/usage-tokens.ts');
const { assertFinalizedQuestion } = require('./luna-smoke-assertions.cjs');

test('classification smoke rejects malformed model output hidden by route fallbacks', async () => {
  const question = 'How did you measure the impact of your work?';
  let modelText;
  const routeLoad = createLoader({
    '@/lib/luna-client': { LUNA_MODEL: 'gpt-6-luna', getLunaClient: () => ({ chat: { completions: {
      create: async () => ({ choices: [{ message: { content: modelText } }] }),
    } } }) },
    'node:fs/promises': { appendFile: async () => {} },
  });
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-a-secret';
  try {
    const route = routeLoad('app/api/classify-moment/route.ts');
    const body = { utterances: [
      { speaker: 'interviewer', text: question },
      { speaker: 'candidate', text: 'In my previous role I compared the latency before and after the release using traces.' },
    ], currentState: 'idle', msSinceLastTranscript: 4000 };
    for (const bad of ['not JSON', '{}', '{"state":"nonsense"}',
      '{"state":"question_finalized","question":""}',
      '{"state":"question_finalized","question":"What is your favorite food?"}']) {
      modelText = bad;
      const response = await route.POST(new Request('http://localhost/test', { method: 'POST', body: JSON.stringify(body) }));
      assert.equal(response.status, 200); // intentional product fallback
      const data = await response.json();
      assert.throws(() => assertFinalizedQuestion(data, question)); // smoke must reject it
    }
    modelText = JSON.stringify({ state: 'question_finalized', question, summary: 'Discussing impact', questionRelation: 'new_topic' });
    const response = await route.POST(new Request('http://localhost/test', { method: 'POST', body: JSON.stringify(body) }));
    assertFinalizedQuestion(await response.json(), question);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('mock-interview turns reuse fixed prefixes while slot/depth/answers remain uncached', async () => {
  const requests = [];
  let modelResult = { action: 'next', utterance: 'You measured latency. Let us discuss reliability.' };
  const routeLoad = createLoader({ '@/lib/luna-client': {
    LUNA_MODEL: 'gpt-6-luna', getLunaClient: () => ({ chat: { completions: {
      create: async params => {
        requests.push(prepareLunaRequest(params, 'mock_interviewer'));
        return { choices: [{ message: { content: JSON.stringify(modelResult) } }] };
      },
    } } }),
  } });
  const route = routeLoad('app/api/mock-interviewer/next-turn/route.ts');
  const base = { jd: 'FIXED_ROLE_DESCRIPTION', language: 'en', followupDepth: 0,
    planSlots: ['SLOT_ZERO', 'SLOT_ONE', 'SLOT_TWO'].map(question => ({ question, topic: 'engineering', style: 'behavioral', allowFollowups: true })) };
  async function turn(body) {
    const response = await route.POST(new Request('http://localhost/test', { method: 'POST', body: JSON.stringify({ ...base, ...body }) }));
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  await turn({ currentSlotIndex: 0, currentQuestionText: 'CHANGING_QUESTION_ZERO',
    candidateAnswer: 'CHANGING_ANSWER_ZERO: I measured API latency and improved our slow query.',
    recentTranscript: [{ speaker: 'candidate', text: 'CHANGING_TRANSCRIPT_ZERO' }] });
  await turn({ currentSlotIndex: 1, currentQuestionText: 'CHANGING_QUESTION_ONE', followupDepth: 1,
    candidateAnswer: 'CHANGING_ANSWER_ONE: I added a dashboard showing error rates and API latency.',
    recentTranscript: [{ speaker: 'candidate', text: 'CHANGING_TRANSCRIPT_ONE' }] });
  assert.deepEqual(requests[0].messages.slice(0, 2), requests[1].messages.slice(0, 2));
  for (const request of requests) {
    assert.equal(request.prompt_cache_options.mode, 'explicit');
    for (const message of request.messages.slice(0, 2)) {
      assert.deepEqual(message.content[0].prompt_cache_breakpoint, { mode: 'explicit' });
    }
    assert.match(request.messages[1].content[0].text, /FIXED_ROLE_DESCRIPTION/);
    assert.doesNotMatch(JSON.stringify(request.messages.slice(0, 2)), /CHANGING_|SLOT_ZERO|SLOT_ONE|SLOT_TWO/);
    assert.equal(request.messages[2].role, 'user');
  }
  assert.match(requests[0].messages[2].content, /currentSlotIndex: 0/);
  assert.match(requests[1].messages[2].content, /currentSlotIndex: 1/);
  assert.match(requests[1].messages[2].content, /follow-up depth 1/);
  assert.match(requests[1].messages[2].content, /CHANGING_ANSWER_ONE/);
  assert.match(requests[1].messages[2].content, /CHANGING_TRANSCRIPT_ONE/);
  // Keep the existing product guard: forbidden probes must never be spoken.
  modelResult = { action: 'followup', utterance: 'FORBIDDEN_PROBE' };
  const result = await turn({ currentSlotIndex: 0, currentQuestionText: 'Question', followupDepth: 2,
    candidateAnswer: 'I measured API latency and improved the query execution plan substantially.' });
  assert.equal(result.action, 'next');
  assert.equal(result.nextSlotIndex, 1);
  assert.equal(result.utterance, '');
  const count = requests.length;
  assert.equal((await turn({ currentSlotIndex: 2, currentQuestionText: 'Last question', followupDepth: 2, candidateAnswer: 'Done.' })).action, 'wrapup');
  assert.equal(requests.length, count); // final unprobeable turn still avoids an API call
});

test('changing dialogue leaves reusable rule/session prefixes identical', () => {
  const base = { model: 'gpt-6-luna', max_completion_tokens: 600, messages: [
    { role: 'system', content: 'Shared coaching rules' },
    { role: 'developer', content: 'JD and resume fixed for this session' },
    { role: 'user', content: 'First answer' },
  ] };
  const first = prepareLunaRequest(base, 'commentary');
  const second = prepareLunaRequest({ ...base, messages: [
    ...base.messages.slice(0, 2), { role: 'user', content: 'New question and answer' },
  ] }, 'commentary');
  assert.deepEqual(first.messages.slice(0, 2), second.messages.slice(0, 2));
  assert.deepEqual(first.messages[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(first.messages[2].content, 'First answer');
  assert.deepEqual(first.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
  assert.equal(first.reasoning_effort, 'none');
  assert.equal(first.max_completion_tokens, 600);
  assert.equal(base.messages[0].role, 'system'); // caller's data was not mutated
  assert.equal(base.messages[0].content, 'Shared coaching rules');
});

test('one-shot user-only requests do not create cache writes', () => {
  const request = prepareLunaRequest({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Plan an interview' }] });
  assert.equal(request.prompt_cache_options.mode, 'explicit');
  assert.equal(request.messages[0].content, 'Plan an interview');
});

test('OpenAI cache reads/writes are exclusive billing buckets', () => {
  const tokens = normalizeUsage({ prompt_tokens: 2000, completion_tokens: 60,
    prompt_tokens_details: { cached_tokens: 1200, cache_write_tokens: 500 } }, 'gpt-6-luna');
  assert.deepEqual(tokens, { provider: 'openai', input: 300, output: 60, cached: 1200,
    written: 500, total: 2060, splitMissing: false });
  assert.equal(tokens.input + tokens.cached + tokens.written, 2000);
});

test('missing usage details are flagged and historical DeepSeek usage is preserved', () => {
  assert.equal(normalizeUsage({ prompt_tokens: 100 }, 'gpt-6-luna').splitMissing, true);
  const old = normalizeUsage({ prompt_tokens: 2000, prompt_cache_hit_tokens: 1800, completion_tokens: 20 }, 'deepseek-flash');
  assert.equal(old.provider, 'deepseek');
  assert.equal(old.input, 200);
  assert.equal(old.cached, 1800);
  assert.equal(old.written, 0);
  assert.equal(old.splitMissing, false);
});

test('usage persistence records OpenAI billing buckets and provider in SQL', async () => {
  let insert;
  const dbLoad = createLoader({ '@/lib/db': {
    isDbConfigured: () => true,
    ensureMigrated: async () => {},
    query: async (sql, values) => { insert = { sql, values }; },
  } });
  await dbLoad('lib/usage.ts').recordUsage('commentary', {
    prompt_tokens: 2000, completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 1200, cache_write_tokens: 500 },
  }, 'gpt-6-luna');
  assert.match(insert.sql, /provider/);
  assert.deepEqual(insert.values, ['commentary', 'openai', 'gpt-6-luna', 300, 50, 1200, 500, 2050, false]);
});

test('all commentary modes retain session context and exclude changing data from cached prefixes', async () => {
  const requests = [];
  const routeLoad = createLoader({
    '@/lib/luna-client': { LUNA_MODEL: 'gpt-6-luna', getLunaClient: () => ({ chat: { completions: {
      create: async (params) => {
        requests.push(prepareLunaRequest(params, 'commentary'));
        return (async function* () {
          yield { choices: [{ delta: { content: 'Observation\n---SAY---\nTry: "Example"' } }] };
          yield { choices: [], usage: { prompt_tokens: 2000, completion_tokens: 20 } };
        })();
      },
    } } }) },
    '@/lib/usage': { recordUsage: async () => {} },
  });
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-a-secret';
  try {
    const route = routeLoad('app/api/commentary/route.ts');
    for (const lang of ['en', 'zh']) {
      for (const mode of ['answer', 'listening', 'candidate_question']) {
        const base = { jd: 'UNIQUE_JOB_CONTEXT', resume: 'UNIQUE_RESUME_CONTEXT',
          interviewerProfile: 'UNIQUE_INTERVIEWER_CONTEXT', lang, mode,
          question: 'UNIQUE_CURRENT_QUESTION', answer: 'UNIQUE_CURRENT_ANSWER',
          interviewerMonologue: 'UNIQUE_MONOLOGUE', candidateQuestion: 'UNIQUE_CANDIDATE_QUESTION',
          priorComments: ['UNIQUE_PRIOR_COMMENT'], recentDialogue: [{ speaker: 'interviewer', text: 'UNIQUE_DIALOGUE' }],
        };
        for (const question of ['UNIQUE_CURRENT_QUESTION', 'CHANGED_QUESTION']) {
          const response = await route.POST(new Request('http://localhost/api/commentary', {
            method: 'POST', body: JSON.stringify({ ...base, question }),
          }));
          assert.equal(response.status, 200);
          assert.match(await response.text(), /done/);
        }
        const [first, second] = requests.slice(-2);
        assert.deepEqual(first.messages.slice(0, 2), second.messages.slice(0, 2));
        const context = first.messages[1].content[0].text;
        assert.match(context, /UNIQUE_JOB_CONTEXT/);
        assert.match(context, /UNIQUE_RESUME_CONTEXT/);
        assert.match(context, /UNIQUE_INTERVIEWER_CONTEXT/);
        assert.doesNotMatch(JSON.stringify(first.messages.slice(0, 2)), /UNIQUE_CURRENT|UNIQUE_DIALOGUE|UNIQUE_PRIOR_COMMENT|UNIQUE_MONOLOGUE|UNIQUE_CANDIDATE_QUESTION/);
        if (mode === 'answer') {
          assert.match(first.messages[2].content, /UNIQUE_CURRENT_QUESTION/);
          assert.match(second.messages[2].content, /CHANGED_QUESTION/);
          assert.match(first.messages[2].content, /UNIQUE_CURRENT_ANSWER/);
          assert.match(first.messages[2].content, /UNIQUE_PRIOR_COMMENT/);
        }
        assert.match(first.messages[2].content, /UNIQUE_DIALOGUE/);
      }
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('SDK transport sends Luna settings and preserves JSON and streaming usage', async () => {
  const requests = [];
  const recorded = [];
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const usage = { prompt_tokens: 1600, completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 1200, cache_write_tokens: 0 } };
    if (body.stream) {
      const chunks = [
        { id: 'test', object: 'chat.completion.chunk', created: 0, model: body.model,
          choices: [{ index: 0, delta: { content: 'Observation\n---SAY---\nTry: "A concise example"' } }] },
        { id: 'test', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage },
      ];
      return new Response(chunks.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ id: 'test', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"isQuestion":true,"question":"Tell me about your work"}' }, finish_reason: 'stop' }], usage }),
      { headers: { 'content-type': 'application/json' } });
  };
  const sdkLoad = createLoader({ 'node-fetch': transport, '@/lib/usage': {
    recordUsage: async (...args) => recorded.push(args),
  } });
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-a-secret';
  try {
    const { getLunaClient, LUNA_MODEL } = sdkLoad('lib/luna-client.ts');
    const client = getLunaClient('detect_question');
    const args = { model: LUNA_MODEL, max_completion_tokens: 200,
      messages: [{ role: 'system', content: 'Return JSON' }, { role: 'user', content: 'Tell me about your work' }] };
    const response = await client.chat.completions.create(args);
    assert.equal(JSON.parse(response.choices[0].message.content).isQuestion, true);
    assert.equal(recorded.length, 1);
    const stream = await client.chat.completions.create({ ...args, stream: true, stream_options: { include_usage: true } });
    let text = ''; let usage;
    for await (const chunk of stream) { text += chunk.choices[0]?.delta?.content || ''; if (chunk.usage) usage = chunk.usage; }
    assert.match(text, /---SAY---/);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 1200);
    assert.equal(recorded.length, 1); // streaming route meters its final chunk
    for (const request of requests) {
      assert.equal(request.model, 'gpt-6-luna');
      assert.equal(request.reasoning_effort, 'none');
      assert.equal(request.thinking, undefined);
      assert.equal(request.max_tokens, undefined);
      assert.equal(request.prompt_cache_options.mode, 'explicit');
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

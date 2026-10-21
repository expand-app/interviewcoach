// Eight small, billable requests using fictional data only. No database writes.
// Loads the ignored local key without printing it or including it in errors.
const assert = require('node:assert/strict');
const { createLoader } = require('./load-typescript.cjs');
const { assertFinalizedQuestion } = require('./luna-smoke-assertions.cjs');
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
  const questions = ['Tell me about a difficult engineering project.',
    'How did you measure the impact of your work?', 'How do you prioritize reliability improvements?'];
  for (let i = 0; i < 3; i++) {
    await runJson(classify, {
      utterances: [
        { speaker: 'interviewer', text: questions[i] },
        { speaker: 'candidate', text: 'In my previous role I worked on a small team and owned the implementation and evaluation.' },
      ], currentState: 'idle', msSinceLastTranscript: 4000,
    }, data => assertFinalizedQuestion(data, questions[i]));
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

  const nextTurn = load('app/api/mock-interviewer/next-turn/route.ts');
  // A representative, detailed role description provides a reusable prefix
  // above the cache minimum. Short production prompts may remain ineligible;
  // never pad real requests merely to reach the minimum.
  const jd = `虚构 Acme 公司招聘高级后端工程师，面试以英语进行。团队负责面向企业客户的账户、权限、订阅计费和审计记录服务。候选人需要能清楚解释自己的具体职责、实际做出的技术决策以及可验证的业务结果，不要求有特定公司的工作经历。
岗位职责：设计和维护可靠的接口，定义清晰的错误契约和幂等语义，保证新旧客户端在数据结构演进期间保持兼容。设计数据库迁移方案，评估索引、查询计划、连接池和事务隔离级别，能够解释一致性、可用性和执行成本之间的取舍。对数据修改提供审计记录，避免在日志中暴露客户隐私信息。
性能优化：针对高延迟或资源消耗异常，先建立可比较的基线，再通过请求追踪、数据库指标和应用日志定位瓶颈。分析平均值与高分位延迟的区别，验证缓存策略是否真正减少数据库负载，明确失效条件、更新延迟和热点数据带来的风险。优化完成后应说明观测周期、流量差异和测量结果的局限。
系统可靠性：为关键路径定义服务等级目标和可执行告警，完善超时、重试、退避、限流与队列背压。能够解释重复消息、部分失败、下游不可用和突发流量时系统的行为。设计回滚计划、渐进发布和功能开关，避免把无法恢复的数据变更与业务功能一次性发布。发生故障后组织复盘，把根因和改进责任落实到具体任务。
协作要求：与产品经理、安全工程师和客户支持共同确认需求，主动澄清模糊约束，在交付速度、维护成本和用户体验之间提出有证据的建议。面对技术争议，需要描述各方观点、讨论中使用的事实、最后的决定及后续验证方式。通过设计文档和运行手册帮助其他同事理解并维护系统，而不是让知识只保留在个人脑中。
工程实践：编写能发现真实缺陷的单元测试与集成测试，区分业务逻辑错误、依赖服务失败和环境配置问题。通过代码审查明确变化影响，关注向后兼容、错误恢复、可观测性和资源释放。定期处理维护任务，解释如何在开发新功能和偿还技术债之间安排优先级。辅导团队成员时应分享推理过程，鼓励先验证假设再进行大范围重构。
面试评估：优先追问候选人实际负责的部分、考虑过的替代方案和最终结果。候选人提到提升延迟、成功率或成本时，应关注指标口径和比较条件；候选人给出完整且有证据的解释后，应自然转到下一道计划问题。所有案例均为虚构，不应索取真实客户、雇主或生产系统的保密资料。`;
  for (let i = 0; i < 2; i++) {
    await runJson(nextTurn, {
      jd, language: 'en',
      planSlots: questions.map(question => ({ question, topic: 'engineering', style: 'behavioral', allowFollowups: false })),
      currentSlotIndex: i, currentQuestionText: questions[i], followupDepth: 0,
      candidateAnswer: i === 0 ? 'I added monitoring and optimized our slow database query, reducing p95 latency from 500ms to 250ms.' :
        'We measured latency with request traces and compared similar traffic before and after the release.',
      recentTranscript: [],
    }, data => {
      assert.equal(data.result?.action, 'next');
      assert.equal(data.result.nextSlotIndex, i + 1);
      assert.ok(data.result.utterance.trim(), 'Mock interviewer returned an empty transition');
    });
  }

  console.log(JSON.stringify({ model: 'gpt-6-luna', results, cacheObserved: results.some(x => x.cached > 0),
    estimatedCostUsd: results.reduce((sum, x) => sum + (x.input * 0.10 + x.cached * 0.01 + x.written * 0.125 + x.output * 0.50) / 1e6, 0),
  }, null, 2));
  assert.ok(results.slice(1, 3).some(x => x.cached > 0), 'Classifier prefix did not hit cache; investigate before deployment');
  assert.ok(results[4].cached > 0, 'Commentary rules did not hit cache; investigate before deployment');
  assert.ok(results[7].cached > 0, 'Mock-interview rules/context did not hit cache across turns; investigate before deployment');
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

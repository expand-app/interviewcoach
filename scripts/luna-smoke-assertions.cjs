const assert = require('node:assert/strict');

// Do not accept the route's safe fallback as evidence that the model worked.
// Fixtures contain an unambiguously completed interviewer question followed by
// a substantive answer. The expected question must preserve the actual words.
exports.assertFinalizedQuestion = function assertFinalizedQuestion(data, expected) {
  assert.equal(data.state, 'question_finalized', 'Expected a finalized interviewer question, not a fallback state');
  assert.equal(typeof data.question, 'string', 'Missing finalized question');
  const normalize = text => text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
  assert.ok(normalize(data.question), 'Finalized question is empty');
  assert.equal(normalize(data.question), normalize(expected), 'Finalized question must match the interviewer question');
};

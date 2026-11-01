import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewContext } from '../shared/review-context.mjs';
const candidate = { head: 'a'.repeat(40), tree: 'b'.repeat(40) };
const report = 'runs/run_aaaa/review/final.md';
const context = () => ({ baseCommit: 'c'.repeat(40), candidate, reviewers: [{ agentId: '000999a8-5ec6-4a17-aba3-132b6f13bf22', model: 'review-model', report }] });
test('explicit reviewer provenance is candidate-bound reported evidence, not managed verification', () => {
  assert.equal(normalizeReviewContext(undefined, candidate, []), null);
  assert.deepEqual(normalizeReviewContext(context(), candidate, [report]), context());
  assert.throws(() => normalizeReviewContext(context(), { ...candidate, tree: 'd'.repeat(40) }, [report]), /candidate/);
  assert.throws(() => normalizeReviewContext(context(), candidate, []), /report in this decision/);
  assert.throws(() => normalizeReviewContext({ ...context(), verified: true }, candidate, [report]));
  assert.throws(() => normalizeReviewContext({ ...context(), reviewers: [...context().reviewers, ...context().reviewers] }, candidate, [report]), /only once/);
  assert.throws(() => normalizeReviewContext({ ...context(), baseCommit: '--output=bad' }, candidate, [report]));
});

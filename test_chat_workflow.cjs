'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMessage, trimHistory, parseResponse, send } = require('./chat-workflow.js');

const analysis = {
  reply: 'I can help with that.', summary: 'Routine request', intent: 'Information',
  urgency: 'Low', risk: 'Low', review_required: false,
  suggested_action: 'accept', sensitive_info_requested: false
};
const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('normalizes and rejects empty caller messages before starting a request', async () => {
  assert.equal(normalizeMessage('  hello  '), 'hello');
  assert.equal(normalizeMessage('  \n'), '');
  let requested = false;
  let settled = false;
  await assert.rejects(send({
    text: ' ', request: async () => { requested = true; return response(analysis); },
    onSettled: () => { settled = true; }
  }), /Type a caller message first/);
  assert.equal(requested, false);
  assert.equal(settled, false);
});

test('keeps request history within the backend limit without reordering turns', () => {
  const history = Array.from({ length: 75 }, (_, index) => ({ content: `${index}` }));
  const trimmed = trimHistory(history);
  assert.equal(trimmed.length, 60);
  assert.equal(trimmed[0].content, '15');
  assert.equal(trimmed.at(-1).content, '74');
});

test('parses the assistant analysis response returned by POST /chat', async () => {
  assert.deepEqual(await parseResponse(response(analysis)), analysis);
});

test('shows backend error details and always settles the loading state on failure', async () => {
  const events = [];
  const result = await send({
    text: 'hello',
    request: async () => response({ detail: 'Gemini could not respond right now.' }, false, 502),
    onPending: () => events.push('pending'),
    onSuccess: () => events.push('success'),
    onFailure: (error) => events.push(`error:${error.message}`),
    onSettled: () => events.push('settled')
  });
  assert.equal(result, null);
  assert.deepEqual(events, ['pending', 'error:Gemini could not respond right now.', 'settled']);
});

test('loading state settles after a successful response', async () => {
  const events = [];
  const result = await send({
    text: 'hello', request: async () => response(analysis),
    onPending: () => events.push('pending'),
    onSuccess: (data) => events.push(`success:${data.reply}`),
    onFailure: () => events.push('error'),
    onSettled: () => events.push('settled')
  });
  assert.equal(result.reply, analysis.reply);
  assert.deepEqual(events, ['pending', 'success:I can help with that.', 'settled']);
});

test('rejects malformed JSON and response schemas without claiming success', async () => {
  await assert.rejects(parseResponse({ ok: true, status: 200, json: async () => { throw new Error('bad JSON'); } }), /invalid JSON/);
  await assert.rejects(parseResponse(response({ reply: 'missing analysis fields' })), /incomplete call analysis/);
});

test('can retry a failed send as a separate request without duplicating workflow callbacks', async () => {
  let attempts = 0;
  const sent = [];
  const request = async (text) => {
    attempts += 1;
    sent.push(text);
    return attempts === 1
      ? response({ detail: 'Try again.' }, false, 502)
      : response(analysis);
  };
  await send({ text: 'same text', request });
  const result = await send({ text: 'same text', request });
  assert.equal(result.reply, analysis.reply);
  assert.deepEqual(sent, ['same text', 'same text']);
});

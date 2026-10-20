const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modelAllowed, modelFromPath, fetchModels } = require('../lib/models.cjs');
const { validateConfig } = require('../lib/config.cjs');
test('model policy normalizes Google prefixes and casing but preserves unrelated identifiers', () => {
  assert.equal(modelAllowed('models/BLOCKED', ['blocked']), false);
  assert.equal(modelAllowed('open', ['blocked']), true);
  assert.equal(modelAllowed('', []), false);
  assert.equal(modelFromPath('/v1beta/models/test:streamGenerateContent'), 'test');
  assert.equal(modelFromPath('/v1/models/test'), 'test');
});
test('model settings validate and migrate existing configuration without losing connection settings', () => {
  const config = validateConfig({ hostname: 'api.example.com', protocol: 'http2', knownModels: ['open', 'blocked'], disabledModels: ['models/BLOCKED'] });
  assert.deepEqual(config.disabledModels, ['blocked']);
  assert.equal(config.hostname, 'api.example.com');
  assert.deepEqual(validateConfig({ protocol: 'http2' }).disabledModels, []);
  assert.throws(() => validateConfig({ disabledModels: [null] }));
});
test('model discovery reads complete local model list and handles errors without returning credentials', async () => {
  const result = await fetchModels({ upstream: 'http://127.0.0.1:8317' }, { upstreamKey: 'private' }, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8317/v1/models');
    assert.equal(options.headers.authorization, 'Bearer private');
    return new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, { invalid: true }] }));
  });
  assert.deepEqual(result, ['a', 'b']);
  await assert.rejects(fetchModels({}, {}, async () => new Response('{}', { status: 401 })), /HTTP 401/);
});

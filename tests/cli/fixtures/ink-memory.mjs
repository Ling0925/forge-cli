// Synthetic text only: never load Forge settings, sessions or user data.
import assert from 'node:assert/strict';
const root = new URL('./', import.meta.resolve('ink'));
const { default: measure } = await import(new URL('measure-text.js', root));
const { default: wrap } = await import(new URL('wrap-text.js', root));
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
function heap() { global.gc(); return process.memoryUsage().heapUsed; }
function churn(start, count) {
  for (let i = start; i < start + count; i++) {
    const text = `${i}: ${'synthetic thinking content '.repeat(40)}`;
    measure(text);
    wrap(text, 79, 'truncate');
  }
}
churn(0, 2000);
const before = heap();
churn(2000, 20000);
const middle = heap();
churn(22000, 20000);
const after = heap();
const report = { before, middle, after, growth: after - before, lateGrowth: after - middle };
console.log(JSON.stringify(report));
if (!process.argv.includes('--observe')) {
  assert.ok(report.growth < 16 * 1024 * 1024, `Retained heap grew by ${report.growth} bytes`);
  assert.ok(report.lateGrowth < 8 * 1024 * 1024, `Second batch retained ${report.lateGrowth} bytes`);
  const { default: TextCache } = await import(new URL('text-cache.js', root));
  const cache = new TextCache(2, 4096);
  cache.set('a', 'A'); cache.set('b', 'B'); assert.equal(cache.get('a'), 'A');
  cache.set('c', 'C'); assert.equal(cache.get('b'), undefined);
  cache.set('a', 'replacement'); assert.equal(cache.entries.size, 2);
  cache.set('huge', 'x'.repeat(4096)); assert.equal(cache.get('huge'), undefined);
  assert.ok(cache.retainedBytes <= 4096);
  const bytes = new TextCache(2048, 1024);
  for (let i = 0; i < 100; i++) bytes.set(String(i), 'x'.repeat(200));
  assert.ok(bytes.entries.size < 3); assert.ok(bytes.retainedBytes <= 1024);
  bytes.set('empty', ''); assert.equal(bytes.get('empty'), '');
  const disabled = new TextCache(0); disabled.set('a', 'A'); assert.equal(disabled.entries.size, 0);
  // Eviction must affect retention only, never rendering semantics.
  assert.deepEqual(measure('中文\né'), { width: 4, height: 2 });
  assert.equal(wrap('abcdefgh', 4, 'truncate'), 'abc…');
  assert.equal(wrap('abcdefgh', 4, 'truncate-start'), '…fgh');
  assert.equal(wrap('abcdefgh', 4, 'truncate-middle'), 'ab…h');
  assert.equal(wrap('abcd', 2, 'wrap'), 'ab\ncd');
  // The former concatenated key collided for text=foo1,width=2 and text=foo,width=12.
  assert.equal(wrap('foo1', 2, 'truncate'), 'f…');
  assert.equal(wrap('foo', 12, 'truncate'), 'foo');
}

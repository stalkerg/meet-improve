const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TextBlocks, Timings } = require('../panel.js');
const { paragraphs } = require('../captions.js');

function element() {
  const result = { children: [], childNodes: [], firstChild: null,
    ownerDocument: { createElement: () => element() },
    append(child) { this.children.push(child); child.parent = this; },
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
    set textContent(text) {
      const node = { nodeType: 3, data: text, replaceData(start, count, value) {
        this.data = this.data.slice(0, start) + value + this.data.slice(start + count);
      } };
      this.firstChild = node; this.childNodes = [node];
    },
  };
  return result;
}

test('incremental rendering leaves archived nodes and selected prefix text intact', () => {
  const root = element(); let formatted = 0;
  const renderer = new TextBlocks(root, (...args) => { formatted++; return paragraphs(...args); });
  const items = Array.from({ length: 3200 }, (_, i) => ({ id: String(i), speaker: 'A', text: `Sentence ${i}.` }));
  renderer.update(items, 0); renderer.render();
  assert.equal(root.children.length, 100); assert.equal(formatted, 100);
  const old = [...root.children], first = old[0].firstChild, last = old.at(-1).firstChild;
  const revised = [...items]; revised[3199] = { ...revised[3199], text: 'Corrected last sentence.' };
  renderer.update(revised, 3199); renderer.render();
  assert.equal(formatted, 101);
  assert.deepEqual(root.children, old);
  assert.strictEqual(root.children[0].firstChild, first);
  assert.strictEqual(root.children.at(-1).firstChild, last);
  assert.match(last.data, /Corrected last sentence/);
  renderer.update(revised, Infinity); renderer.render(); assert.equal(formatted, 101);
});

test('hidden original rendering accumulates earliest dirty index and removes deleted blocks', () => {
  const root = element(); const renderer = new TextBlocks(root, paragraphs);
  const items = Array.from({ length: 100 }, (_, i) => ({ speaker: 'A', text: String(i) }));
  renderer.update(items, 0); renderer.render();
  const changed = [...items]; changed[50] = { speaker: 'B', text: 'Changed' };
  renderer.update(changed, 50); renderer.update(changed.slice(0, 65), 65);
  renderer.render();
  assert.equal(root.children.length, 3);
  assert.match(root.children[1].firstChild.data, /B: Changed/);
  renderer.update([], 0); renderer.render(); assert.equal(root.children.length, 0);
});

test('timings are bounded numeric-only samples and report p50/p95 without counting nulls', () => {
  const timings = new Timings();
  assert.match(timings.summary(), /n\/a/);
  timings.add({ requestMs: 8000, firstMs: 2000, lagMs: 6000, discarded: false });
  timings.add({ requestMs: 10000, firstMs: null, lagMs: null, discarded: true });
  assert.match(timings.summary(), /request p50\/p95 8.0 s \/ 10.0 s/);
  assert.match(timings.summary(), /First useful text p50\/p95 2.0 s \/ 2.0 s/);
  for (let i = 0; i < 200; i++) timings.add({ requestMs: i });
  assert.equal(timings.samples.length, 128);
  assert.equal(timings.discarded, 1);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDraggable } = require('../panel.js');

function surface() {
  const listeners = new Map();
  return {
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    emit(name, props = {}) {
      const event = { pointerId: 1, button: 0, isPrimary: true, clientX: 620, clientY: 30,
        target: { closest: () => null }, preventDefault() { this.prevented = true; }, ...props };
      for (const fn of listeners.get(name) || []) fn(event);
      return event;
    },
  };
}
function fixture() {
  let onResize;
  const view = Object.assign(surface(), { innerWidth: 1000, innerHeight: 800 });
  view.ResizeObserver = class {
    constructor(fn) { onResize = fn; }
    observe(target) { assert.equal(target, host); }
  };
  const host = {
    ownerDocument: { defaultView: view }, style: {}, width: 380, height: 180,
    getBoundingClientRect() {
      const left = parseFloat(this.style.left ?? '604'), top = parseFloat(this.style.top ?? '16');
      return { left, top, width: this.width, height: this.height, right: left + this.width, bottom: top + this.height };
    },
  };
  const captured = new Set(), attributes = new Map();
  const handle = Object.assign(surface(), {
    setPointerCapture(id) { captured.add(id); },
    hasPointerCapture(id) { return captured.has(id); },
    releasePointerCapture(id) { captured.delete(id); this.emit('lostpointercapture', { pointerId: id }); },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  });
  makeDraggable(host, handle);
  return { view, host, handle, captured, attributes, resize: () => onResize() };
}

test('drag preserves grab offset and uses pointer capture', () => {
  const { handle, host, captured, attributes } = fixture();
  assert.equal(handle.emit('pointerdown').prevented, true);
  assert.ok(captured.has(1)); assert.ok(attributes.has('data-dragging'));
  handle.emit('pointermove', { clientX: 200, clientY: 300 });
  assert.equal(host.style.left, '184px'); assert.equal(host.style.top, '286px');
  assert.equal(host.style.right, 'auto');
});

test('drag is clamped to all four viewport edges', () => {
  const { handle, host } = fixture(); handle.emit('pointerdown');
  handle.emit('pointermove', { clientX: -500, clientY: -500 });
  assert.equal(host.style.left, '8px'); assert.equal(host.style.top, '8px');
  handle.emit('pointermove', { clientX: 2000, clientY: 2000 });
  assert.equal(host.style.left, '612px'); assert.equal(host.style.top, '612px');
});

test('collapse button, secondary buttons and nonprimary touches do not start a drag', () => {
  const { handle, host, captured } = fixture();
  for (const props of [{ target: { closest: () => ({}) } }, { button: 2 }, { isPrimary: false }]) {
    assert.equal(handle.emit('pointerdown', props).prevented, undefined);
    handle.emit('pointermove', { clientX: 100, clientY: 100 });
    assert.deepEqual(host.style, {}); assert.equal(captured.size, 0);
  }
});

test('another pointer cannot move, replace or finish an active drag', () => {
  const { handle, host, captured } = fixture(); handle.emit('pointerdown');
  handle.emit('pointerdown', { pointerId: 2, clientX: 100, clientY: 100 });
  handle.emit('pointermove', { pointerId: 2, clientX: 100, clientY: 100 });
  handle.emit('pointerup', { pointerId: 2 });
  assert.deepEqual(host.style, {}); assert.deepEqual([...captured], [1]);
  handle.emit('pointermove', { clientX: 200, clientY: 300 });
  assert.equal(host.style.left, '184px');
});

for (const event of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'pagehide']) {
  test(`${event} releases the drag without changing subsequent pointer movement`, () => {
    const { handle, view, host, captured, attributes } = fixture(); handle.emit('pointerdown');
    handle.emit('pointermove', { clientX: 200, clientY: 300 });
    (event === 'blur' || event === 'pagehide' ? view : handle).emit(event);
    assert.equal(captured.size, 0); assert.equal(attributes.has('data-dragging'), false);
    handle.emit('pointermove', { clientX: 500, clientY: 500 });
    assert.equal(host.style.left, '184px'); assert.equal(host.style.top, '286px');
    handle.emit('pointerdown', { clientX: 200, clientY: 300 });
    assert.ok(captured.has(1));
  });
}

test('panel growth keeps an expanded panel visible without a new drag', () => {
  const { handle, host, resize } = fixture(); handle.emit('pointerdown');
  handle.emit('pointermove', { clientX: 2000, clientY: 2000 }); handle.emit('pointerup');
  host.height = 600; resize();
  assert.equal(host.style.top, '192px'); assert.equal(host.style.left, '612px');
});

test('viewport resize re-clamps the panel after responsive size changes', () => {
  const { handle, host, view } = fixture(); handle.emit('pointerdown');
  handle.emit('pointermove', { clientX: 2000, clientY: 2000 }); handle.emit('pointerup');
  view.innerWidth = 360; view.innerHeight = 400; host.width = 328; host.height = 300;
  view.emit('resize');
  assert.equal(host.style.left, '24px'); assert.equal(host.style.top, '92px');
});

test('an oversized panel keeps its title accessible rather than moving offscreen', () => {
  const { host, resize } = fixture(); host.height = 1000; host.width = 1200; resize();
  assert.equal(host.style.left, '8px'); assert.equal(host.style.top, '8px');
});

test('an in-bounds panel retains its default CSS position', () => {
  const { host, resize, view } = fixture(); resize(); view.emit('resize');
  assert.deepEqual(host.style, {});
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { writeClipboardText } from '../page/platform/clipboard.js';

test('writeClipboardText uses the Clipboard API when available', async () => {
  let copied = '';
  await writeClipboardText('bundle', {
    doc: new Window().document,
    clipboard: { writeText: async (text) => { copied = text; } },
  });
  assert.equal(copied, 'bundle');
});

test('writeClipboardText falls back to execCommand', async () => {
  const doc = new Window().document;
  doc.execCommand = (command) => command === 'copy';
  await assert.doesNotReject(writeClipboardText('bundle', { doc, clipboard: null }));
  assert.equal(doc.querySelector('textarea'), null);
});

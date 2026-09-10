function fallbackCopyText(text, doc) {
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
  doc.body.append(textarea);
  textarea.select();
  const copied = doc.execCommand?.('copy') === true;
  textarea.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

export async function writeClipboardText(text, { doc = document, clipboard = navigator.clipboard } = {}) {
  try {
    if (!clipboard?.writeText) throw new Error('Clipboard API is unavailable.');
    await clipboard.writeText(text);
  } catch {
    fallbackCopyText(text, doc);
  }
}

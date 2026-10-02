/* Only the extension's top-frame Meet content script can reach the native host. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'meet-translate' || port.sender?.frameId !== 0 ||
      !port.sender?.tab || !port.sender.url?.startsWith('https://meet.google.com/')) {
    port.disconnect();
    return;
  }
  let native;
  let closed = false;
  const send = (message) => { if (!closed) port.postMessage(message); };
  try {
    native = chrome.runtime.connectNative('com.meet_improve.codex');
    native.onMessage.addListener(send);
    native.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      send({ type: 'error', message: error?.message || 'The local translator has disconnected.' });
      closed = true;
      port.disconnect();
    });
    native.postMessage({ type: 'hello', protocol: 3 });
  } catch (error) {
    send({ type: 'error', message: error.message });
    port.disconnect();
    return;
  }
  port.onMessage.addListener((message) => {
    if (message?.type === 'translate' && !closed) native.postMessage(message);
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    native.disconnect();
  });
});

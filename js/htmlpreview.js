export function renderHtmlPreview(container, htmlString, { height = 480 } = {}) {
  const iframe = document.createElement('iframe');
  iframe.src = new URL('../sandbox.html', import.meta.url).href;
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('allow', '');
  iframe.setAttribute('loading', 'lazy');
  iframe.className = 'html-preview-frame';
  iframe.title = 'HTML preview (sandboxed)';
  iframe.height = String(height);

  iframe.addEventListener('load', () => {
    iframe.contentWindow.postMessage({ type: 'doodle-render', html: htmlString }, '*');
  }, { once: true });
  container.append(iframe);

  return {
    iframe,
    destroy() {
      iframe.remove();
    },
  };
}

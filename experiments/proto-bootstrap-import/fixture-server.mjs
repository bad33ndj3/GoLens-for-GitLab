// PROTOTYPE — throwaway. Serves a GitLab-like page: strict CSP, three pushState navs.
import { createServer } from 'node:http';

const NONCE = 'protonav123';
const CSP = `default-src 'self'; script-src 'self' 'nonce-${NONCE}'; object-src 'none'; base-uri 'self'`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>fixture</title></head>
<body>
<div id="app">fixture page</div>
<script nonce="${NONCE}">
  // PROTOTYPE — throwaway. Drives three history.pushState navigations so the
  // contentscript's SPA re-mount behavior can be exercised without a real reload.
  const paths = ['/nav-1', '/nav-2', '/nav-3'];
  let i = 0;
  function next() {
    if (i >= paths.length) {
      document.body.dataset.navDone = 'true';
      return;
    }
    history.pushState({}, '', paths[i]);
    document.body.dataset.navCount = String(++i);
    setTimeout(next, 300);
  }
  setTimeout(next, 500);
</script>
</body></html>`;

export function startFixtureServer() {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('content-security-policy', CSP);
    response.end(html);
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen(server));
  });
}

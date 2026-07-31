# Playwright extension harness prototype

**Throwaway prototype. Do not ship this extension.**

## Question

Can a small Playwright persistent-context harness assemble and load an unpacked
Manifest V3 extension, serve a GitLab-shaped local fixture, and observe a real
content-script to service-worker round trip without a custom DevTools WebSocket
client?

Run it with:

```sh
npm run prototype:playwright
```

Set `CHROME_BIN` when the harness cannot find a Chromium executable. CI should
install Playwright Chromium before running the same command.

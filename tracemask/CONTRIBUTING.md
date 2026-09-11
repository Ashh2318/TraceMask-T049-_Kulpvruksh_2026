# Contributing to TraceMask

Thanks for helping! TraceMask is a small, dependency-free codebase, so getting started takes a minute.

## Set up

1. Install Node.js **22.13 or newer**. TraceMask uses the built-in `node:sqlite`.
2. Clone the repository and run `npm start`. There is nothing to install.
3. Open http://localhost:4390. Your data goes to `data/`, which git ignores.

To work on the extension, load the `extension/` folder with **Load unpacked** in `chrome://extensions` and pair it from **Settings → Browser extension**. Click the extension's reload button after each change.

## Ground rules

- **Zero dependencies.** Use only Node.js built-ins on the server and plain browser APIs in the web app and extension. Please don't add npm packages, CDNs or build steps.
- **Real data only.** Features must work against real websites and real mailboxes. Don't add mock or simulated modes to the product. Tests may use reserved test domains (`.example`, `.test`).
- **Privacy first.** Read mail headers only, never bodies. Never log secrets. Never commit anything from `data/` or `reports/`.
- **Security headers stay strict.** No inline scripts, no `eval`, and no `innerHTML` with dynamic content. Render user and site data as text.

## Code style

- ES modules, 2-space indentation, semicolons, single quotes. See `.editorconfig`.
- Small, readable functions. Comment the *why*, not the *what*.
- Lowercase, hyphenated names for new files and generated downloads (for example `tracemask-risk-assessment-<site>.pdf`).

## Before you open a pull request

```bash
npm test          # syntax, extension manifest, server boot, 32-check security probe
```

Also try your change in the web app and, if relevant, the extension. Update `CHANGELOG.md` if users will notice the change.

## Reporting security issues

Please follow [SECURITY.md](SECURITY.md) and do not open a public issue.

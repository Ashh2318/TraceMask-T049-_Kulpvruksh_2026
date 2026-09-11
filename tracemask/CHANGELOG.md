# Changelog

All notable changes to TraceMask are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-09-11

### Added
- **Chrome extension (Manifest V3)** in `extension/`:
  - A mask button inside sign-up email fields with a live risk panel and purpose-based tier recommendation. "Create alias & fill" works with React-style forms and confirm-email fields.
  - A toolbar popup showing site risk, your alias (Fill/Copy), rescan and open leaks.
  - A leak badge and desktop notifications, plus LOCK/OFF states.
  - A right-click "Fill TraceMask alias for this site" and the Alt+Shift+E shortcut.
  - Tabs that were already open work without reloading.
- **Browser-extension API** (`server/api/ext.js`):
  - One-time pairing codes (5 minutes, 5 guesses).
  - Per-browser 256-bit bearer keys, stored hashed.
  - Lookup, scan, alias and leak endpoints, and self-revoke on unpair.
- A **Settings → Browser extension** card to generate pairing codes and revoke paired browsers.
- Eight extension-API checks in the security probe (32 checks in total).
- `npm test`: a CI smoke test (syntax, extension manifest, server boot and security probe), plus a GitHub Actions workflow.
- A user-guide chapter for the extension.

### Changed
- **Lock** now locks the whole vault: every browser session and the extension.
- Downloaded report files use lowercase names, for example `tracemask-risk-assessment-<site>.pdf`.
- Repository layout: the app is at the root, with `extension/`, `docs/` and `scripts/` alongside it. Self-check reports are written to `reports/`.
- The web-app and extension API share one identity service (`server/lib/identity.js`). Recording your real identity (T3) for a site twice no longer fails.

## [1.1.0] - 2026-09-11

### Added
- Compliance-style PDF reports: leak evidence (with raw headers, SHA-256 hashes, evidence digest and chain of custody), sign-up risk assessment, privacy posture and erasure-request letters. The PDF 1.7 writer has no dependencies.
- `npm run security`: a 24-check OWASP-style security probe.
- PDF user guide.
- A fallback DNS resolver for scans when the system resolver fails.

### Fixed
- **High:** a malformed percent-encoded URL could crash the server (cross-site DoS).
- **Medium:**
  - SSRF through the scanner and its redirects is now blocked by a public-IP guard on every hop.
  - IMAP command injection through CR/LF in credentials.
  - The browser could auto-fill the master password into the IMAP password field.
- **Low:**
  - Regular expressions that could backtrack catastrophically on hostile HTML.
  - Unbounded header and literal sizes.
  - Prefix-only static path check.
  - Dotfiles were served, extra HTTP methods were accepted, and oversized bodies reset the connection instead of returning 413.
- Lookalike sender domains are no longer auto-trusted; they are flagged for review.

## [1.0.0] - 2026-09-11

### Added
- Local vault (scrypt → AES-256-GCM), localhost-only server, and a web app with a strict CSP.
- IMAP4rev1 client over TLS (IDLE, MOVE, UIDPLUS, SPECIAL-USE) that syncs headers only.
- Per-site aliases (Gmail plus-addressing or catch-all domain) with trust tiers T0–T3.
- Live site scanner covering DNS, TLS, RDAP, Have I Been Pwned, trackers, privacy policy, security headers and DMARC, with a 0–100 risk score.
- Leak engine based on SPF/DKIM/DMARC, a quarantine folder, the Exposure Map and erasure requests (DPDP Act 2023 / GDPR).

[1.2.0]: #120---2026-09-11
[1.1.0]: #110---2026-09-11
[1.0.0]: #100---2026-09-11

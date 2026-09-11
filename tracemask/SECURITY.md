# Security policy

TraceMask handles a master password, a mailbox app password and evidence about who emails you. We take security reports seriously.

## Supported versions

| Version | Supported |
|---|---|
| 1.2.x | Yes |
| < 1.2 | No. Please update. |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead: go to the repository's **Security** tab and choose **Report a vulnerability**.

Please include:

- the affected version and component (server, web app or extension)
- steps to reproduce, or a proof of concept
- the impact you expect

Never include real passwords, app passwords, pairing codes, alias addresses or mail headers from your own mailbox.

## Threat model in short

- TraceMask runs on your own computer and listens on `127.0.0.1` only. Requests addressed to any other host name are refused (DNS-rebinding guard).
- The web app authenticates with an HttpOnly, SameSite=Strict session cookie. Every write needs a custom header and the same origin (CSRF guard).
- The browser extension authenticates with a per-browser bearer key obtained through a one-time pairing code. Cookies never authenticate the extension API and web origins are refused.
- The site scanner only contacts public IP addresses, on every redirect hop (SSRF guard).
- Secrets are sealed with AES-256-GCM under a key derived from your master password with scrypt. The local SQLite database itself is not encrypted, so use full-disk encryption.

## Checking your own instance

With TraceMask running:

```bash
npm run security                          # unauthenticated checks
TM_PASSWORD='your master password' npm run security   # all 32 checks
```

The probe only ever targets `127.0.0.1`. Its last check deliberately triggers the brute-force lockout, so wait a minute before you unlock again.

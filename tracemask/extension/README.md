# TraceMask for Chrome

> Part of the [TraceMask](../README.md) repository. The extension needs the TraceMask app running on the same computer.

TraceMask for Chrome adds the identity firewall to every sign-up form in your browser. It works together with the TraceMask app running on your own computer.

- **Inline button in email fields.** Click the mask button in any sign-up email box. TraceMask scans the site live (TLS, breaches, trackers, privacy policy), recommends a trust tier and fills a unique alias for that site.
- **Toolbar popup.** Shows the current site's risk score, your alias for that site (with Fill and Copy) and your open leaks.
- **Right-click menu and shortcut.** Right-click an input and choose *Fill TraceMask alias for this site*, or press **Alt+Shift+E**.
- **Leak alerts.** A badge count on the icon and a desktop notification when TraceMask catches a site whose alias received mail from someone else.

## Install (Developer mode, about 1 minute)

1. Start TraceMask (`npm start`, or `start.bat` on Windows) and unlock it.
2. In Chrome, open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension` folder of the TraceMask repository (the folder that contains `manifest.json`).
4. The settings page opens. In TraceMask, go to **Settings → Browser extension** and click **Generate pairing code**.
5. Type the 8-character code into the extension settings page and click **Pair with TraceMask**.
6. Optional: pin the extension using the puzzle icon in the toolbar.

It also works in Microsoft Edge (`edge://extensions` → Developer mode → Load unpacked) and in other Chromium browsers, version 116 or later.

## Using it

| Where | What to do |
|---|---|
| Any sign-up page | Click the email field, click the mask button, pick the purpose, then click **Create alias & fill** |
| Toolbar icon | See the site's risk, scan or rescan it, fill or copy your alias, and view open leaks |
| Right-click an input | **Fill TraceMask alias for this site** |
| Keyboard | **Alt+Shift+E** fills your alias into the email field you are in. Change it at `chrome://extensions/shortcuts` |

Badge meanings: a red number means open leaks, **LOCK** means the TraceMask vault is locked, and **OFF** means the TraceMask app is not running.

## Privacy and security

- The extension talks only to your local TraceMask app at `http://localhost:4390` or `http://127.0.0.1`. It has no cloud server and no analytics.
- It sends the address of the page you act on, and only when you click. Page content, passwords and form data are never read or sent.
- Pairing uses a one-time code that expires after 5 minutes and allows at most 5 attempts. The app then issues a 256-bit per-browser key, which is stored in TraceMask only as a SHA-256 hash.
- Revoke access from either side: **Unpair** in the extension, or **Revoke** in TraceMask → Settings → Browser extension.
- The in-page UI runs inside a closed Shadow DOM, so websites cannot read or restyle it. Web pages cannot call the extension API: requests from web origins are refused with 403.
- Content scripts can only ask about the page they run on. Pairing, settings and leak lists are limited to the extension's own pages.

## Permissions explained

| Permission | Why |
|---|---|
| Access to `localhost` / `127.0.0.1` | Talk to your own TraceMask app |
| Read and change data on websites | Show the mask button in email fields and fill the alias you choose, including in tabs that were already open when the extension was installed. Nothing on a page is read or sent unless you click |
| `storage` | Remember the pairing key and your preferences on this computer |
| `activeTab`, `scripting` | Add the mask button to tabs that were open before the extension was installed or updated |
| `contextMenus` | The right-click *Fill TraceMask alias* entry |
| `alarms`, `notifications` | Check for new leaks every minute and alert you |

## Troubleshooting

- **"TraceMask app is not running"**: start TraceMask (`npm start` or `start.bat`), then click *Test connection* in the extension settings.
- **"TraceMask is locked"**: open http://localhost:4390 and unlock with your master password.
- **"This browser is no longer paired"**: access was revoked in TraceMask. Generate a new code and pair again.
- **No mask button in an email field**: check that *Show the TraceMask button* is on in the extension settings. Some pages use unusual fields; right-click the field and choose *Fill TraceMask alias* instead.

Team Cryptic_Vruksh (T049) · Kalpvruksh 2.0 · Problem P16

# PixoVR Apex Web SDK

A lightweight, dependency-free browser JavaScript library exposing the Apex
Platform API calls used by the Apex Unity SDK. Usable directly as an ES
module — no build step required.

## Available calls

| Function | Endpoint |
| --- | --- |
| `login(username, password)` | `POST {modules}/login` |
| `loginWithToken(token)` | `GET {api}/v2/auth/validate-signature` |
| `checkModuleAccess(moduleId, serialNumber?)` | `GET {modules}/access/user/{userId}/module/{moduleId}` |
| `joinSession(options?)` | `POST {modules}/event` (`PIXOVR_SESSION_JOINED`) |
| `sendSimpleSessionEvent(action, target, extensions?)` | `POST {modules}/event` (`PIXOVR_SESSION_EVENT`) |
| `sendSessionEvent(statement)` | `POST {modules}/event` (`PIXOVR_SESSION_EVENT`) |
| `completeSession(sessionData?, options?)` | `POST {modules}/event` (`PIXOVR_SESSION_COMPLETE`) |
| `logout()` | Clears the stored user and session information (local only) |

## Quick start

```js
import { ApexClient } from './apex-web-sdk.js';

const client = new ApexClient({
  environment: 'na-dev',   // na-production | na-stage | na-dev | sa-production | local
  moduleId: 13,
  scenarioId: 'my-scenario',
  moduleVersion: '1.0.0',
});

await client.login('user@example.com', 'password');
await client.checkModuleAccess();

await client.joinSession();
await client.sendSimpleSessionEvent('Pushed Button', 'Start Button');
await client.completeSession({ score: 85, scoreMax: 100, duration: 60, success: true });

client.logout();
```

State is held in memory only — reloading the page resets the client, and
`logout()` clears the current user and session information.

## Deep linking

The SDK understands the same deep link arguments as the Unity SDK
(`pixotoken`, `optional`, `returntarget`, `targettype`), plus `moduleid` and
`scenarioid`, read from the page URL's query string or fragment:

```js
// e.g. https://example.com/page?pixotoken=abc123&moduleid=13&scenarioid=intro
const { params, user } = await client.initFromDeepLink();
// Logs in with pixotoken automatically when present.

// Or parse without acting on it:
const params = ApexClient.parseDeepLink();
```

## Test page

`test/index.html` is a self-contained test page with buttons for login, join
session, send simple session event, complete session, and logout. Because it
uses ES module imports, serve it over HTTP rather than opening the file
directly:

```bash
cd PixoVRWebSDK
python3 -m http.server 8080
# open http://localhost:8080/test/
```

Note: the browser must be able to reach the Apex API endpoints, which need to
allow your page's origin via CORS.

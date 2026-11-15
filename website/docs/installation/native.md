---
title: Install without Docker
sidebar_position: 5
---

Use Node.js 26.13.1 or a newer Node 26 patch release.
Node 24.22.3 or a newer Node 24 patch release remains supported for compatibility.
The panel uses Node's built-in `node:sqlite`, so there is nothing to compile.

:::warning Keep Node.js patched
Install the newest security patch for your supported Node.js release.
The Docker image pins Node.js **26.13.1**.
The repository's `.nvmrc` selects the same version for local development.
:::

```bash
npm install
cp example.env .env     # then fill in PVE_URL, PVE_TOKEN_ID, PVE_TOKEN_SECRET, JWT_SECRET
```

Create the first administrator on the command line:

```bash
npm run user:create -- admin@example.com 'a-long-password' --admin
```

Then open the admin interface on port 3001 to add customers, assign servers,
offer templates, set limits, reset passwords and read the activity log.



```bash
npm start          # production
npm run dev        # restarts on file changes
```

For local testing over plain http, set `COOKIE_SECURE=false`, otherwise the browser
won't store the session cookie.

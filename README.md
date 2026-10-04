# GA Lite

English | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

![GA Lite analytics dashboard](./public/images/landing/hero.png)

This repository is the open-source edition of [GA Lite](https://galite.io/). It provides the same product features as galite.io and runs on Cloudflare Workers and D1.

- Repository: [github.com/crevanta/galite](https://github.com/crevanta/galite)
- License: [AGPL-3.0-only](./LICENSE)

## Features

- Connect multiple Google Analytics 4, Google Search Console, and Bing Webmaster accounts.
- Manage multiple sites from one dashboard.
- Explore overview, realtime, trend, dimension, and funnel reports.
- Publish optional public profiles and embeddable widgets.
- Aggregate site data through the HTTP API and MCP endpoint.

## Requirements

- A [Cloudflare](https://dash.cloudflare.com/) account.
- Node.js 20.19.6+ (20.x) or 22.12+ (22.x), and pnpm 9.15.9. If `pnpm` is unavailable, install it with `npm install -g pnpm@9.15.9`.

## Deploy

### 1. Install and create D1

```bash
pnpm install
pnpm exec wrangler login
pnpm exec wrangler d1 create open-galite
cp wrangler.jsonc.example wrangler.jsonc
```

Copy the returned D1 `database_id` into `wrangler.jsonc`. No domain, administrator account, or Google OAuth configuration is required at this stage.

### 2. Deploy the Worker

```bash
pnpm build
openssl rand -hex 32 | pnpm exec wrangler secret put APP_SECRET
pnpm db:migrate:remote
pnpm exec wrangler deploy
```

`APP_SECRET` is the only required deployment secret. Wrangler prints the generated `workers.dev` URL after deployment.

### 3. Initialize the administrator

Open the deployed URL. The first screen asks for the administrator email and password, then signs you in automatically.

## Optional configuration

### Google Analytics and Search Console

Google OAuth can be configured after the application is running. Keep the same Google Cloud project selected throughout these steps.

1. Open [Google Cloud project creation](https://console.cloud.google.com/projectcreate), create a project for GA Lite, and select it in the console.
2. Open the [API Library](https://console.cloud.google.com/apis/library). Search for and enable each API:
   - **Google Analytics Admin API** (`analyticsadmin.googleapis.com`)
   - **Google Analytics Data API** (`analyticsdata.googleapis.com`)
   - **Google Search Console API** (`searchconsole.googleapis.com`)

   An agent with an authenticated Google Cloud CLI can perform the same step with:

   ```bash
   gcloud services enable \
     analyticsadmin.googleapis.com \
     analyticsdata.googleapis.com \
     searchconsole.googleapis.com \
     --project YOUR_PROJECT_ID
   ```

3. Open [Google Auth Platform scopes](https://console.cloud.google.com/auth/scopes). If Google asks for the app details first, use **GA Lite** as the app name, provide the support and developer email addresses, and choose **External** for a personal Gmail account. Under **Data Access**, click **Add or remove scopes**, search for and select all of the following scopes, then save:

   ```text
   https://www.googleapis.com/auth/webmasters
   https://www.googleapis.com/auth/webmasters.readonly
   https://www.googleapis.com/auth/analytics
   https://www.googleapis.com/auth/analytics.edit
   https://www.googleapis.com/auth/analytics.readonly
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/userinfo.profile
   openid
   ```

4. In the deployed GA Lite instance, open **Settings → Google OAuth**. Copy the displayed **Authorized JavaScript origin** and both **Authorized redirect URIs**.
5. Open [Google Auth Platform clients](https://console.cloud.google.com/auth/clients), click **Create client**, and choose **Web application**:
   - Add the GA Lite origin under **Authorized JavaScript origins**. It must be only the origin, without a path.
   - Add both GA4 and GSC callback URLs under **Authorized redirect URIs**. Each value must exactly match the value displayed by GA Lite.
6. Create the client and copy its **Google Client ID** and **Google Client Secret**. Paste both values into **Settings → Google OAuth**, then save.
7. Open **Integrations → Add a new account** and complete the Google authorization flow.

If the Google Client has not been configured, **Add a new account** opens the correct Settings tab automatically.

### Bing Webmaster

Open **Integrations → Add a new account**, choose Bing, and enter a Bing Webmaster API key.

### Custom domain

The generated `workers.dev` URL works without additional configuration. To use a custom domain:

1. Attach the domain to the Worker in Cloudflare.
2. Open GA Lite through that custom domain, then go to **Settings → Custom domain** and enter its HTTPS origin.
3. If Google OAuth is enabled, update both the authorized JavaScript origin and authorized redirect URIs in Google Cloud with the new values shown in Settings.

Leaving the custom-domain field empty makes GA Lite use the current request origin automatically.

## API and MCP

All endpoints use the deployed origin:

- API documentation: `/api-docs`
- MCP endpoint: `/api/mcp`
- MCP OAuth metadata: `/.well-known/oauth-authorization-server`

## Local development

Create `.dev.vars` with one local secret:

```dotenv
APP_SECRET=replace-with-at-least-32-random-characters
```

Then prepare the local D1 database and start Nuxt:

```bash
pnpm db:migrate:local
pnpm dev
```

Open the printed local URL and complete the same administrator initialization flow.

## Update an existing deployment

After pulling a newer version:

```bash
pnpm install
pnpm db:migrate:remote
pnpm deploy
```

## Dashboard overview caching

GA4 and Search overview responses are fresh for five minutes. A complete snapshot
can remain visible for up to 24 hours while a background request updates it. Manual
refresh bypasses the fresh-cache check. Concurrent requests in the same Worker
instance share work; separate Worker instances can rebuild independently. Partial
or failed provider responses do not overwrite a complete cached snapshot.

Overview invalidation uses a persistent project-scoped version in D1. Invalidation
increments that version and deletes the user's overview rows in one batch. A
rebuild can write only if its version still matches, including when the cache was
initially empty. Version records are not removed by the metrics-cache cleanup job.
An invalidated foreground request retries with fresh inputs, up to three attempts.

The browser also stores up to eight period snapshots in localStorage, isolated by
account and expired using the original data timestamp. Logout, account changes,
OAuth reconnects, and successful project/data-source mutations invalidate them.
Partial results are not persisted. If browser storage is unavailable, the dashboard
continues to use live requests. The dashboard displays the data timestamp and a
background-update indicator, with independent loading states for GA4 and Search.

**Upgrade:** apply the new D1 migration before deploying this version:

```bash
pnpm db:migrate:remote
pnpm build
```

The migration only adds `metrics_cache_versions`; existing analytics and cached
rows are preserved. It is required even when the metrics cache is empty. Local
verification (isolated Miniflare D1; no production credentials needed):

```bash
pnpm build
node --test tests/*.test.mjs
```

## License

GA Lite is distributed under the [GNU Affero General Public License v3.0](./LICENSE).

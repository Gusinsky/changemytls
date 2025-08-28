# Hostname TLS Manager

A Cloudflare Worker that helps manage TLS settings across thousands of custom hostnames.

## What it does

The worker has two main functions that can be turned on/off independently:

**Export Mode** - Pulls all your custom hostnames from Cloudflare and saves them to a D1 database. It also flags which ones need their TLS version bumped up to 1.2.

**Update Mode** - Actually updates the TLS settings for hostnames that need it. Only touches the ones that aren't already on TLS 1.2, so you're not wasting API calls.

## Getting started

First, you'll need to create the database:
```bash
npx wrangler d1 create hostnames-db
```

Then update the database ID in `wrangler.jsonc` and add your API credentials:
- `CF_API_TOKEN` - Your Cloudflare API token
- `ZONE_ID` - The zone ID you want to work with

Deploy it:
```bash
npx wrangler deploy
```
 
Initialize the database tables:
```bash
curl https://your-worker-url.workers.dev/init
```

## How to use it

The worker exposes a few simple endpoints:

- `GET /status` - Shows which components are enabled
- `GET /export` - Exports all hostnames to the database (if enabled)
- `GET /update-tls` - Updates TLS versions to 1.2 (if enabled)

You can enable/disable each component by changing the environment variables in `wrangler.jsonc`:
```json
"ENABLE_EXPORT": "true",
"ENABLE_UPDATE": "false"
```

## Why this approach?

Instead of iterating through hundreds of thousands of hostnames every time you want to update TLS settings, this worker:

1. First exports everything to a database with a `needs_update` flag
2. Then only processes the ones that actually need changes
3. Processes them in batches of 100 to avoid timeouts

Much faster and more efficient than doing it manually or hitting the API blindly.

## Database structure

Pretty straightforward table that stores the hostname info and tracks what needs updating:

```sql
CREATE TABLE custom_hostnames (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  ssl_status TEXT,
  ssl_method TEXT,
  ssl_type TEXT,
  min_tls_version TEXT,
  needs_update INTEGER DEFAULT 0,  -- 1 if TLS version needs updating
  last_updated TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

The `needs_update` field is the key - it gets set to 1 for any hostname that doesn't have TLS 1.2 yet.
  
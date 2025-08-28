interface Env {
  DB: D1Database;
  CF_API_TOKEN: string;
  ZONE_ID: string;
  ENABLE_EXPORT: string; // "true" or "false"
  ENABLE_UPDATE: string; // "true" or "false"
}

interface CustomHostname {
  id: string;
  hostname: string;
  ssl: {
    status: string;
    method: string;
    type: string;
    settings?: {
      min_tls_version?: string;
    };
  };
}

interface CloudflareResponse {
  result: CustomHostname[];
  success: boolean;
  errors: any[];
  messages: any[];
  result_info: {
    page: number;
    per_page: number;
    count: number;
    total_count: number;
    total_pages: number;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Initialize database schema
      if (path === '/init') {
        await initDatabase(env.DB);
        return Response.json({ message: 'Database initialized' });
      }

      // Component 1: Export custom hostnames to D1
      if (path === '/export' && env.ENABLE_EXPORT === 'true') {
        const result = await exportCustomHostnames(env);
        return Response.json(result);
      }

      // Component 2: Update min TLS version to 1.2
      if (path === '/update-tls' && env.ENABLE_UPDATE === 'true') {
        const result = await updateMinTlsVersion(env);
        return Response.json(result);
      }

      // Status endpoint
      if (path === '/status') {
        return Response.json({
          export_enabled: env.ENABLE_EXPORT === 'true',
          update_enabled: env.ENABLE_UPDATE === 'true',
          timestamp: new Date().toISOString()
        });
      }

      return Response.json({ 
        message: 'Hostname Manager',
        endpoints: [
          'GET /init - Initialize database',
          'GET /export - Export custom hostnames (if enabled)',
          'GET /update-tls - Update TLS versions (if enabled)',
          'GET /status - Check component status'
        ]
      });

    } catch (error) {
      console.error('Error:', error);
      return Response.json({ 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }, { status: 500 });
    }
  }
};

async function initDatabase(db: D1Database): Promise<void> {
  // Create table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS custom_hostnames (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      ssl_status TEXT,
      ssl_method TEXT,
      ssl_type TEXT,
      min_tls_version TEXT,
      needs_update INTEGER DEFAULT 0,
      last_updated TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  
  // Create indexes
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_needs_update ON custom_hostnames(needs_update)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_hostname ON custom_hostnames(hostname)`).run();
}

async function exportCustomHostnames(env: Env): Promise<any> {
  let page = 1;
  let totalProcessed = 0;
  let totalInserted = 0;
  const perPage = 50; // Cloudflare API default

  while (true) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/custom_hostnames?page=${page}&per_page=${perPage}`,
      {
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Cloudflare API error: ${response.status} ${response.statusText}`);
    }

    const data: CloudflareResponse = await response.json();
    
    if (!data.success) {
      throw new Error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
    }

    // Insert/update records in D1
    for (const hostname of data.result) {
      const minTlsVersion = hostname.ssl.settings?.min_tls_version || 'unknown';
      const needsUpdate = minTlsVersion !== '1.2' ? 1 : 0;

      await env.DB.prepare(`
        INSERT OR REPLACE INTO custom_hostnames 
        (id, hostname, ssl_status, ssl_method, ssl_type, min_tls_version, needs_update, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        hostname.id,
        hostname.hostname,
        hostname.ssl.status,
        hostname.ssl.method,
        hostname.ssl.type,
        minTlsVersion,
        needsUpdate,
        new Date().toISOString()
      ).run();

      totalInserted++;
    }

    totalProcessed += data.result.length;

    // Check if we've processed all pages
    if (page >= data.result_info.total_pages) {
      break;
    }

    page++;
  }

  return {
    message: 'Export completed',
    total_processed: totalProcessed,
    total_inserted: totalInserted,
    timestamp: new Date().toISOString()
  };
}

async function updateMinTlsVersion(env: Env): Promise<any> {
  // Get all hostnames that need TLS version update
  const { results } = await env.DB.prepare(`
    SELECT id, hostname, min_tls_version 
    FROM custom_hostnames 
    WHERE needs_update = 1 
    LIMIT 100
  `).all();

  if (!results || results.length === 0) {
    return {
      message: 'No hostnames need TLS version update',
      updated: 0
    };
  }

  let updated = 0;
  const errors: string[] = [];

  for (const record of results) {
    try {
      // Update min TLS version via Cloudflare API
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/custom_hostnames/${record.id}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${env.CF_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ssl: {
              method: "txt",
              type: "dv",
              settings: {
                min_tls_version: "1.2"
              }
            }
          })
        }
      );

      if (response.ok) {
        // Update local record to mark as no longer needing update
        await env.DB.prepare(`
          UPDATE custom_hostnames 
          SET min_tls_version = '1.2', needs_update = 0, last_updated = ?
          WHERE id = ?
        `).bind(new Date().toISOString(), record.id).run();
        
        updated++;
      } else {
        const errorText = await response.text();
        errors.push(`${record.hostname}: ${response.status} ${errorText}`);
      }
    } catch (error) {
      errors.push(`${record.hostname}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  return {
    message: 'TLS update completed',
    updated,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString()
  };
}

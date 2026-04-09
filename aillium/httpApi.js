'use strict';

const http = require('http');
const { createMeshCentralRemoteSupportAdapter } = require('./meshcentralRemoteSupportAdapter.service');

const API_PORT = parseInt(process.env.AILLIUM_API_PORT || '3100', 10);
const API_TOKEN = process.env.AILLIUM_API_TOKEN || '';

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function createAilliumHttpApi(adapterOptions = {}) {
  const adapter = createMeshCentralRemoteSupportAdapter(adapterOptions);
  const apiClient = adapter._apiClient;
  const evidenceCollector = adapter._evidenceCollector;

  const server = http.createServer(async (req, res) => {
    // Auth check — require token in production
    if (API_TOKEN) {
      if (req.headers['x-aillium-token'] !== API_TOKEN) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.error('[Aillium] WARNING: AILLIUM_API_TOKEN not set — API is unprotected');
    }

    try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
      // POST /aillium/api/diagnostics
      if (pathname === '/aillium/api/diagnostics' && req.method === 'POST') {
        const body = await parseBody(req);
        const { node_id, tenant_id, session_id } = body;

        if (!node_id) {
          return sendJson(res, 400, { error: 'node_id is required' });
        }

        // Run diagnostic commands on the device
        const diagnosticCommands = [
          { key: 'os_info', command: process.platform === 'win32'
            ? 'systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type" /C:"Total Physical Memory"'
            : 'uname -a && cat /etc/os-release 2>/dev/null || true' },
          { key: 'disk_usage', command: process.platform === 'win32'
            ? 'wmic logicaldisk get size,freespace,caption'
            : 'df -h' },
          { key: 'memory', command: process.platform === 'win32'
            ? 'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /Value'
            : 'free -m' },
          { key: 'cpu_load', command: process.platform === 'win32'
            ? 'wmic cpu get loadpercentage /Value'
            : 'uptime' },
          { key: 'network', command: process.platform === 'win32'
            ? 'ipconfig /all'
            : 'ip addr show 2>/dev/null || ifconfig' },
          { key: 'services', command: process.platform === 'win32'
            ? 'sc query state= running | findstr /i "SERVICE_NAME DISPLAY_NAME STATE"'
            : 'systemctl list-units --type=service --state=running --no-pager 2>/dev/null || service --status-all 2>/dev/null || true' },
        ];

        const results = {};
        const errors = [];

        for (const diag of diagnosticCommands) {
          try {
            const cmdResult = await apiClient.runCommand(node_id, diag.command, false);
            results[diag.key] = {
              output: cmdResult?.output || cmdResult?.result || '',
              status: 'collected',
            };
          } catch (err) {
            results[diag.key] = { output: '', status: 'failed', error: err.message };
            errors.push({ key: diag.key, error: err.message });
          }
        }

        // Build health snapshot from collected data
        const snapshot = {
          node_id,
          collected_at: new Date().toISOString(),
          results,
          error_count: errors.length,
          errors: errors.length > 0 ? errors : undefined,
        };

        // If session_id and tenant_id provided, store as evidence
        if (tenant_id && session_id) {
          try {
            await evidenceCollector.collectConfigSnapshot(tenant_id, session_id, snapshot);
          } catch { /* best-effort evidence storage */ }
        }

        return sendJson(res, 200, snapshot);
      }

      // POST /aillium/api/restart-agent
      if (pathname === '/aillium/api/restart-agent' && req.method === 'POST') {
        const body = await parseBody(req);
        const { node_id } = body;

        if (!node_id) {
          return sendJson(res, 400, { error: 'node_id is required' });
        }

        // Restart the MeshAgent on the device
        const restartCmd = process.platform === 'win32'
          ? 'net stop "Mesh Agent" && net start "Mesh Agent"'
          : 'systemctl restart meshagent 2>/dev/null || service meshagent restart 2>/dev/null || true';

        try {
          const result = await apiClient.runCommand(node_id, restartCmd, false);
          return sendJson(res, 200, {
            node_id,
            status: 'restart_initiated',
            output: result?.output || result?.result || '',
            restarted_at: new Date().toISOString(),
          });
        } catch (err) {
          return sendJson(res, 502, {
            node_id,
            status: 'restart_failed',
            error: err.message,
          });
        }
      }

      // GET /aillium/api/evidence?tenant_id=...&session_id=...
      if (pathname === '/aillium/api/evidence' && req.method === 'GET') {
        const tenantId = url.searchParams.get('tenant_id');
        const sessionId = url.searchParams.get('session_id');

        if (!tenantId || !sessionId) {
          return sendJson(res, 400, { error: 'tenant_id and session_id are required' });
        }

        const files = await evidenceCollector.listEvidence(tenantId, sessionId);
        return sendJson(res, 200, {
          tenant_id: tenantId,
          session_id: sessionId,
          evidence_files: files,
          count: files.length,
        });
      }

      // POST /aillium/api/evidence/capture
      if (pathname === '/aillium/api/evidence/capture' && req.method === 'POST') {
        const body = await parseBody(req);
        const { tenant_id, session_id, evidence_type, data } = body;

        if (!tenant_id || !session_id || !evidence_type) {
          return sendJson(res, 400, { error: 'tenant_id, session_id, and evidence_type are required' });
        }

        const result = await adapter.captureSessionEvidence({
          tenant_id,
          session_id,
          evidence_type,
          data: data || {},
        });

        return sendJson(res, 200, result);
      }

      // POST /aillium/api/resolve-device
      if (pathname === '/aillium/api/resolve-device' && req.method === 'POST') {
        const body = await parseBody(req);
        const result = await adapter.resolveDeviceTarget(body);
        const statusCode = result?.result?.resolved === false ? 404 : 200;
        return sendJson(res, statusCode, result);
      }

      // GET /aillium/api/health
      if (pathname === '/aillium/api/health' && req.method === 'GET') {
        const health = await adapter.getHealth();
        return sendJson(res, health.status === 'operational' ? 200 : 503, health);
      }

      // GET /aillium/api/sessions
      if (pathname === '/aillium/api/sessions' && req.method === 'GET') {
        const tenantId = url.searchParams.get('tenant_id');
        if (!tenantId) {
          return sendJson(res, 400, { error: 'tenant_id is required' });
        }
        const result = await adapter.listActiveSessions({ tenant_id: tenantId });
        return sendJson(res, 200, result);
      }

      // 404
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  return {
    server,
    adapter,
    start(port = API_PORT) {
      return new Promise((resolve) => {
        server.listen(port, () => {
          console.log(`[Aillium] HTTP API listening on port ${port}`);
          resolve(server);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}

// Auto-start if run directly
if (require.main === module) {
  const api = createAilliumHttpApi();
  api.start().catch((err) => {
    console.error(`[Aillium] Failed to start HTTP API: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { createAilliumHttpApi };

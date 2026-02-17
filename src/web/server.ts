// Reference: Plan for web frontend server
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createServer as createHttpServer } from 'http';
import { MCPClient } from '../index.js';
import { createApiRouter } from './api.js';
import { SignalHandler } from '../handlers/signal-handler.js';
import { Logger } from '../logger.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ModelProvider } from '../model-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WebServerOptions {
  provider?: ModelProvider;
  model?: string;
}

export async function startWebServer(
  serverConfigs: Array<{ name: string; config: StdioServerParameters; disabledInConfig?: boolean }>,
  options: WebServerOptions,
  port?: number,
): Promise<void> {
  const logger = new Logger({ mode: 'verbose' });

  // In web mode, discard child process stderr entirely.
  // The MCP SDK defaults to stderr: 'inherit', which means child processes
  // write directly to our terminal fd — Python MCP servers dump tracebacks
  // (CancelledError, anyio, KeyboardInterrupt) on shutdown.
  // Using 'pipe' would deadlock: nobody reads the PassThrough stream, the OS
  // pipe buffer fills up, and the child blocks on its next logging call.
  // Using 'ignore' discards stderr at the OS level — no buffer, no deadlock.
  const patchedConfigs = serverConfigs
    .filter(s => !s.disabledInConfig)
    .map(s => ({
      ...s,
      config: { ...s.config, stderr: 'ignore' as const },
    }));

  // Create MCPClient using the multi-server factory
  const client = MCPClient.createMultiServer(patchedConfigs, {
    provider: options.provider,
    model: options.model,
    loggerOptions: { mode: 'verbose' },
  });

  // Start client (connects to MCP servers)
  await client.start();

  const app = express();
  app.use(express.json());

  // Mount API routes
  app.use('/api', createApiRouter(client));

  // Determine if we should use Vite dev server or serve static files
  const frontendDistDir = join(__dirname, 'frontend', 'dist');
  const frontendSrcDir = join(__dirname, '..', '..', 'src', 'web', 'frontend');

  if (process.env.NODE_ENV !== 'production' && existsSync(join(frontendSrcDir, 'vite.config.ts'))) {
    // Dev mode: use Vite middleware
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        root: frontendSrcDir,
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (error) {
      console.warn('Failed to start Vite dev server, falling back to static files:', error);
      serveFrontendStatic(app, frontendDistDir);
    }
  } else {
    serveFrontendStatic(app, frontendDistDir);
  }

  // Use port 0 to auto-select an available port
  const httpServer = createHttpServer(app);

  await new Promise<void>((resolve) => {
    httpServer.listen(port ?? 0, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port ?? 0;
      console.log(`\n  Web UI: http://localhost:${actualPort}\n`);
      resolve();
    });
  });

  // Graceful shutdown using the same SignalHandler pattern as the CLI
  let isShuttingDown = false;

  const signalHandler = new SignalHandler(logger, async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    httpServer.close();
    await client.stop();
  });

  signalHandler.setup();

  // Keep the process alive
  await new Promise<void>(() => {});
}

function serveFrontendStatic(app: express.Express, distDir: string): void {
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA fallback
    app.get('*', (_req, res) => {
      res.sendFile(join(distDir, 'index.html'));
    });
  } else {
    app.get('*', (_req, res) => {
      res.status(404).send('Frontend not built. Run: npm run build:web');
    });
  }
}

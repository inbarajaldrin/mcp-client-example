// Reference: https://models.dev
// Model metadata from models.dev API — reasoning detection and cost calculation.
// Replaces both llm-info (reasoning detection) and @pydantic/genai-prices (cost calculation).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = join(__dirname, '../..', '.mcp-client-data', 'cache');
const CACHE_FILE = join(CACHE_DIR, 'models-dev.json');
const API_URL = 'https://models.dev/api.json';
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

export interface ModelsDevCost {
  input: number;
  output: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: {
    input: number;
    output: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
  };
}

export interface ModelsDevModel {
  id: string;
  name: string;
  reasoning: boolean;
  tool_call: boolean;
  attachment: boolean;
  temperature?: boolean;
  cost?: ModelsDevCost;
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  modalities?: {
    input: string[];
    output: string[];
  };
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  models: Record<string, ModelsDevModel>;
}

type ModelsDevData = Record<string, ModelsDevProvider>;

// Module-level state
let cachedData: ModelsDevData = {};
let refreshTimer: ReturnType<typeof setInterval> | null = null;

// Our provider names → models.dev provider IDs
const PROVIDER_MAP: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
};

function loadFromCache(): ModelsDevData | null {
  try {
    if (existsSync(CACHE_FILE)) {
      return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as ModelsDevData;
    }
  } catch {
    // Cache corrupt or unreadable
  }
  return null;
}

async function fetchFromApi(): Promise<ModelsDevData | null> {
  try {
    const response = await fetch(API_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    const data = JSON.parse(text) as ModelsDevData;

    try {
      if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true });
      }
      writeFileSync(CACHE_FILE, text);
    } catch {
      // Cache write failed, non-fatal
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Initialize models.dev data. Loads from cache synchronously,
 * then fetches fresh data in background.
 */
export async function initModelsDevCache(): Promise<void> {
  const cached = loadFromCache();
  if (cached) {
    cachedData = cached;
  }

  const fresh = await fetchFromApi();
  if (fresh) {
    cachedData = fresh;
  }
}

/**
 * Start background refresh interval. Call once at app startup.
 */
export function startModelsDevRefresh(): void {
  if (refreshTimer) return;

  // Initial load (fire and forget)
  initModelsDevCache().catch(() => {});

  refreshTimer = setInterval(async () => {
    const fresh = await fetchFromApi();
    if (fresh) {
      cachedData = fresh;
    }
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

/**
 * Stop background refresh (for cleanup).
 */
export function stopModelsDevRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Find model by prefix matching (longest match wins).
 */
function findPrefixMatch(modelId: string, models: Record<string, ModelsDevModel>): ModelsDevModel | undefined {
  const keys = Object.keys(models).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (modelId.startsWith(key) || key.startsWith(modelId)) {
      return models[key];
    }
  }
  return undefined;
}

/**
 * Look up model info from models.dev data. Synchronous — uses pre-loaded data.
 */
export function getModelInfo(modelId: string, providerName?: string): ModelsDevModel | undefined {
  const providerId = providerName ? (PROVIDER_MAP[providerName] || providerName) : undefined;

  // 1. Exact match (provider-scoped if hint given)
  if (providerId) {
    const provider = cachedData[providerId];
    if (provider?.models[modelId]) {
      return provider.models[modelId];
    }
  }
  for (const provider of Object.values(cachedData)) {
    if (provider.models[modelId]) {
      return provider.models[modelId];
    }
  }

  // 2. Prefix match (provider-scoped first)
  if (providerId) {
    const provider = cachedData[providerId];
    if (provider) {
      const match = findPrefixMatch(modelId, provider.models);
      if (match) return match;
    }
  }
  for (const provider of Object.values(cachedData)) {
    const match = findPrefixMatch(modelId, provider.models);
    if (match) return match;
  }

  return undefined;
}

/**
 * Check if models.dev data is loaded.
 */
export function isModelsDevLoaded(): boolean {
  return Object.keys(cachedData).length > 0;
}

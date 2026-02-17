import { useState, useEffect, useCallback } from 'react';

interface ToolWithState {
  name: string;
  server: string;
  description: string;
  enabled: boolean;
}

interface ServerInfo {
  name: string;
  tools: Array<{ name: string; description: string }>;
}

export function useServers() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [allTools, setAllTools] = useState<ToolWithState[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchServers = useCallback(() => {
    fetch('/api/servers')
      .then(res => res.json())
      .then(data => {
        setServers(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const fetchAllTools = useCallback(() => {
    fetch('/api/tools/all')
      .then(res => res.json())
      .then(setAllTools)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchServers();
    fetchAllTools();
  }, [fetchServers, fetchAllTools]);

  const toggleTool = useCallback(async (toolName: string, enabled: boolean) => {
    await fetch('/api/tools/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName, enabled }),
    });
    fetchServers();
    fetchAllTools();
  }, [fetchServers, fetchAllTools]);

  const toggleServer = useCallback(async (serverName: string, enabled: boolean) => {
    await fetch('/api/tools/server-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName, enabled }),
    });
    fetchServers();
    fetchAllTools();
  }, [fetchServers, fetchAllTools]);

  return { servers, allTools, loading, toggleTool, toggleServer, refetch: fetchServers };
}

const MCP_BASE = 'https://mcp-poc-tom.azurewebsites.net';

export async function callMcpTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = await fetch(MCP_BASE + '/api/tool', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': import.meta.env.VITE_DR_SESSION_ID ?? '',
      'X-Csrf-Token': import.meta.env.VITE_DR_CSRF_TOKEN ?? '',
      'X-Domain': import.meta.env.VITE_DR_DOMAIN ?? '',
    },
    body: JSON.stringify({ tool: toolName, args }),
  });
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

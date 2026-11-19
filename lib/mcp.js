// A small Model Context Protocol server over HTTP, enough for a Bot to list
// Waypoint's tools and call them. One POST carries one JSON-RPC message (or a
// batch) and gets a plain JSON answer back; there is no long-lived stream.
//
//   const mcp = createMcp({ name, version, instructions, tools });
//   const { status, body } = await mcp.handle(message, context);
//
// A tool is { name, description, inputSchema, run(args, context) }. `run`
// returns any JSON value, or throws an Error whose message the Bot should read.

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const fault = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function createMcp({ name, version, instructions, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  async function one(message, context) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return fault(message?.id, -32600, 'Not a JSON-RPC 2.0 request.');
    }
    const { id, method, params = {} } = message;
    const isNotification = id === undefined || id === null;

    if (method === 'initialize') {
      const asked = String(params.protocolVersion || '');
      return reply(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
        instructions,
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method.startsWith('notifications/')) return null;
    if (method === 'tools/list') {
      return reply(id, { tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) });
    }
    if (method === 'tools/call') {
      const tool = byName.get(String(params.name));
      if (!tool) return fault(id, -32602, `No tool called "${params.name}".`);
      try {
        const result = await tool.run(params.arguments && typeof params.arguments === 'object' ? params.arguments : {}, context);
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
      } catch (err) {
        // A tool that could not do its job answers normally, flagged as an error,
        // so the Bot reads the reason and can try again.
        return reply(id, { content: [{ type: 'text', text: String(err.message || err) }], isError: true });
      }
    }
    return isNotification ? null : fault(id, -32601, `Unknown method "${method}".`);
  }

  // Returns { status, body }. body is null when there is nothing to send back.
  async function handle(message, context) {
    if (Array.isArray(message)) {
      if (!message.length) return { status: 400, body: fault(null, -32600, 'Empty batch.') };
      const answers = (await Promise.all(message.map((m) => one(m, context)))).filter(Boolean);
      return answers.length ? { status: 200, body: answers } : { status: 202, body: null };
    }
    const answer = await one(message, context);
    return answer ? { status: 200, body: answer } : { status: 202, body: null };
  }

  return { handle };
}

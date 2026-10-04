// A stand-in client that records what it was sent, so tests run offline.
export function fakeClient(reply) {
  const calls = [];
  const create = async (args) => { calls.push(args); return reply; };
  return { calls, chat: { completions: { create } }, messages: { create } };
}

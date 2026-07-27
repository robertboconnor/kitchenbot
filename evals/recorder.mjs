// A pass-through wrapper around the real Anthropic client that records what the brain actually did.
//
// The eval drives the REAL runKbAgentLoop, so the only way to see the tool trace and the request
// shape is to sit between the loop and the SDK. This wrapper changes nothing about the calls — it
// observes them.
//
// It works because the loop consumes exactly one thing from a stream: finalMessage()
// (kb-agent-loop.mjs:389). That is why this is 40 lines and not a fake SDK.

export function createRecordingClient(realClient) {
  const record = {
    toolTrace: [],        // every tool_use across the turn, in call order
    systemBlockCounts: [], // per brain request — must always be 1 (one cached block)
    brainCallCount: 0,
    sideCallCount: 0,
    sideCallPurposes: [],
  };

  function noteBrainRequest(params) {
    record.brainCallCount += 1;
    record.systemBlockCounts.push(Array.isArray(params?.system) ? params.system.length : params?.system ? 1 : 0);
  }

  function noteToolUses(message) {
    for (const block of message?.content || []) {
      if (block?.type === 'tool_use') {
        record.toolTrace.push({ name: block.name, input: block.input });
      }
    }
  }

  const client = {
    messages: {
      stream: (params) => {
        noteBrainRequest(params);
        const real = realClient.messages.stream(params);
        return {
          ...real,
          finalMessage: async () => {
            const message = await real.finalMessage();
            noteToolUses(message);
            return message;
          },
        };
      },
      create: async (params) => {
        record.sideCallCount += 1;
        record.sideCallPurposes.push(params?.tool_choice?.name || params?.model || 'unknown');
        return realClient.messages.create(params);
      },
    },
  };

  return { client, record };
}

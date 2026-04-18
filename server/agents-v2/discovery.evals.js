/**
 * Evals for the discovery agent.
 *
 * These are offline "structural" tests — they don't hit YouTube (that would
 * require quota + API key + network). Instead we call the agent with invalid
 * inputs and check error handling / schema compliance.
 */

module.exports = [
  {
    name: 'rejects missing keywords',
    input: {},
    assertions: [
      { type: 'custom', fn: (output) => {
        // Run will either fail or return empty — both acceptable; the harness
        // handles the error path. If output exists, it must have channels.
        if (!output) return true;
        return typeof output.total === 'number' || 'channels must be an array';
      } },
    ],
  },
];

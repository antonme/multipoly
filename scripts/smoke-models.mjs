// Live provider check: consumes tokens/subscription quota. Uses the same
// environment and transports as the server; never enables an unconfigured model.
import { loadConfig } from './lib/config.mjs';
import { handleModelConsult } from './lib/model-consult.mjs';
const config = loadConfig();
const selected = process.argv.slice(2);
for (const key of selected) {
  if (!Object.hasOwn(config.models, key)) throw new Error(`Unknown model: ${key}`);
}
let failed = false;
for (const [key, model] of Object.entries(config.models)) {
  if (selected.length && !selected.includes(key)) continue;
  if (!model.configured) {
    console.log(JSON.stringify({ key, model: model.model, status: 'SKIP', reason: 'unconfigured' }));
    if (selected.includes(key)) failed = true;
    continue;
  }
  const start = Date.now();
  try {
    const { result } = await handleModelConsult(key, {
      prompt: 'Compute 19 * 23. Reply with exactly SMOKE-OK 437 and nothing else.',
      timeout_ms: 120000,
    }, { config });
    const pass = result.trim() === 'SMOKE-OK 437';
    if (!pass) failed = true;
    console.log(JSON.stringify({ key, model: model.model, status: pass ? 'PASS' : 'FAIL', ms: Date.now() - start }));
  } catch (error) {
    failed = true;
    // Transport messages can contain child output; print only the error code.
    console.log(JSON.stringify({ key, model: model.model, status: 'FAIL', code: error.code ?? 'ERROR', ms: Date.now() - start }));
  }
}
process.exitCode = failed ? 1 : 0;

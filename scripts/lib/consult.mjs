import { handleModelConsult } from "./model-consult.mjs";

export async function handleConsult(input, ctx = {}) {
  return handleModelConsult("glm", input, ctx);
}

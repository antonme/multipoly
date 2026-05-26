import { handleModelReview } from "./model-review.mjs";

export async function handleReview(input, ctx = {}) {
  return handleModelReview("glm", input, ctx);
}

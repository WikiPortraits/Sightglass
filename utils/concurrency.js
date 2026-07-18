/**
 * Map items through an async fn with at most `limit` calls in flight.
 * Results keep item order. The first error stops new work, lets in-flight
 * calls settle, then rethrows.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let firstError = null;

  const worker = async () => {
    while (firstError === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (firstError === null) {
          firstError = error;
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );

  if (firstError) {
    throw firstError;
  }
  return results;
}

module.exports = { mapWithConcurrency };

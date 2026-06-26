// Dummy webhook route to gracefully acknowledge Shopify retries with 200 OK
// This stops Shopify from repeating delivery attempts and prevents 404 error logs in the console.
export const action = async () => {
  return new Response("OK", { status: 200 });
};

export async function onRequest() {
  return new Response("ok", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

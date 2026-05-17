// Small, optional helpers. Don't over-build — most workers want raw `new Response(...)`
// for full header control.

export function jsonErr(status: number, code: string, msg: string): Response {
  return new Response(JSON.stringify({ error: code, message: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

export function healthResponse(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/health") return undefined;

  return Response.json(
    { status: "ok" },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

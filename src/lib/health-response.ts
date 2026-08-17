export function healthResponse(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/health") return undefined;

  const commit = process.env.DEPLOYED_COMMIT_SHA?.trim();

  return Response.json(
    {
      status: "ok",
      ...(commit ? { commit } : {}),
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

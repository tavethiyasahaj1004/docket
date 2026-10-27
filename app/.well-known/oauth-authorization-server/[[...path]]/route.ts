// A stub that imports nothing from the app, so it answers identically whether
// MCP is on or off and never touches the database. A later OAuth phase replaces
// it with real discovery metadata.
export function GET() {
  return new Response(
    JSON.stringify({
      error: "This server does not support OAuth. Use a personal access token.",
    }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}

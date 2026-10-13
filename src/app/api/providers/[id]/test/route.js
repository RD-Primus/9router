import { NextResponse } from "next/server";
import { testSingleConnection } from "./testUtils.js";

// POST /api/providers/[id]/test - Test connection
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const result = await testSingleConnection(id);

    if (result.error === "Connection not found") {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    return NextResponse.json({
      valid: result.valid,
      error: result.error,
      refreshed: result.refreshed || false,
      ...(result.probe ? {
        status: result.status,
        category: result.category,
        probe: result.probe,
        inferenceVerified: result.inferenceVerified,
        ...(result.message ? { message: result.message } : {}),
      } : {}),
    });
  } catch {
    // Error objects can contain upstream bodies, credentialed URLs, or tokens.
    console.log("Error testing connection: unexpected internal failure");
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}

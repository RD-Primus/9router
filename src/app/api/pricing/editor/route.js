import { NextResponse } from "next/server";
import { getPricingEditor } from "@/lib/pricingEditor.js";

export const dynamic = "force-dynamic";

// Read-only local catalog and effective pricing; saving/resetting deliberately
// uses /api/pricing so editor changes are the same overrides used by billing.
export async function GET() {
  try {
    return NextResponse.json(await getPricingEditor(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Failed to fetch pricing editor" }, { status: 500 });
  }
}

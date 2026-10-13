import { NextResponse } from "next/server";
import { importOpenRouterPricing, PricingImportError } from "@/lib/openrouterPricing.js";
import { isSafePricingKey } from "@/lib/pricingValidation.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length !== 1 || !isSafePricingKey(body.provider)) {
    return NextResponse.json({ error: "Expected { provider: runtimeProviderId }" }, { status: 400 });
  }
  try {
    return NextResponse.json(await importOpenRouterPricing(body.provider), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof PricingImportError ? error.message : "Failed to import pricing" },
      { status: error instanceof PricingImportError ? error.status : 500 });
  }
}

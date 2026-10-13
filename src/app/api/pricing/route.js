import { NextResponse } from "next/server";
import { getPricing, updatePricing, resetPricing, resetAllPricing } from "@/lib/localDb.js";
import { getDefaultPricing } from "open-sse/providers/pricing.js";
import { validatePricingData } from "@/lib/pricingValidation.js";

/**
 * GET /api/pricing
 * Get current pricing configuration (merged user + defaults)
 */
export async function GET() {
  try {
    const pricing = await getPricing();
    return NextResponse.json(pricing);
  } catch (error) {
    console.error("Error fetching pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch pricing" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/pricing
 * Update pricing configuration
 * Body: { provider: { model: { input: number, output: number, cached: number, ... } } }
 */
export async function PATCH(request) {
  try {
    let body;
    try {
      body = await request.json();
      validatePricingData(body);
    } catch (error) {
      return NextResponse.json({ error: error.message || "Invalid pricing data" }, { status: 400 });
    }

    const updatedPricing = await updatePricing(body);
    return NextResponse.json(updatedPricing);
  } catch (error) {
    console.error("Error updating pricing:", error);
    return NextResponse.json(
      { error: "Failed to update pricing" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/pricing
 * Reset pricing to defaults
 * Query params: ?provider=xxx&model=yyy (optional)
 */
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");

    if (provider && model) {
      // Reset specific model
      await resetPricing(provider, model);
    } else if (provider) {
      // Reset entire provider
      await resetPricing(provider);
    } else {
      // Reset all pricing
      await resetAllPricing();
    }

    const pricing = await getPricing();
    return NextResponse.json(pricing);
  } catch (error) {
    console.error("Error resetting pricing:", error);
    return NextResponse.json(
      { error: "Failed to reset pricing" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/pricing/defaults
 * Get default pricing configuration
 */
export async function GET_DEFAULTS() {
  try {
    const defaultPricing = getDefaultPricing();
    return NextResponse.json(defaultPricing);
  } catch (error) {
    console.error("Error fetching default pricing:", error);
    return NextResponse.json(
      { error: "Failed to fetch default pricing" },
      { status: 500 }
    );
  }
}
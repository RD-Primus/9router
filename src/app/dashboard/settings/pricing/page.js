import { redirect } from "next/navigation";

// Keep existing bookmarks while moving pricing into the dashboard shell.
export default function PricingSettingsPage() {
  redirect("/dashboard/pricing");
}

import { redirect } from "next/navigation";

// This app's home is /research. Kept so muscle-memory / browser-autocomplete
// hits on the tracker's /dashboard URL (same localhost) land somewhere useful
// instead of a 404.
export default function DashboardRedirect() {
  redirect("/research");
}

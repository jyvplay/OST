import { Suspense } from "react";
import PresentView from "@/components/PresentView";

export const dynamic = "force-dynamic";

/**
 * CA-02 receiver page. A Presentation API receiver (or any second screen) loads
 * this route and joins the same Together room, so the cast surface is a live
 * participant with its own clock rather than a mirrored bitmap.
 */
export default function PresentPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading receiver…</div>}>
      <PresentView />
    </Suspense>
  );
}

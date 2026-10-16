import Shell from "@/components/Shell";

export const dynamic = "force-dynamic";

/**
 * WM-07: a second display gets its OWN desktop state row, so unplugging and
 * replugging restores that screen's layout instead of dumping its windows onto
 * the primary. Opened by BlackTop through window.open() positioned with
 * getScreenDetails().
 */
export default function DisplayPage() {
  return <Shell stateId="display-2" hostKind="screen" />;
}

import Shell from "@/components/Shell";
import { chooseDesktopId } from "@/lib/desktop-id";

export const dynamic = "force-dynamic";

/**
 * TT142: the desktop row is the shared `default` unless a link names another one.
 * The shell is server-rendered, so the choice must be made here rather than in an
 * effect (a client-side switch would paint the wrong windows first). An unusable
 * `?desk=` is passed down as a sentence the shell shows once, not silently
 * swallowed — a broken share link must not look like a working one.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ desk?: string }> }) {
  const params = await searchParams;
  const choice = chooseDesktopId({ param: params.desk ?? null });
  return <Shell stateId={choice.id} hostKind="tab" desktopNotice={choice.warning} desktopSource={choice.source} />;
}

import { Card, PageHeader } from "@/components/ui";

/**
 * The Discord CRM UI is parked for now (Joey, 2026-08-17). Flip this to false
 * to bring it back — the pages below it, the pull worker, the bot and the
 * `research_discord_*` data are all untouched and keep running/ingesting.
 * The nav entry in `app-nav.tsx` is commented out behind the same note.
 */
export const DISCORD_DEPRECATED = true;

export function DiscordDeprecatedNotice() {
  return (
    <>
      <PageHeader title="Discord" />
      <Card>
        <div className="py-10 text-center">
          <p className="text-sm font-medium text-neutral-900">
            The Discord dashboard is switched off for now.
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-neutral-500">
            Ingestion keeps running in the background — messages, channels and
            creator links are still collected, so nothing is lost while this
            page is parked.
          </p>
        </div>
      </Card>
    </>
  );
}

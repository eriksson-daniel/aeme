import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";
import { CheckIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { USER_COLOR_PALETTE, USER_COLORS } from "../../worker/users/colors.ts";
import { PageContainer } from "../components/PageContainer.tsx";
import { PageLoader } from "../components/PageLoader.tsx";
import { Section } from "../components/Section.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { initialOf, textColorOn } from "../lib/user-color.ts";
import { useChannelQuery } from "../queries/channel.ts";
import { useAddChannelMemberMutation, useChannelMembersQuery } from "../queries/channelMembers.ts";
import { useSessionQuery, useSetUserColorMutation } from "../queries/session.ts";

const formatCreated = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

const DetailRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-start justify-between gap-4 border-t border-border py-2 text-sm first:border-t-0 first:pt-0">
    <dt className="shrink-0 text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-right">{children}</dd>
  </div>
);

const CUSTOM_COLOR_DEBOUNCE_MS = 400;

/** Pick your color: one of the palette, or anything else through the
 * native picker. Saved on pick — like availability, there's no confirm. */
const ColorPicker = ({ name, color }: { name: string; color: string }) => {
  const setColor = useSetUserColorMutation();
  // The pick, shown straight away rather than after the round trip — and
  // held until the session has refetched, so it doesn't flick back first.
  const [draft, setDraft] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const save = (next: string, delayMs = 0) => {
    setDraft(next);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setColor.mutate(next, {
        // Only if nothing newer was picked in the meantime.
        onSettled: () => setDraft((current) => (current === next ? null : current)),
      });
    }, delayMs);
  };

  const current = draft ?? color;
  const isCustom = !USER_COLOR_PALETTE.includes(current);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold"
          style={{ backgroundColor: current, color: textColorOn(current) }}
        >
          {initialOf(name)}
        </span>
        <p className="text-sm text-muted-foreground">
          Your part of a time slot is drawn in this color, so others can tell you apart.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Color">
        {USER_COLORS.map(({ name: colorName, hex: option }) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={current === option}
            aria-label={colorName}
            title={colorName}
            onClick={() => save(option)}
            className="flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-checked:ring-2 aria-checked:ring-foreground"
            style={{ backgroundColor: option, color: textColorOn(option) }}
          >
            {current === option && <CheckIcon className="size-4" />}
          </button>
        ))}
        <label
          title="Any other color"
          className={cn(
            "relative flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/50 px-2.5 text-xs text-muted-foreground hover:text-foreground",
            isCustom && "border-solid border-foreground text-foreground",
          )}
        >
          {isCustom && (
            <span className="size-3 rounded-full" style={{ backgroundColor: current }} />
          )}
          Custom…
          {/* React's `onChange` fires on every step of a drag across the
              picker, so only the color it comes to rest on is saved. */}
          <input
            type="color"
            value={current}
            onChange={(e) => save(e.target.value, CUSTOM_COLOR_DEBOUNCE_MS)}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
      </div>

      {setColor.isError && (
        <p className="text-sm text-destructive" aria-live="polite">
          Couldn't save your color.
        </p>
      )}
    </div>
  );
};

const Profile = () => {
  const session = useSessionQuery();
  const channel = useChannelQuery();
  const localMembers = useChannelMembersQuery();
  const addMember = useAddChannelMemberMutation();

  const localMemberIds = new Set((localMembers.data ?? []).map((member) => member.userId));
  const currentSession = session.data?.session;

  if (session.isPending) return <PageLoader />;

  if (!currentSession) {
    return (
      <PageContainer className="p-2 md:px-6">
        <div className="flex w-full max-w-prose flex-col items-start gap-3">
          <h1 className="text-2xl font-semibold">Profile</h1>
          <p className="text-sm text-muted-foreground">
            You're not logged in.{" "}
            <Link to="/login" className="underline">
              Log in
            </Link>{" "}
            to see your channel.
          </p>
        </div>
      </PageContainer>
    );
  }

  if (channel.isPending || localMembers.isPending) return <PageLoader />;

  return (
    <PageContainer className="p-2 pb-10 md:px-6">
      <div className="flex w-full max-w-prose flex-col items-start gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Profile</h1>
          <p className="text-sm text-muted-foreground">
            Who you're signed in as, and the channel you're looking at.
          </p>
        </header>

        <Section title="You">
          <dl className="flex flex-col">
            <DetailRow label="Name">{currentSession.userName}</DetailRow>
            <DetailRow label="Channel">#{currentSession.channelName}</DetailRow>
          </dl>
        </Section>

        <Section title="Your color">
          <ColorPicker name={currentSession.userName} color={currentSession.userColor} />
        </Section>

        <Section
          title="Channel"
          description="Pulled live from Slack."
          action={
            channel.data ? <Badge>{channel.data.isPrivate ? "Private" : "Public"}</Badge> : null
          }
        >
          {channel.isError || !channel.data ? (
            <p className="text-sm text-muted-foreground">
              Couldn't load channel details from Slack.
            </p>
          ) : (
            <dl className="flex flex-col">
              <DetailRow label="Created">{formatCreated(channel.data.created)}</DetailRow>
              {channel.data.topic && <DetailRow label="Topic">{channel.data.topic}</DetailRow>}
              {channel.data.purpose && (
                <DetailRow label="Purpose">{channel.data.purpose}</DetailRow>
              )}
            </dl>
          )}
        </Section>

        <Section
          title={channel.data ? `Members (${channel.data.members.length})` : "Members"}
          description="Add someone to make them pickable as an attendee before they've ever logged in."
        >
          {channel.isError || !channel.data ? (
            <p className="text-sm text-muted-foreground">Couldn't load the member list.</p>
          ) : channel.data.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members found in this channel.</p>
          ) : (
            <ul className="flex flex-col">
              {channel.data.members.map((member) => {
                const isLocal = localMemberIds.has(member.userId);
                const isAddingThis =
                  addMember.isPending && addMember.variables?.userId === member.userId;

                return (
                  <li
                    key={member.userId}
                    className="flex items-center justify-between gap-2 border-t border-border py-2 text-sm first:border-t-0 first:pt-0"
                  >
                    <span className="min-w-0 truncate">{member.name}</span>
                    {isLocal ? (
                      <Badge variant="outline">Added</Badge>
                    ) : (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isAddingThis}
                        onClick={() => addMember.mutate({ userId: member.userId })}
                      >
                        {isAddingThis ? "Adding…" : "Add"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {addMember.isError && (
            <p className="text-sm text-destructive" aria-live="polite">
              Failed to add that member.
            </p>
          )}
        </Section>
      </div>
    </PageContainer>
  );
};

export const Route = createFileRoute("/profile")({
  component: Profile,
});

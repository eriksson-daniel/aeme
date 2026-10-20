import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { client } from "../api.ts";
import type { Viewer } from "../lib/responders.ts";
import { activitiesQueryKey } from "./activities.ts";
import { channelQueryKey } from "./channel.ts";
import { channelMembersQueryKey } from "./channelMembers.ts";

export const sessionQueryKey = ["session"] as const;
export const sessionChannelsQueryKey = ["session-channels"] as const;

const fetchSession = async () => {
  const res = await client.session.$get();
  if (!res.ok) throw new Error("Failed to load session.");
  return res.json();
};

export const useSessionQuery = () =>
  useQuery({
    queryKey: sessionQueryKey,
    queryFn: fetchSession,
  });

/** The logged-in user as a grid draws them — see `cellPeople`. */
export const useViewer = (): Viewer | undefined => {
  const session = useSessionQuery().data?.session;
  return session
    ? { userId: session.userId, name: session.userName, color: session.userColor }
    : undefined;
};

/** Changes the logged-in user's own color. Everything that draws people is
 * refetched: the session (for the viewer's own cells) and activities (for
 * their part of everyone else's view, including this one's). */
export const useSetUserColorMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (color: string) => {
      const res = await client.session.color.$put({ json: { color } });
      if (!res.ok) throw new Error("Failed to change color.");
      return res.json();
    },
    // Returned, so the mutation stays pending until the new color is on
    // screen everywhere — the picker holds its draft until then.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
        queryClient.invalidateQueries({ queryKey: activitiesQueryKey }),
      ]),
  });
};

export const useSessionChannelsQuery = () =>
  useQuery({
    queryKey: sessionChannelsQueryKey,
    queryFn: async () => {
      const res = await client.session.channels.$get();
      if (!res.ok) throw new Error("Failed to load channels.");
      const { channels } = await res.json();
      return channels;
    },
  });

/** Points the current session at a different channel the user belongs to —
 * every channel-scoped query is invalidated afterward since they're all
 * implicitly scoped to `session.channelId` server-side. */
export const useSwitchChannelMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (channelId: string) => {
      const res = await client.session.channel.$post({ json: { channelId } });
      if (!res.ok) throw new Error("Failed to switch channel.");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      queryClient.invalidateQueries({ queryKey: activitiesQueryKey });
      queryClient.invalidateQueries({ queryKey: channelQueryKey });
      queryClient.invalidateQueries({ queryKey: channelMembersQueryKey });
    },
  });
};

export const useLoginMutation = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: async (otp: string) => {
      const res = await client.login.$post({ form: { otp } });
      if (!res.ok) throw new Error("Invalid or expired code.");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      navigate({ to: "/" });
    },
  });
};

export const useLogoutMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await client.session.$delete();
      if (!res.ok) throw new Error("Failed to log out.");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
};

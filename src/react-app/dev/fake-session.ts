import type { SessionMeta } from "../../worker/auth/session.ts";
import { USER_COLOR_PALETTE } from "../../worker/users/colors.ts";

const STORAGE_KEY = "aeme:dev-fake-session";

const FAKE_SESSION: SessionMeta = {
  userId: "dev-user",
  userName: "Dev User",
  userColor: USER_COLOR_PALETTE[0],
  channelId: "C0C3KKW19MK",
  channelName: "dev",
  expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
};

export const isFakeSessionEnabled = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

export const getFakeSession = (): SessionMeta | null =>
  isFakeSessionEnabled() ? FAKE_SESSION : null;

export const setFakeSessionEnabled = (enabled: boolean) => {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private browsing / storage disabled — fake login just won't persist
  }
};

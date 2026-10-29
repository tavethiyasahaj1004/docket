"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { adminClient, magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // oauthProviderClient() attaches the signed OAuth query of the current page to
  // sign-in and consent requests, so an interrupted authorization resumes. It adds
  // nothing when the page has no signed OAuth query.
  plugins: [magicLinkClient(), adminClient(), oauthProviderClient()],
});

export const { signIn, signOut, useSession } = authClient;

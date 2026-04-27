/**
 * Profile Page Example - from RFC-0001 spec
 */

import { app } from "../packages/core/src/index.js";

type User = { id: string; name: string; premium: boolean };

export default app
  .defineState<{ user: User | null }>({ user: null })
  .onCreated(async (state) => {
    // Called once when module is instantiated
    console.log("ProfilePage created");
  })
  .onAction("signInWithGoogle", async ({ state }) => {
    // Called whenever @actions.signInWithGoogle is dispatched
    state.user = { id: "1", name: "Ian", premium: true };
  })
  .onDestroyed((state) => {
    console.log("ProfilePage destroyed");
  });

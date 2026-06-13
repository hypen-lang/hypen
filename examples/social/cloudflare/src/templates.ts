/**
 * Static text imports for every `.hypen` template. Wrangler's `Text`
 * rule turns the `.hypen` file into a string at build time so the worker
 * bundle is self-contained (no file system inside a DO).
 *
 * The map below is keyed by component name (matches `app.module("Foo")`
 * registrations). `App` is the entry template — used by the DO directly
 * — and every other entry feeds the engine's component resolver when a
 * `Foo()` element appears in the IR.
 */

// @ts-ignore
import appTpl from "./components/App.hypen";
// @ts-ignore
import bottomNavTpl from "./components/BottomNav.hypen";
// @ts-ignore
import commentsTpl from "./components/Comments.hypen";
// @ts-ignore
import homePageTpl from "./components/HomePage.hypen";
// @ts-ignore
import messagesTpl from "./components/Messages.hypen";
// @ts-ignore
import notificationsTpl from "./components/Notifications.hypen";
// @ts-ignore
import postTpl from "./components/Post.hypen";
// @ts-ignore
import profileTpl from "./components/Profile.hypen";
// @ts-ignore
import searchTpl from "./components/Search.hypen";
// @ts-ignore
import storiesTpl from "./components/Stories.hypen";
// @ts-ignore
import storyTpl from "./components/Story.hypen";
// @ts-ignore
import storyItemTpl from "./components/StoryItem.hypen";
// @ts-ignore
import userProfileTpl from "./components/UserProfile.hypen";

export const appTemplate = appTpl as string;

export const templates: Record<string, string> = {
  App: appTpl as string,
  BottomNav: bottomNavTpl as string,
  Comments: commentsTpl as string,
  HomePage: homePageTpl as string,
  Messages: messagesTpl as string,
  Notifications: notificationsTpl as string,
  Post: postTpl as string,
  Profile: profileTpl as string,
  Search: searchTpl as string,
  Stories: storiesTpl as string,
  Story: storyTpl as string,
  StoryItem: storyItemTpl as string,
  UserProfile: userProfileTpl as string,
};

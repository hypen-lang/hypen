import { app } from "../../../hypen-web/packages/core/src/index.ts";

export type ProfileState = {
  name: string;
  email: string;
  bio: string;
  followers: number;
  following: number;
  posts: number;
  isFollowing: boolean;
};

export const profileModule = app
  .defineState<ProfileState>({
    name: "Alex Johnson",
    email: "alex@example.com",
    bio: "Designer & Developer. Building beautiful apps with Hypen.",
    followers: 1247,
    following: 892,
    posts: 64,
    isFollowing: false,
  })
  .onAction("toggleFollow", async ({ state }) => {
    state.isFollowing = !state.isFollowing;
    state.followers += state.isFollowing ? 1 : -1;
  })
  .onAction("message", async () => {
    console.log("Message tapped");
  })
  .build();

export const profileUI = `
Column {
  Column {
    Column {
      Text("AJ")
        .fontSize(40)
        .fontWeight("600")
        .color("#ffffff")
    }
    .width(100)
    .height(100)
    .backgroundColor("#8b5cf6")
    .borderRadius(50)
    .horizontalAlignment("center")
    .verticalAlignment("center")

    Text("@{state.name}")
      .fontSize(26)
      .fontWeight("700")
      .color("#1a1a1a")
      .marginTop(20)

    Text("@{state.email}")
      .fontSize(15)
      .color("#6b7280")
      .marginTop(6)

    Text("@{state.bio}")
      .fontSize(15)
      .color("#4b5563")
      .marginTop(16)
      .textAlign("center")
  }
  .padding(32)
  .horizontalAlignment("center")

  Row {
    Column {
      Text("@{state.posts}")
        .fontSize(22)
        .fontWeight("700")
        .color("#1a1a1a")
      Text("Posts")
        .fontSize(13)
        .color("#9ca3af")
        .marginTop(4)
    }
    .horizontalAlignment("center")
    .flex(1)

    Column {
      Text("@{state.followers}")
        .fontSize(22)
        .fontWeight("700")
        .color("#1a1a1a")
      Text("Followers")
        .fontSize(13)
        .color("#9ca3af")
        .marginTop(4)
    }
    .horizontalAlignment("center")
    .flex(1)

    Column {
      Text("@{state.following}")
        .fontSize(22)
        .fontWeight("700")
        .color("#1a1a1a")
      Text("Following")
        .fontSize(13)
        .color("#9ca3af")
        .marginTop(4)
    }
    .horizontalAlignment("center")
    .flex(1)
  }
  .paddingTop(24)
  .paddingBottom(24)
  .marginLeft(24)
  .marginRight(24)
  .borderTopWidth(1)
  .borderBottomWidth(1)
  .borderColor("#e5e7eb")

  Row {
    Button {
      Text("@{state.isFollowing ? 'Following' : 'Follow'}")
        .fontSize(16)
        .fontWeight("600")
        .color("@{state.isFollowing ? '#1a1a1a' : '#ffffff'}")
    }
    .onClick(@actions.toggleFollow)
    .flex(1)
    .paddingTop(16)
    .paddingBottom(16)
    .backgroundColor("@{state.isFollowing ? '#f3f4f6' : '#2563eb'}")
    .borderRadius(12)
    .horizontalAlignment("center")

    Button {
      Text("Message")
        .fontSize(16)
        .fontWeight("600")
        .color("#1a1a1a")
    }
    .onClick(@actions.message)
    .flex(1)
    .paddingTop(16)
    .paddingBottom(16)
    .backgroundColor("#f3f4f6")
    .borderRadius(12)
    .horizontalAlignment("center")
  }
  .gap(12)
  .padding(24)

  Column {
    Text("Recent Activity")
      .fontSize(18)
      .fontWeight("600")
      .color("#1a1a1a")
      .marginBottom(16)

    Row {
      Column {
        Text("Posted a photo")
          .fontSize(15)
          .color("#4b5563")
        Text("2 hours ago")
          .fontSize(13)
          .color("#9ca3af")
          .marginTop(4)
      }
    }
    .padding(16)
    .backgroundColor("#f9fafb")
    .borderRadius(12)
    .marginBottom(10)

    Row {
      Column {
        Text("Liked a post")
          .fontSize(15)
          .color("#4b5563")
        Text("5 hours ago")
          .fontSize(13)
          .color("#9ca3af")
          .marginTop(4)
      }
    }
    .padding(16)
    .backgroundColor("#f9fafb")
    .borderRadius(12)
    .marginBottom(10)

    Row {
      Column {
        Text("Started following @hypen")
          .fontSize(15)
          .color("#4b5563")
        Text("Yesterday")
          .fontSize(13)
          .color("#9ca3af")
          .marginTop(4)
      }
    }
    .padding(16)
    .backgroundColor("#f9fafb")
    .borderRadius(12)
  }
  .padding(24)
}
.fillMaxSize()
.backgroundColor("#ffffff")
`;

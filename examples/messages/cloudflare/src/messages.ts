import { app } from "@hypen-space/core";
import type { GlobalContext } from "@hypen-space/core";
import { currentConn, type ConnScope } from "./scope";
import { EMPTY_ROOM, EMPTY_TOAST, type MessagesState } from "./state";
import { PALETTE, cleanMessage, cleanName, cleanRoomName, initialOf, isPaletteColor } from "./text";

// Messages — a real-time chat between the visitors of this worker.
//
// Each socket is its own Hypen session with its own copy of this module's
// state (screen, open room, draft, scroll window). The chat itself lives in
// the hub (hub.ts): SQLite tables in the single coordinator Durable Object,
// plus a registry of live connections whose state the hub re-derives on every
// write. Handlers here are thin: validate input, ask the hub, show errors.
//
// Identity comes from `currentConn()` (scope.ts) — the visitor cookie the
// worker stamped on the socket — never from module state.

const initialState: MessagesState = {
  screen: "setup",
  me: { id: "", name: "", color: PALETTE[0], initial: "" },
  setupName: "",
  setupColor: "",
  setupInitial: "",
  setupError: "",
  editingProfile: false,
  colors: PALETTE.map((color, i) => ({ color, selected: i === 0 })),

  conversations: [],
  unreadTotal: 0,
  people: [],
  onlineCount: 0,
  hasPeople: false,

  room: { ...EMPTY_ROOM },
  messages: [],
  hasMore: false,
  isEmpty: true,
  typingText: "",
  isTyping: false,

  draft: "",
  notice: "",
  hasNotice: false,
  pickerFor: "",
  pickerOpen: false,
  reactionChoices: [],

  newRoomName: "",
  newRoomError: "",

  toast: { ...EMPTY_TOAST },
  canAttach: false,
  uploading: false,
};

/** Register this session with the hub (idempotent) and return the caller's scope. */
function join(state: MessagesState, context?: GlobalContext): ConnScope | null {
  const conn = currentConn();
  if (!conn) return null;
  conn.hub.attach(conn.key, conn.visitorId, conn.tz, state);
  if (context) {
    const canAttach = context.device.supports("gallery.pick") || context.device.supports("file.pick");
    if (state.canAttach !== canAttach) state.canAttach = canAttach;
  }
  return conn;
}

function setNotice(state: MessagesState, text: string): void {
  state.notice = text;
  state.hasNotice = text !== "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function deviceMessage(code: string): string {
  switch (code) {
    case "cancelled":
      return "";
    case "denied":
      return "Photo access was denied.";
    case "unsupported":
    case "unavailable":
      return "Photo sharing isn't available on this connection.";
    case "timeout":
      return "The photo picker timed out.";
    default:
      return "Couldn't get that photo.";
  }
}

export default app
  .defineState<MessagesState>(initialState)
  .onCreated((state, context) => {
    join(state, context);
  })
  .onDestroyed(() => {
    const conn = currentConn();
    conn?.hub.detach(conn.key);
  })

  // ---- profile -------------------------------------------------------------
  .onAction<{ value?: string }>("nameInput", ({ action, state, context }) => {
    join(state, context);
    const name = str(action.payload?.value) || state.setupName;
    state.setupInitial = name.trim() ? initialOf(name) : "";
    if (state.setupError) state.setupError = "";
  })
  .onAction<{ color?: string }>("pickColor", ({ action, state, context }) => {
    const conn = join(state, context);
    const color = action.payload?.color;
    if (conn && isPaletteColor(color)) conn.hub.pickColor(state, color);
  })
  .onAction("saveProfile", ({ state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    const name = cleanName(state.setupName);
    if (!name) {
      state.setupError = "Pick a name (up to 24 characters).";
      return;
    }
    const color = isPaletteColor(state.setupColor) ? state.setupColor : PALETTE[0];
    const res = conn.hub.saveProfile(conn.key, name, color);
    state.setupError = res.ok ? "" : res.error;
  })
  .onAction("editProfile", ({ state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    state.setupName = state.me.name;
    state.setupInitial = state.me.initial;
    conn.hub.pickColor(state, state.me.color);
    state.setupError = "";
    state.editingProfile = true;
    state.screen = "setup";
  })
  .onAction("cancelProfile", ({ state, context }) => {
    join(state, context);
    state.editingProfile = false;
    state.screen = "list";
  })

  // ---- navigation ----------------------------------------------------------
  .onAction<{ id?: string }>("openRoom", ({ action, state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    const res = conn.hub.openRoom(conn.key, str(action.payload?.id));
    setNotice(state, res.ok ? "" : res.error);
  })
  .onAction("back", ({ state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    if (state.screen === "thread") conn.hub.closeRoom(conn.key);
    else state.screen = "list";
    setNotice(state, "");
  })
  .onAction("showNewRoom", ({ state, context }) => {
    join(state, context);
    state.newRoomName = "";
    state.newRoomError = "";
    state.screen = "newRoom";
  })
  .onAction("createRoom", ({ state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    const slug = cleanRoomName(state.newRoomName);
    if (!slug) {
      state.newRoomError = "Room names need 2–24 letters, digits or dashes.";
      return;
    }
    const res = conn.hub.createRoom(conn.key, slug);
    state.newRoomError = res.ok ? "" : res.error;
  })
  .onAction("showNewDm", ({ state, context }) => {
    join(state, context);
    state.screen = "newDm";
  })
  .onAction<{ id?: string }>("startDm", ({ action, state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    const res = conn.hub.openDm(conn.key, str(action.payload?.id));
    setNotice(state, res.ok ? "" : res.error);
  })
  .onAction("openToast", ({ state, context }) => {
    const conn = join(state, context);
    if (!conn || !state.toast.roomId) return;
    const roomId = state.toast.roomId;
    conn.hub.dismissToast(conn.key);
    conn.hub.openRoom(conn.key, roomId);
  })
  .onAction("dismissToast", ({ state, context }) => {
    const conn = join(state, context);
    conn?.hub.dismissToast(conn.key);
  })
  .onAction("dismissNotice", ({ state, context }) => {
    join(state, context);
    setNotice(state, "");
  })

  // ---- thread --------------------------------------------------------------
  .onAction("send", ({ state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    const text = cleanMessage(state.draft);
    if (!text) return;
    const res = conn.hub.send(conn.key, text);
    if (res.ok) {
      state.draft = "";
      setNotice(state, "");
    } else {
      setNotice(state, res.error);
    }
  })
  .onAction<{ value?: string }>("typing", ({ action, state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    const value = typeof action.payload?.value === "string" ? action.payload.value : state.draft;
    conn.hub.typingPing(conn.key, value.trim() !== "");
  })
  .onAction("loadOlder", ({ state, context }) => {
    const conn = join(state, context);
    conn?.hub.loadOlder(conn.key);
  })
  .onAction<{ scrollTop?: number; scrollHeight?: number; clientHeight?: number }>("scrolled", ({ action, state, context }) => {
    // The thread scrolls in a column-reverse container (it stays pinned to
    // the newest message by itself), where scrollTop runs from 0 at the
    // bottom to -(scrollHeight - clientHeight) at the top.
    const p = action.payload ?? {};
    if (!state.hasMore || typeof p.scrollTop !== "number" || typeof p.scrollHeight !== "number" || typeof p.clientHeight !== "number") return;
    const fromTop = p.scrollHeight - p.clientHeight - Math.abs(p.scrollTop);
    if (fromTop > 400) return; // prefetch before the edge, so the view keeps its place
    const conn = join(state, context);
    conn?.hub.loadOlder(conn.key);
  })
  .onAction<{ id?: string }>("selectMessage", ({ action, state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    const id = str(action.payload?.id);
    state.pickerFor = state.pickerFor === id ? "" : id;
    state.pickerOpen = state.pickerFor !== "";
    conn.hub.refreshThread(conn.key);
  })
  .onAction("closePicker", ({ state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    state.pickerFor = "";
    state.pickerOpen = false;
    conn.hub.refreshThread(conn.key);
  })
  .onAction<{ emoji?: string }>("react", ({ action, state, context }) => {
    const conn = join(state, context);
    if (!conn || !state.pickerFor) return;
    const res = conn.hub.react(conn.key, state.pickerFor, str(action.payload?.emoji));
    state.pickerFor = "";
    state.pickerOpen = false;
    conn.hub.refreshThread(conn.key);
    setNotice(state, res.ok ? "" : res.error);
  })
  .onAction<{ id?: string; emoji?: string }>("reactTo", ({ action, state, context }) => {
    const conn = join(state, context);
    if (!conn) return;
    const res = conn.hub.react(conn.key, str(action.payload?.id), str(action.payload?.emoji));
    setNotice(state, res.ok ? "" : res.error);
  })
  .onAction("attachImage", async ({ state, context }) => {
    const conn = join(state, context);
    if (!conn || state.uploading) return;
    // Captured before the await: the pick takes as long as the user likes,
    // and they may navigate meanwhile — the photo goes where they started.
    const roomId = conn.hub.roomOf(conn.key);
    if (!roomId) return;
    const useGallery = context.device.supports("gallery.pick");
    if (!useGallery && !context.device.supports("file.pick")) {
      setNotice(state, "Photo sharing isn't available on this connection.");
      return;
    }
    state.uploading = true;
    try {
      const res = useGallery
        ? await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 })
        : await context.device.request("file.pick", { accept: ["image/png", "image/jpeg", "image/gif", "image/webp"], maxCount: 1 });
      if (!res.ok) {
        setNotice(state, deviceMessage(res.error.code));
        return;
      }
      const item = res.value.items[0];
      if (!item) return;
      const posted = conn.hub.postImage(conn.key, roomId, item.bytes);
      setNotice(state, posted.ok ? "" : posted.error);
    } finally {
      state.uploading = false;
    }
  })
  .ui(`
    module App {
      Column {
        Column {
          // ---- in-app notification for a DM that arrived elsewhere ----
          If(condition: @state.toast.show) {
            Row {
              Column {
                Text("@{state.toast.initial}").fontSize(15).fontWeight(700).color("#FFFFFF")
              }
                .width(36).height(36).borderRadius(18).flexShrink(0)
                .backgroundColor("@{state.toast.color}")
                .horizontalAlignment("center").verticalAlignment("center")
              Column {
                Text("@{state.toast.title}").fontSize(14).fontWeight(700).color("#F8FAFC")
                Text("@{state.toast.text}").fontSize(13).color("#CBD5E1").maxLines(1).textOverflow("ellipsis")
              }
                .flex(1).minWidth(0).gap(1)
              Button { Text("✕").fontSize(13).color("#94A3B8") }
                .label("Dismiss")
                .backgroundColor("transparent").padding(6)
                .onClick(@actions.dismissToast)
            }
              .gap(10).padding(10).margin(8).borderRadius(16)
              .backgroundColor("#0F172A")
              .boxShadow("0 10px 30px rgba(15, 23, 42, 0.35)")
              .verticalAlignment("center").cursor("pointer")
              .onClick(@actions.openToast)
              .liveRegion("polite")
              .enter(slide, fade, from: top)
              .exit(fade, duration: 150)
          }

          When(value: @state.screen) {
            // =========================== SETUP ===========================
            Case(match: "setup") {
              Column {
                Column {
                  Column {
                    Column {
                      Text("@{state.setupInitial}").fontSize(34).fontWeight(700).color("#FFFFFF")
                    }
                      .width(84).height(84).borderRadius(42)
                      .backgroundColor("@{state.setupColor}")
                      .horizontalAlignment("center").verticalAlignment("center")
                      .boxShadow("0 12px 30px rgba(15, 23, 42, 0.18)")
                      .transition(250, easeOut)
                    Heading("@{state.editingProfile ? 'Your profile' : 'Welcome to Messages'}", level: 1)
                      .fontSize(24).fontWeight(800).color("#0F172A").textAlign("center")
                    Text("Pick a name and a colour. Everyone you chat with sees them.")
                      .fontSize(14).color("#64748B").textAlign("center").maxWidth(280)
                  }
                    .gap(10).horizontalAlignment("center").width("100%")

                  Column {
                    Text("Display name").fontSize(13).fontWeight(600).color("#334155")
                    Input(placeholder: "e.g. Ada")
                      .bind(@state.setupName)
                      .onInput(@actions.nameInput)
                      .onKey(@actions.saveProfile)
                      .label("Display name")
                      .maxLength(24)
                      .padding(horizontal: 14, vertical: 12).fontSize(16)
                      .borderRadius(12).border("1px solid #CBD5E1").backgroundColor("#FFFFFF")
                      .width("100%")
                  }
                    .gap(6).width("100%")

                  Column {
                    Text("Colour").fontSize(13).fontWeight(600).color("#334155")
                    Row {
                      ForEach(items: @state.colors, key: "color", as: "swatch") {
                        Button {}
                          .label("Colour @{swatch.color}")
                          .width(32).height(32).borderRadius(16)
                          .backgroundColor("@{swatch.color}")
                          .border("@{swatch.selected ? '3px solid #0F172A' : '3px solid #FFFFFF'}")
                          .boxShadow("0 1px 3px rgba(15, 23, 42, 0.25)")
                          .onClick(@actions.pickColor, color: "@{swatch.color}")
                      }
                    }
                      .gap(8).flexWrap("wrap")
                  }
                    .gap(8).width("100%")

                  If(condition: @state.setupError) {
                    Text("@{state.setupError}").fontSize(13).color("#DC2626")
                  }

                  Button {
                    Text("@{state.editingProfile ? 'Save' : 'Start chatting'}")
                      .fontSize(16).fontWeight(700).color("#FFFFFF")
                  }
                    .width("100%").padding(14).borderRadius(14)
                    .backgroundColor({default: "#4F46E5", hover: "#4338CA"})
                    .onClick(@actions.saveProfile)

                  If(condition: @state.editingProfile) {
                    Button { Text("Cancel").fontSize(15).color("#475569") }
                      .backgroundColor("transparent").padding(8)
                      .onClick(@actions.cancelProfile)
                  }
                }
                  .gap(22).padding(28).paddingTop(48)
                  .width("100%").maxWidth(420).alignSelf("center")
              }
                .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("auto").backgroundColor("#FFFFFF")
            }

            // ======================= CONVERSATIONS =======================
            Case(match: "list") {
              Column {
                Row {
                  Column {
                    Heading("Messages", level: 1).fontSize(28).fontWeight(800).color("#0F172A")
                    Text("@{state.onlineCount} other@{state.onlineCount == 1 ? '' : 's'} online")
                      .fontSize(13).color("#64748B")
                  }
                    .flex(1).gap(2)
                  Button { Text("New room").fontSize(13).fontWeight(600).color("#4F46E5") }
                    .padding(horizontal: 12, vertical: 8).borderRadius(999)
                    .backgroundColor({default: "#EEF2FF", hover: "#E0E7FF"})
                    .onClick(@actions.showNewRoom)
                  Button {
                    Text("@{state.me.initial}").fontSize(15).fontWeight(700).color("#FFFFFF")
                  }
                    .label("Edit profile")
                    .width(38).height(38).borderRadius(19).padding(0)
                    .horizontalAlignment("center").verticalAlignment("center")
                    .backgroundColor("@{state.me.color}")
                    .onClick(@actions.editProfile)
                }
                  .gap(10).padding(horizontal: 18, vertical: 14).verticalAlignment("center")

                // Who's around — tap a face to DM them.
                If(condition: @state.hasPeople) {
                  Row {
                    ForEach(items: @state.people, key: "id", as: "person") {
                      Column {
                        Stack {
                          Column {
                            Text("@{person.initial}").fontSize(18).fontWeight(700).color("#FFFFFF")
                          }
                            .width(52).height(52).borderRadius(26)
                            .backgroundColor("@{person.color}")
                            .horizontalAlignment("center").verticalAlignment("center")
                            .opacity("@{person.online ? 1 : 0.55}")
                          If(condition: @person.online) {
                            Box {}
                              .width(14).height(14).borderRadius(7)
                              .backgroundColor("#22C55E").border("2px solid #FFFFFF")
                          }
                        }
                          .horizontalAlignment("end").verticalAlignment("end")
                        Text("@{person.name}")
                          .fontSize(12).color("#334155").maxWidth(64)
                          .maxLines(1).textOverflow("ellipsis").textAlign("center")
                      }
                        .gap(6).horizontalAlignment("center").flexShrink(0).cursor("pointer")
                        .onClick(@actions.startDm, id: "@{person.id}")
                    }
                  }
                    .gap(14).padding(horizontal: 18, vertical: 4).overflowX("auto").flexShrink(0)
                }

                Column {
                  ForEach(items: @state.conversations, key: "id", as: "conv") {
                    Row {
                      Stack {
                        Column {
                          Text("@{conv.initial}")
                            .fontSize("@{conv.isRoom ? 22 : 18}").fontWeight(700).color("#FFFFFF")
                        }
                          .width(50).height(50).borderRadius("@{conv.isRoom ? 16 : 25}")
                          .backgroundColor("@{conv.color}")
                          .horizontalAlignment("center").verticalAlignment("center")
                        If(condition: @conv.online) {
                          Box {}
                            .width(14).height(14).borderRadius(7)
                            .backgroundColor("#22C55E").border("2px solid #FFFFFF")
                        }
                      }
                        .horizontalAlignment("end").verticalAlignment("end").flexShrink(0)

                      Column {
                        Row {
                          Text("@{conv.title}")
                            .fontSize(16).fontWeight("@{conv.hasUnread ? 800 : 600}").color("#0F172A")
                            .flex(1).minWidth(0).maxLines(1).textOverflow("ellipsis")
                          Text("@{conv.time}")
                            .fontSize(12).color("@{conv.hasUnread ? '#4F46E5' : '#94A3B8'}")
                        }
                          .gap(8).verticalAlignment("center")
                        Row {
                          Text("@{conv.preview}")
                            .fontSize(14).color("@{conv.hasUnread ? '#0F172A' : '#64748B'}")
                            .flex(1).minWidth(0).maxLines(1).textOverflow("ellipsis")
                          If(condition: @conv.hasUnread) {
                            Text("@{conv.unreadLabel}")
                              .fontSize(12).fontWeight(700).color("#FFFFFF")
                              .backgroundColor("#4F46E5").borderRadius(999)
                              .padding(horizontal: 7, vertical: 2).minWidth(22).textAlign("center")
                              .width("auto").alignSelf("center").flexShrink(0)
                              .enter(scale, fade)
                          }
                        }
                          .gap(8).verticalAlignment("center")
                      }
                        .flex(1).minWidth(0).gap(3)
                    }
                      .gap(12).padding(horizontal: 18, vertical: 10).verticalAlignment("center")
                      .backgroundColor({default: "#FFFFFF", hover: "#F8FAFC"})
                      .cursor("pointer")
                      .onClick(@actions.openRoom, id: "@{conv.id}")
                      .layout(spring)
                  }
                }
                  .flex(1).minHeight(0).overflowY("auto").paddingTop(8)

                Row {
                  Button {
                    Text("✎  New message").fontSize(15).fontWeight(700).color("#FFFFFF")
                  }
                    .flex(1).padding(13).borderRadius(14)
                    .backgroundColor({default: "#4F46E5", hover: "#4338CA"})
                    .onClick(@actions.showNewDm)
                }
                  .padding(14).borderTop("1px solid #EEF2F7").backgroundColor("#FFFFFF")
              }
                .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("hidden").backgroundColor("#FFFFFF")
            }

            // =========================== THREAD ==========================
            Case(match: "thread") {
              Column {
                // header
                Row {
                  Button { Text("‹").fontSize(30).color("#4F46E5").lineHeight(1) }
                    .label("Back to conversations")
                    .backgroundColor("transparent").padding(horizontal: 6, vertical: 0)
                    .onClick(@actions.back)
                  Stack {
                    Column {
                      Text("@{state.room.initial}")
                        .fontSize(16).fontWeight(700).color("#FFFFFF")
                    }
                      .width(38).height(38).borderRadius("@{state.room.isRoom ? 12 : 19}")
                      .backgroundColor("@{state.room.color}")
                      .horizontalAlignment("center").verticalAlignment("center")
                    If(condition: @state.room.online) {
                      Box {}
                        .width(11).height(11).borderRadius(6)
                        .backgroundColor("#22C55E").border("2px solid #FFFFFF")
                    }
                  }
                    .horizontalAlignment("end").verticalAlignment("end").flexShrink(0)
                  Column {
                    Text("@{state.room.title}")
                      .fontSize(16).fontWeight(700).color("#0F172A")
                      .maxLines(1).textOverflow("ellipsis")
                    If(condition: @state.isTyping) {
                      Text("@{state.typingText}").fontSize(12).color("#4F46E5")
                        .maxLines(1).textOverflow("ellipsis")
                        .animate(pulse, duration: 1400)
                      Else {
                        Text("@{state.room.subtitle}").fontSize(12).color("#64748B")
                          .maxLines(1).textOverflow("ellipsis")
                      }
                    }
                  }
                    .flex(1).minWidth(0).gap(1)
                }
                  .gap(8).padding(horizontal: 8, vertical: 8).verticalAlignment("center")
                  .backgroundColor("rgba(255, 255, 255, 0.96)")
                  .borderBottom("1px solid #E2E8F0").flexShrink(0)

                // messages — column-reverse keeps the view pinned to the newest
                // message and holds position when older pages load above.
                Column {
                  Column {
                    If(condition: @state.hasMore) {
                      Button { Text("Load earlier messages").fontSize(13).color("#4F46E5") }
                        .alignSelf("center").padding(horizontal: 14, vertical: 6).marginBottom(6)
                        .borderRadius(999).backgroundColor("#EEF2FF")
                        .onClick(@actions.loadOlder)
                    }
                    If(condition: @state.isEmpty) {
                      Column {
                        Text("👋").fontSize(40)
                        Text("No messages yet").fontSize(15).fontWeight(700).color("#334155")
                        Text("Say something to get the conversation going.").fontSize(13).color("#64748B")
                      }
                        .gap(6).padding(32).horizontalAlignment("center")
                    }

                    ForEach(items: @state.messages, key: "id", as: "m") {
                      If(condition: @m.isDay) {
                        Text("@{m.dayLabel}")
                          .fontSize(12).fontWeight(600).color("#64748B")
                          .alignSelf("center").marginTop(14).marginBottom(4)
                          .padding(horizontal: 10, vertical: 3).borderRadius(999)
                          .backgroundColor("#E8EBF2")
                        Else {
                          Column {
                            If(condition: @m.showName) {
                              Text("@{m.author}")
                                .fontSize(12).fontWeight(600).color("@{m.color}")
                                .marginLeft(46).marginBottom(2)
                            }
                            Row {
                              If(condition: @m.mine) {
                                Spacer()
                                Else {
                                  Column {
                                    If(condition: @m.showAvatar) {
                                      Column {
                                        Text("@{m.initial}").fontSize(12).fontWeight(700).color("#FFFFFF")
                                      }
                                        .width(30).height(30).borderRadius(15)
                                        .backgroundColor("@{m.color}")
                                        .horizontalAlignment("center").verticalAlignment("center")
                                    }
                                  }
                                    .width(30).flexShrink(0).verticalAlignment("end")
                                }
                              }

                              Column {
                                Column {
                                  If(condition: @m.hasImage) {
                                    Image(src: "@{m.image}", alt: "Photo from @{m.author}")
                                      .maxWidth(240).maxHeight(320).borderRadius(14)
                                      .objectFit("cover").display("block")
                                  }
                                  If(condition: @m.hasText) {
                                    Text("@{m.text}")
                                      .fontSize(15).lineHeight(1.4)
                                      .color("@{m.mine ? '#FFFFFF' : '#0F172A'}")
                                      .whiteSpace("pre-wrap").wordBreak("break-word")
                                  }
                                  If(condition: @m.hasPreview) {
                                    Link(href: "@{m.previewUrl}", target: "_blank", rel: "noopener noreferrer nofollow") {
                                      Column {
                                        If(condition: @m.hasPreviewImage) {
                                          Image(src: "@{m.previewImage}", alt: "@{m.previewTitle}")
                                            .width("100%").maxHeight(140).objectFit("cover").display("block")
                                        }
                                        Column {
                                          Text("@{m.previewSite}")
                                            .fontSize(11).textTransform("uppercase").letterSpacing(0.4)
                                            .color("#64748B")
                                          Text("@{m.previewTitle}")
                                            .fontSize(14).fontWeight(700).color("#0F172A")
                                            .maxLines(2).textOverflow("ellipsis")
                                          Text("@{m.previewDesc}")
                                            .fontSize(12).color("#475569")
                                            .maxLines(2).textOverflow("ellipsis")
                                        }
                                          .padding(10).gap(2)
                                      }
                                        .backgroundColor("#FFFFFF").borderRadius(12).overflow("hidden")
                                        .border("1px solid #E2E8F0")
                                    }
                                      .label("Open link preview")
                                      .marginTop(6).display("block").textDecoration("none")
                                  }
                                }
                                  .padding("@{m.hasText ? '9px 13px' : '4px'}")
                                  .borderRadius("@{m.radius}")
                                  .backgroundColor("@{m.mine ? '#4F46E5' : '#FFFFFF'}")
                                  .boxShadow("@{m.mine ? 'none' : '0 1px 2px rgba(15, 23, 42, 0.08)'}")
                                  .outline("@{m.selected ? '2px solid #A5B4FC' : 'none'}")
                                  .cursor("pointer")
                                  .onClick(@actions.selectMessage, id: "@{m.id}")

                                If(condition: @m.hasReactions) {
                                  Row {
                                    ForEach(items: @m.reactions, key: "key", as: "rx") {
                                      Button {
                                        Text("@{rx.label}").fontSize(12).color("#0F172A")
                                      }
                                        .padding(horizontal: 7, vertical: 2).borderRadius(999)
                                        .backgroundColor("@{rx.mine ? '#E0E7FF' : '#FFFFFF'}")
                                        .border("@{rx.mine ? '1px solid #A5B4FC' : '1px solid #E2E8F0'}")
                                        .onClick(@actions.reactTo, id: "@{m.id}", emoji: "@{rx.emoji}")
                                        .enter(scale, fade)
                                    }
                                  }
                                    .gap(4).marginTop(-6).paddingHorizontal(6).flexWrap("wrap")
                                    .horizontalAlignment("@{m.mine ? 'end' : 'start'}")
                                }
                              }
                                .maxWidth("78%").minWidth(0)
                                .horizontalAlignment("@{m.mine ? 'end' : 'start'}")
                            }
                              .gap(8).verticalAlignment("end").width("100%")

                            If(condition: @m.showTime) {
                              Row {
                                Text("@{m.time}").fontSize(11).color("#94A3B8")
                                If(condition: @m.showStatus) {
                                  Text("· @{m.status}").fontSize(11).fontWeight(600).color("#64748B")
                                }
                              }
                                .gap(4).marginTop(3)
                                .marginLeft("@{m.mine ? 0 : 38}")
                                .horizontalAlignment("@{m.mine ? 'end' : 'start'}")
                            }
                          }
                            .marginTop("@{m.gapTop}")
                            .enter(slide, fade, from: bottom, duration: 180)
                        }
                      }
                    }
                  }
                    .padding(horizontal: 12, vertical: 10)
                }
                  .flex(1).minHeight(0).overflowY("auto")
                  .flexDirection("column-reverse")
                  .backgroundColor("#F1F5F9")
                  .onScroll(@actions.scrolled)

                // reaction picker for the selected bubble
                If(condition: @state.pickerOpen) {
                  Row {
                    ForEach(items: @state.reactionChoices, key: "emoji", as: "choice") {
                      Button { Text("@{choice.emoji}").fontSize(22) }
                        .label("React @{choice.emoji}")
                        .padding(6).borderRadius(12)
                        .backgroundColor({default: "transparent", hover: "#F1F5F9"})
                        .onClick(@actions.react, emoji: "@{choice.emoji}")
                    }
                    Spacer()
                    Button { Text("✕").fontSize(14).color("#64748B") }
                      .label("Close reactions")
                      .backgroundColor("transparent").padding(8)
                      .onClick(@actions.closePicker)
                  }
                    .gap(2).padding(horizontal: 10, vertical: 6).verticalAlignment("center")
                    .backgroundColor("#FFFFFF").borderTop("1px solid #E2E8F0")
                    .enter(slide, fade, from: bottom, duration: 160)
                }

                If(condition: @state.hasNotice) {
                  Row {
                    Text("@{state.notice}").fontSize(13).color("#B91C1C").flex(1)
                    Button { Text("OK").fontSize(13).fontWeight(700).color("#B91C1C") }
                      .backgroundColor("transparent").padding(4)
                      .onClick(@actions.dismissNotice)
                  }
                    .padding(horizontal: 14, vertical: 8).backgroundColor("#FEF2F2")
                    .verticalAlignment("center").liveRegion("polite")
                }

                // composer
                Row {
                  If(condition: @state.canAttach) {
                    Button { Text("@{state.uploading ? '…' : '+'}").fontSize(22).color("#4F46E5").lineHeight(1) }
                      .label("Send a photo")
                      .width(40).height(40).borderRadius(20).padding(0).flexShrink(0)
                      .horizontalAlignment("center").verticalAlignment("center")
                      .backgroundColor({default: "#EEF2FF", hover: "#E0E7FF"})
                      .onClick(@actions.attachImage)
                  }
                  Input(placeholder: "Message @{state.room.title}")
                    .bind(@state.draft)
                    .onInput(@actions.typing)
                    .onKey(@actions.send)
                    .label("Message")
                    .maxLength(1000)
                    .flex(1).minWidth(0)
                    .padding(horizontal: 16, vertical: 11).fontSize(15)
                    .borderRadius(22).border("1px solid #CBD5E1")
                    .backgroundColor("#FFFFFF")
                  Button { Text("Send").fontSize(14).fontWeight(700).color("#FFFFFF") }
                    .padding(horizontal: 16, vertical: 11).borderRadius(22).flexShrink(0)
                    .backgroundColor({default: "#4F46E5", hover: "#4338CA"})
                    .onClick(@actions.send)
                }
                  .gap(8).padding(10).verticalAlignment("center")
                  .backgroundColor("#FFFFFF").borderTop("1px solid #E2E8F0").flexShrink(0)
              }
                .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("hidden").backgroundColor("#FFFFFF")
            }

            // ========================== NEW ROOM =========================
            Case(match: "newRoom") {
              Column {
                Row {
                  Button { Text("‹").fontSize(30).color("#4F46E5").lineHeight(1) }
                    .label("Back")
                    .backgroundColor("transparent").padding(horizontal: 6, vertical: 0)
                    .onClick(@actions.back)
                  Heading("New room", level: 2).fontSize(18).fontWeight(700).color("#0F172A")
                }
                  .gap(8).padding(8).verticalAlignment("center").borderBottom("1px solid #E2E8F0")
                Column {
                  Text("Rooms are public — everyone can read and post.")
                    .fontSize(14).color("#64748B")
                  Row {
                    Text("#").fontSize(18).fontWeight(700).color("#94A3B8")
                    Input(placeholder: "room-name")
                      .bind(@state.newRoomName)
                      .onKey(@actions.createRoom)
                      .label("Room name")
                      .maxLength(24)
                      .flex(1).minWidth(0).fontSize(16)
                      .padding(horizontal: 4, vertical: 12)
                      .border("none").backgroundColor("transparent")
                  }
                    .gap(4).padding(horizontal: 12).verticalAlignment("center")
                    .borderRadius(12).border("1px solid #CBD5E1").backgroundColor("#FFFFFF")
                  If(condition: @state.newRoomError) {
                    Text("@{state.newRoomError}").fontSize(13).color("#DC2626")
                  }
                  Button { Text("Create room").fontSize(15).fontWeight(700).color("#FFFFFF") }
                    .padding(13).borderRadius(14)
                    .backgroundColor({default: "#4F46E5", hover: "#4338CA"})
                    .onClick(@actions.createRoom)
                }
                  .gap(14).padding(20).width("100%").maxWidth(480)
              }
                .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("hidden").backgroundColor("#FFFFFF")
            }

            // ========================= NEW MESSAGE =======================
            Case(match: "newDm") {
              Column {
                Row {
                  Button { Text("‹").fontSize(30).color("#4F46E5").lineHeight(1) }
                    .label("Back")
                    .backgroundColor("transparent").padding(horizontal: 6, vertical: 0)
                    .onClick(@actions.back)
                  Heading("New message", level: 2).fontSize(18).fontWeight(700).color("#0F172A")
                }
                  .gap(8).padding(8).verticalAlignment("center").borderBottom("1px solid #E2E8F0")
                If(condition: @state.hasPeople) {
                  Column {
                    ForEach(items: @state.people, key: "id", as: "who") {
                      Row {
                        Stack {
                          Column {
                            Text("@{who.initial}").fontSize(16).fontWeight(700).color("#FFFFFF")
                          }
                            .width(44).height(44).borderRadius(22)
                            .backgroundColor("@{who.color}")
                            .horizontalAlignment("center").verticalAlignment("center")
                          If(condition: @who.online) {
                            Box {}
                              .width(12).height(12).borderRadius(6)
                              .backgroundColor("#22C55E").border("2px solid #FFFFFF")
                          }
                        }
                          .horizontalAlignment("end").verticalAlignment("end").flexShrink(0)
                        Column {
                          Text("@{who.name}").fontSize(16).fontWeight(600).color("#0F172A")
                          Text("@{who.status}").fontSize(13)
                            .color("@{who.online ? '#16A34A' : '#94A3B8'}")
                        }
                          .flex(1).gap(1)
                      }
                        .gap(12).padding(horizontal: 18, vertical: 10).verticalAlignment("center")
                        .backgroundColor({default: "#FFFFFF", hover: "#F8FAFC"})
                        .cursor("pointer")
                        .onClick(@actions.startDm, id: "@{who.id}")
                    }
                  }
                    .flex(1).minHeight(0).overflowY("auto")
                  Else {
                    Column {
                      Text("🫥").fontSize(40)
                      Text("Nobody else is here yet").fontSize(15).fontWeight(700).color("#334155")
                      Text("Open this app in another browser and say hi in #general.")
                        .fontSize(13).color("#64748B").textAlign("center")
                    }
                      .gap(6).padding(40).horizontalAlignment("center")
                  }
                }
              }
                .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("hidden").backgroundColor("#FFFFFF")
            }
          }
        }
          .flex(1).minHeight(0).width("100%").maxWidth(760)
          .backgroundColor("#FFFFFF")
          .boxShadow({default: "none", md: "0 0 0 1px #E2E8F0, 0 20px 60px rgba(15, 23, 42, 0.08)"})
      }
        .flex(1).minHeight(0).height("100%").width("100%")
        .horizontalAlignment("center")
        .backgroundColor("#E2E8F0")
        .fontFamily("-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif")
        .overflow("hidden")
    }
  `);

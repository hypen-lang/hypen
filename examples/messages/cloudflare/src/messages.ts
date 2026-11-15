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
        // ---- in-app notification for a DM that arrived elsewhere ----
        If(condition: @state.toast.show) {
          Row {
            Column {
              Text("@{state.toast.initial}").fontSize(15).fontWeight(800).color("#14121A")
            }
              .width(38).height(38).borderRadius(19).flexShrink(0)
              .backgroundColor("@{state.toast.color}")
              .horizontalAlignment("center").verticalAlignment("center")
            Column {
              Text("@{state.toast.title}").fontSize(14).fontWeight(800).color("#14121A")
              Text("@{state.toast.text}").fontSize(13).color("#4A4658").maxLines(1).textOverflow("ellipsis")
            }
              .flex(1).minWidth(0).gap(1)
            Button { Icon(@resources.close).size(16).color("#4A4658") }
              .label("Dismiss")
              .width(32).height(32).borderRadius(16).padding(0).flexShrink(0)
              .horizontalAlignment("center").verticalAlignment("center")
              .backgroundColor({default: "transparent", hover: "#E4DFD3"})
              .onClick(@actions.dismissToast)
          }
            .gap(10).paddingHorizontal(12).paddingVertical(10).margin(10).borderRadius(18)
            .width("100%").maxWidth(440).alignSelf("center").flexShrink(0)
            .backgroundColor("#F5F2EA")
            .boxShadow("0 14px 40px rgba(0, 0, 0, 0.55)")
            .verticalAlignment("center").cursor("pointer")
            .onClick(@actions.openToast)
            .liveRegion("polite")
            .enter(slide, fade, from: top)
            .exit(fade, duration: 150)
        }

        Row {
          // ====================== CONVERSATIONS ======================
          // Lives outside the When so it survives a visit to a thread: its
          // scroll position stays and rows glide when the order changes.
          Column {
            Row {
              Column {
                Heading("Messages", level: 1).fontSize(30).fontWeight(800).color("#F5F2EA").lineHeight(1.1)
                Row {
                  Box {}.width(8).height(8).borderRadius(4).flexShrink(0)
                    .backgroundColor("@{state.onlineCount ? '#C9F24D' : '#4A4658'}")
                  If(condition: @state.onlineCount) {
                    Text("@{state.onlineCount} other@{state.onlineCount == 1 ? '' : 's'} online")
                      .fontSize(13).fontWeight(600).color("#B4AFC2")
                    Else {
                      Text("Just you here for now").fontSize(13).fontWeight(600).color("#B4AFC2")
                    }
                  }
                }
                  .gap(7).verticalAlignment("center")
              }
                .flex(1).minWidth(0).gap(6)
              Button { Icon(@resources.compose).size(20).color("#12140A") }
                .label("New message")
                .width(44).height(44).borderRadius(22).padding(0).flexShrink(0)
                .horizontalAlignment("center").verticalAlignment("center")
                .backgroundColor({default: "#C9F24D", hover: "#D8FA6E"})
                .onClick(@actions.showNewDm)
              Button {
                Text("@{state.me.initial}").fontSize(16).fontWeight(800).color("#14121A")
              }
                .label("Edit profile")
                .width(44).height(44).borderRadius(22).padding(0).flexShrink(0)
                .horizontalAlignment("center").verticalAlignment("center")
                .backgroundColor("@{state.me.color}")
                .onClick(@actions.editProfile)
            }
              .gap(10).paddingHorizontal(20).paddingTop(22).paddingBottom(14).verticalAlignment("center").flexShrink(0)

            Column {
              // Who is around: tap a face to message them.
              If(condition: @state.hasPeople) {
                Column {
                  Text("Around now").fontSize(12).fontWeight(700).color("#8F8AA0").paddingHorizontal(20)
                  Row {
                    ForEach(items: @state.people, key: "id", as: "person") {
                      Column {
                        Stack {
                          Column {
                            Text("@{person.initial}").fontSize(20).fontWeight(800).color("#14121A")
                          }
                            .width(54).height(54).borderRadius(27)
                            .backgroundColor("@{person.color}")
                            .horizontalAlignment("center").verticalAlignment("center")
                            .opacity("@{person.online ? 1 : 0.45}")
                          If(condition: @person.online) {
                            Box {}
                              .width(16).height(16).borderRadius(8)
                              .backgroundColor("#C9F24D").border("3px solid #131218")
                          }
                        }
                          .horizontalAlignment("end").verticalAlignment("end")
                        Text("@{person.name}")
                          .fontSize(12).fontWeight(600).color("#B4AFC2").maxWidth(64)
                          .maxLines(1).textOverflow("ellipsis").textAlign("center")
                      }
                        .gap(7).horizontalAlignment("center").flexShrink(0).cursor("pointer")
                        .onClick(@actions.startDm, id: "@{person.id}")
                    }
                  }
                    .gap(16).paddingHorizontal(20).overflowX("auto").flexShrink(0)
                }
                  .gap(10).paddingBottom(18).flexShrink(0)
              }

              Text("Chats").fontSize(12).fontWeight(700).color("#8F8AA0").paddingHorizontal(20).paddingBottom(6)

              ForEach(items: @state.conversations, key: "id", as: "conv") {
                Row {
                  Stack {
                    Column {
                      Text("@{conv.initial}")
                        .fontSize("@{conv.isRoom ? 22 : 19}").fontWeight(800)
                        .color("@{conv.isRoom ? '#C9F24D' : '#14121A'}")
                    }
                      .width(50).height(50).borderRadius("@{conv.isRoom ? 17 : 25}")
                      .backgroundColor("@{conv.color}")
                      .horizontalAlignment("center").verticalAlignment("center")
                    If(condition: @conv.online) {
                      Box {}
                        .width(16).height(16).borderRadius(8)
                        .backgroundColor("#C9F24D").border("3px solid #131218")
                    }
                  }
                    .horizontalAlignment("end").verticalAlignment("end").flexShrink(0)

                  Column {
                    Row {
                      Text("@{conv.title}")
                        .fontSize(16).fontWeight("@{conv.hasUnread ? 800 : 600}").color("#F5F2EA")
                        .flex(1).minWidth(0).maxLines(1).textOverflow("ellipsis")
                      Text("@{conv.time}")
                        .fontSize(12).fontWeight(600).color("@{conv.hasUnread ? '#C9F24D' : '#8F8AA0'}")
                        .flexShrink(0)
                    }
                      .gap(8).verticalAlignment("center")
                    Row {
                      Text("@{conv.preview}")
                        .fontSize(14).color("@{conv.hasUnread ? '#F5F2EA' : '#A29DB3'}")
                        .flex(1).minWidth(0).maxLines(1).textOverflow("ellipsis")
                      If(condition: @conv.hasUnread) {
                        Text("@{conv.unreadLabel}")
                          .fontSize(12).fontWeight(800).color("#12140A")
                          .backgroundColor("#C9F24D").borderRadius(999)
                          .paddingHorizontal(7).paddingVertical(2).minWidth(22).textAlign("center")
                          .width("auto").alignSelf("center").flexShrink(0)
                          .enter(scale, fade)
                      }
                    }
                      .gap(8).verticalAlignment("center")
                  }
                    .flex(1).minWidth(0).gap(4)
                }
                  .gap(13).paddingHorizontal(12).paddingVertical(10).marginHorizontal(8).borderRadius(18)
                  .verticalAlignment("center")
                  .backgroundColor({default: "@{conv.id == state.room.id ? '#211F2A' : '#131218'}", hover: "#1D1B25"})
                  .cursor("pointer").flexShrink(0)
                  .onClick(@actions.openRoom, id: "@{conv.id}")
                  .layout(spring)
              }

              Button {
                Column { Icon(@resources.plus).size(20).color("#C9F24D") }
                  .width(50).height(50).borderRadius(17).flexShrink(0)
                  .border("1.5px dashed #4A4658")
                  .horizontalAlignment("center").verticalAlignment("center")
                Column {
                  Text("Start a room").fontSize(16).fontWeight(600).color("#F5F2EA")
                  Text("Public, open to everyone here").fontSize(14).color("#A29DB3")
                }
                  .flex(1).minWidth(0).gap(3).horizontalAlignment("start")
              }
                .flexDirection("row").gap(13).paddingHorizontal(12).paddingVertical(10)
                .marginHorizontal(8).marginBottom(16).borderRadius(18)
                .verticalAlignment("center").textAlign("left").flexShrink(0)
                .backgroundColor({default: "#131218", hover: "#1D1B25"})
                .cursor("pointer")
                .onClick(@actions.showNewRoom)

              // first run: nobody else has turned up yet
              If(condition: @state.hasPeople) {
                Else {
                  Column {
                    Text("Quiet in here").fontSize(15).fontWeight(800).color("#F5F2EA")
                    Text("Open this app in a second browser or a private window to watch presence, typing and receipts go live.")
                      .fontSize(14).lineHeight(1.45).color("#A29DB3")
                  }
                    .gap(6).padding(18).marginHorizontal(20).marginBottom(20).borderRadius(20)
                    .backgroundColor("#1B1922").border("1px solid #262331").flexShrink(0)
                }
              }
            }
              .flex(1).minHeight(0).overflowY("auto")
          }
            // display hides the pane where it is supported (DOM); the width
            // does the same job for renderers that have no display: none.
            // No breakpoints here on purpose: embedded in the launcher the
            // app is phone-sized inside a desktop viewport.
            .display("@{state.screen == 'list' ? 'flex' : 'none'}")
            .width("@{state.screen == 'list' ? '100%' : '0px'}")
            .flexShrink(0).minHeight(0).alignSelf("stretch").overflow("hidden")
            .backgroundColor("#131218")

          // ========================= MAIN PANE =========================
          Column {
            When(value: @state.screen) {
              // The DOM renderer keeps styles of props a reused node no longer
              // sets, and a case switch reuses nodes of the same type at the
              // same position. Every case therefore sits in its own pair of
              // plain wrappers (Column/Column, Column/Row, Row/Column, Row/Row),
              // so its content is always built fresh.
              // =========================== SETUP ===========================
              Case(match: "setup") {
                Column {
                  Column {
                    Column {
                      Column {
                        Column {
                          Row {
                            Box {}.width(8).height(8).borderRadius(4).backgroundColor("#C9F24D").flexShrink(0)
                            Text("@{state.editingProfile ? 'Signed in on this device' : 'Live chat, no sign-up'}")
                              .fontSize(13).fontWeight(700).color("#C9F24D")
                          }
                            .gap(8).verticalAlignment("center")
                          Heading("@{state.editingProfile ? 'Your profile' : 'Who is joining the chat?'}", level: 1)
                            .fontSize(34).fontWeight(800).color("#F5F2EA").lineHeight(1.08)
                          Text("Pick a name and a colour. This is how everyone in the room sees you.")
                            .fontSize(15).lineHeight(1.45).color("#B4AFC2")
                        }
                          .gap(12).width("100%")

                        // live preview: your bubble as others will see it
                        Row {
                          Column {
                            Text("@{state.setupInitial ? state.setupInitial : '?'}").fontSize(15).fontWeight(800).color("#14121A")
                          }
                            .width(36).height(36).borderRadius(18).flexShrink(0)
                            .backgroundColor("@{state.setupColor}")
                            .horizontalAlignment("center").verticalAlignment("center")
                            .transition(250, easeOut)
                          Column {
                            Text("@{state.setupName ? state.setupName : 'Your name'}")
                              .fontSize(12).fontWeight(700).color("@{state.setupColor}")
                              .marginLeft(4).maxLines(1).textOverflow("ellipsis")
                              .transition(250, easeOut)
                            Column {
                              Text("Hey! Anyone around?").fontSize(15).lineHeight(1.4).color("#F5F2EA")
                            }
                              .paddingHorizontal(14).paddingVertical(9).cornerRadius(20).borderRadius("20px 20px 20px 6px")
                              .backgroundColor("#262331")
                          }
                            .gap(4).minWidth(0).horizontalAlignment("start")
                        }
                          .gap(8).verticalAlignment("end").width("100%")
                          .padding(16).borderRadius(22).backgroundColor("#1B1922")
                          .border("1px solid #262331")

                        Column {
                          Text("Display name").fontSize(13).fontWeight(700).color("#B4AFC2")
                          Input(placeholder: "e.g. Ada")
                            .bind(@state.setupName)
                            .onInput(@actions.nameInput)
                            .onKey(@actions.saveProfile)
                            .label("Display name")
                            .maxLength(24)
                            .paddingHorizontal(16).paddingVertical(14).fontSize(17).fontWeight(600)
                            .color("#F5F2EA").caretColor("#C9F24D")
                            .borderRadius(16).backgroundColor("#0A090D")
                            .border({default: "1.5px solid #3A3648", focus: "1.5px solid #C9F24D"})
                            .outline("none")
                            .width("100%")
                        }
                          .gap(8).width("100%")

                        Column {
                          Text("Colour").fontSize(13).fontWeight(700).color("#B4AFC2")
                          Row {
                            ForEach(items: @state.colors, key: "color", as: "swatch") {
                              Button {
                                Box {}.width(28).height(28).borderRadius(14).backgroundColor("@{swatch.color}")
                              }
                                .label("Colour @{swatch.color}")
                                .width(40).height(40).borderRadius(20).padding(0).flexShrink(0)
                                .horizontalAlignment("center").verticalAlignment("center")
                                .backgroundColor("#131218")
                                .border("@{swatch.selected ? '2px solid #F5F2EA' : '2px solid #131218'}")
                                .cursor("pointer")
                                .onClick(@actions.pickColor, color: "@{swatch.color}")
                            }
                          }
                            .gap(2).flexWrap("wrap").marginLeft(-6)
                        }
                          .gap(6).width("100%")

                        If(condition: @state.setupError) {
                          Text("@{state.setupError}").fontSize(14).fontWeight(600).color("#FF9C8F")
                            .liveRegion("polite")
                        }

                        Column {
                          Button {
                            Text("@{state.editingProfile ? 'Save changes' : 'Start chatting'}")
                              .fontSize(16).fontWeight(800).color("#12140A")
                          }
                            .width("100%").padding(16).borderRadius(18).horizontalAlignment("center")
                            .backgroundColor({default: "#C9F24D", hover: "#D8FA6E"})
                            .cursor("pointer")
                            .onClick(@actions.saveProfile)

                          If(condition: @state.editingProfile) {
                            Button { Text("Cancel").fontSize(15).fontWeight(600).color("#B4AFC2") }
                              .width("100%").padding(12).borderRadius(18).horizontalAlignment("center")
                              .backgroundColor({default: "transparent", hover: "#1B1922"})
                              .cursor("pointer")
                              .onClick(@actions.cancelProfile)
                          }
                        }
                          .gap(6).width("100%")
                      }
                        .gap(24).paddingHorizontal(24).paddingTop(44).paddingBottom(28)
                        .width("100%").maxWidth(460).alignSelf("center")
                    }
                      .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("auto").backgroundColor("#131218")
                  }
                    .flex(1).minHeight(0).width("100%").flexDirection("column")
                }
                  .flex(1).minHeight(0).width("100%").flexDirection("column")
              }

              // =========================== THREAD ==========================
              Case(match: "thread") {
                Column {
                  Row {
                    Column {
                      // header
                      Row {
                        Button { Icon(@resources.back).size(22).color("#F5F2EA") }
                          .label("Back to conversations")
                          .width(40).height(40).borderRadius(20).padding(0).flexShrink(0)
                          .horizontalAlignment("center").verticalAlignment("center")
                          .backgroundColor({default: "transparent", hover: "#211F2A"})
                          .onClick(@actions.back)
                        Stack {
                          Column {
                            Text("@{state.room.initial}")
                              .fontSize(17).fontWeight(800)
                              .color("@{state.room.isRoom ? '#C9F24D' : '#14121A'}")
                          }
                            .width(40).height(40).borderRadius("@{state.room.isRoom ? 14 : 20}")
                            .backgroundColor("@{state.room.color}")
                            .horizontalAlignment("center").verticalAlignment("center")
                          If(condition: @state.room.online) {
                            Box {}
                              .width(14).height(14).borderRadius(7)
                              .backgroundColor("#C9F24D").border("3px solid #131218")
                          }
                        }
                          .horizontalAlignment("end").verticalAlignment("end").flexShrink(0)
                        Column {
                          Heading("@{state.room.title}", level: 2)
                            .fontSize(17).fontWeight(800).color("#F5F2EA").lineHeight(1.2)
                            .maxLines(1).textOverflow("ellipsis")
                          If(condition: @state.isTyping) {
                            Text("@{state.typingText}").fontSize(13).fontWeight(600).color("#C9F24D")
                              .maxLines(1).textOverflow("ellipsis")
                            Else {
                              Text("@{state.room.subtitle}").fontSize(13).fontWeight(400).color("#A29DB3")
                                .maxLines(1).textOverflow("ellipsis")
                            }
                          }
                        }
                          .flex(1).minWidth(0).gap(1).marginLeft(4)
                      }
                        .gap(6).paddingHorizontal(10).paddingVertical(10).verticalAlignment("center")
                        .backgroundColor("#131218")
                        .borderBottom("1px solid #262331").flexShrink(0)

                      // messages: column-reverse keeps the view pinned to the newest
                      // message and holds position when older pages load above.
                      Column {
                        Column {
                          If(condition: @state.hasMore) {
                            Button { Text("Load earlier messages").fontSize(13).fontWeight(700).color("#C9F24D") }
                              .alignSelf("center").paddingHorizontal(16).paddingVertical(8).marginBottom(6)
                              .borderRadius(999).backgroundColor({default: "#1B1922", hover: "#262331"})
                              .border("1px solid #2E2B39")
                              .cursor("pointer")
                              .onClick(@actions.loadOlder)
                          }
                          If(condition: @state.isEmpty) {
                            Column {
                              Column {
                                Text("@{state.room.initial}")
                                  .fontSize(30).fontWeight(800)
                                  .color("@{state.room.isRoom ? '#C9F24D' : '#14121A'}")
                              }
                                .width(72).height(72).borderRadius("@{state.room.isRoom ? 24 : 36}")
                                .backgroundColor("@{state.room.color}")
                                .horizontalAlignment("center").verticalAlignment("center")
                              Text("This is the very start of @{state.room.title}")
                                .fontSize(17).fontWeight(800).color("#F5F2EA").textAlign("center")
                              Text("Nothing here yet. Say something to get it going.")
                                .fontSize(14).lineHeight(1.45).color("#A29DB3").textAlign("center")
                            }
                              .gap(8).paddingHorizontal(32).paddingVertical(40).horizontalAlignment("center")
                          }

                          ForEach(items: @state.messages, key: "id", as: "m") {
                            If(condition: @m.isDay) {
                              Row {
                                Box {}.flex(1).height(1).backgroundColor("#262331")
                                Text("@{m.dayLabel}").fontSize(12).fontWeight(700).color("#8F8AA0")
                                Box {}.flex(1).height(1).backgroundColor("#262331")
                              }
                                .gap(12).verticalAlignment("center").marginTop(18).marginBottom(6)
                              Else {
                                Column {
                                  If(condition: @m.showName) {
                                    Text("@{m.author}")
                                      .fontSize(12).fontWeight(700).color("@{m.color}")
                                      .marginLeft(44).marginBottom(3)
                                  }
                                  Row {
                                    If(condition: @m.mine) {
                                      Spacer()
                                      Else {
                                        Column {
                                          If(condition: @m.showAvatar) {
                                            Column {
                                              Text("@{m.initial}").fontSize(12).fontWeight(800).color("#14121A")
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
                                            .maxWidth(240).maxHeight(320).borderRadius(16)
                                            .objectFit("cover").display("block")
                                        }
                                        If(condition: @m.hasText) {
                                          Text("@{m.text}")
                                            .fontSize(15).lineHeight(1.4)
                                            .fontWeight("@{m.mine ? 500 : 400}")
                                            .color("@{m.mine ? '#12140A' : '#F5F2EA'}")
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
                                                  .fontSize(11).fontWeight(700).color("#C9F24D")
                                                Text("@{m.previewTitle}")
                                                  .fontSize(14).fontWeight(700).color("#F5F2EA")
                                                  .maxLines(2).textOverflow("ellipsis")
                                                Text("@{m.previewDesc}")
                                                  .fontSize(12).lineHeight(1.35).color("#B4AFC2")
                                                  .maxLines(2).textOverflow("ellipsis")
                                              }
                                                .paddingHorizontal(12).paddingVertical(10).gap(3)
                                            }
                                              .backgroundColor("#0F0E14").borderRadius(14).overflow("hidden")
                                          }
                                            .label("Open link preview")
                                            .marginTop(8).marginBottom(3).display("block").textDecoration("none")
                                        }
                                      }
                                        .paddingHorizontal("@{m.hasText ? 12 : 2}").paddingVertical("@{m.hasText ? 7 : 2}")
                                        .cornerRadius(20).borderRadius("@{m.radius}")
                                        .backgroundColor("@{m.mine ? '#C9F24D' : '#262331'}")
                                        .border("@{m.selected ? '2px solid #F5F2EA' : '2px solid transparent'}")
                                        .cursor("pointer")
                                        .onClick(@actions.selectMessage, id: "@{m.id}")

                                      If(condition: @m.hasReactions) {
                                        Row {
                                          ForEach(items: @m.reactions, key: "key", as: "rx") {
                                            Button {
                                              Text("@{rx.label}").fontSize(12).fontWeight(700)
                                                .color("@{rx.mine ? '#C9F24D' : '#F5F2EA'}")
                                            }
                                              .paddingHorizontal(8).paddingVertical(3).borderRadius(999)
                                              .backgroundColor("@{rx.mine ? '#2A3012' : '#1B1922'}")
                                              .border("@{rx.mine ? '1.5px solid #C9F24D' : '1.5px solid #3A3648'}")
                                              .cursor("pointer")
                                              .onClick(@actions.reactTo, id: "@{m.id}", emoji: "@{rx.emoji}")
                                              .enter(scale, fade)
                                          }
                                        }
                                          .gap(4).marginTop(-7).paddingHorizontal(8).flexWrap("wrap")
                                          .horizontalAlignment("@{m.mine ? 'end' : 'start'}")
                                      }
                                    }
                                      .maxWidth("78%").minWidth(0)
                                      .horizontalAlignment("@{m.mine ? 'end' : 'start'}")
                                  }
                                    .gap(8).verticalAlignment("end").width("100%")

                                  If(condition: @m.showTime) {
                                    Row {
                                      Text("@{m.time}").fontSize(11).fontWeight(600).color("#8F8AA0")
                                      If(condition: @m.showStatus) {
                                        Text("· @{m.status}").fontSize(11).fontWeight(700).color("#B4AFC2")
                                      }
                                    }
                                      .gap(4).marginTop(4)
                                      .marginLeft("@{m.mine ? 0 : 42}").marginRight("@{m.mine ? 4 : 0}")
                                      .horizontalAlignment("@{m.mine ? 'end' : 'start'}")
                                  }
                                }
                                  .marginTop("@{m.gapTop}")
                                  .enter(slide, fade, from: bottom, duration: 180)
                              }
                            }
                          }

                          // someone is typing: three dots in a ghost bubble
                          If(condition: @state.isTyping) {
                            Row {
                              Box {}.width(7).height(7).borderRadius(4).backgroundColor("#C9F24D")
                                .animate(pulse, duration: 900)
                              Box {}.width(7).height(7).borderRadius(4).backgroundColor("#C9F24D")
                                .animate(pulse, duration: 900, delay: 150)
                              Box {}.width(7).height(7).borderRadius(4).backgroundColor("#C9F24D")
                                .animate(pulse, duration: 900, delay: 300)
                            }
                              .gap(5).paddingHorizontal(14).paddingVertical(13).marginTop(10).marginLeft(38)
                              .cornerRadius(20).borderRadius("20px 20px 20px 6px").backgroundColor("#262331")
                              .alignSelf("start").verticalAlignment("center")
                              .enter(scale, fade, duration: 160)
                              .exit(fade, duration: 120)
                          }
                        }
                          .paddingHorizontal(14).paddingVertical(12)
                      }
                        .flex(1).minHeight(0).overflowY("auto")
                        .flexDirection("column-reverse")
                        .backgroundColor("#0F0E14")
                        .onScroll(@actions.scrolled)

                      // reaction picker for the selected bubble
                      If(condition: @state.pickerOpen) {
                        Row {
                          Row {
                            ForEach(items: @state.reactionChoices, key: "emoji", as: "choice") {
                              Button { Text("@{choice.emoji}").fontSize(24).lineHeight(1.2) }
                                .label("React @{choice.emoji}")
                                .width(44).height(44).padding(0).borderRadius(22)
                                .horizontalAlignment("center").verticalAlignment("center")
                                .backgroundColor({default: "transparent", hover: "#3A3648"})
                                .cursor("pointer")
                                .onClick(@actions.react, emoji: "@{choice.emoji}")
                            }
                            Box {}.width(1).height(22).backgroundColor("#3A3648").marginHorizontal(4)
                            Button { Icon(@resources.close).size(18).color("#B4AFC2") }
                              .label("Close reactions")
                              .width(40).height(40).padding(0).borderRadius(20)
                              .horizontalAlignment("center").verticalAlignment("center")
                              .backgroundColor({default: "transparent", hover: "#3A3648"})
                              .cursor("pointer")
                              .onClick(@actions.closePicker)
                          }
                            .padding(4).verticalAlignment("center")
                            .borderRadius(999).backgroundColor("#262331")
                            .border("1px solid #3A3648")
                            .boxShadow("0 10px 30px rgba(0, 0, 0, 0.5)")
                        }
                          .horizontalAlignment("center").paddingHorizontal(8).paddingVertical(8)
                          .backgroundColor("#0F0E14").flexShrink(0)
                          .enter(slide, fade, from: bottom, duration: 160)
                      }

                      If(condition: @state.hasNotice) {
                        Row {
                          Text("@{state.notice}").fontSize(13).fontWeight(600).color("#FFB1A6").flex(1).minWidth(0)
                          Button { Text("OK").fontSize(13).fontWeight(800).color("#FFB1A6") }
                            .backgroundColor({default: "transparent", hover: "#4A211C"})
                            .paddingHorizontal(10).paddingVertical(6).borderRadius(999)
                            .cursor("pointer")
                            .onClick(@actions.dismissNotice)
                        }
                          .gap(8).paddingHorizontal(16).paddingVertical(8).backgroundColor("#34170F")
                          .verticalAlignment("center").liveRegion("polite").flexShrink(0)
                      }

                      // composer
                      Row {
                        Row {
                          If(condition: @state.canAttach) {
                            Button {
                              If(condition: @state.uploading) {
                                Spinner {}.width(18).height(18).color("#C9F24D")
                                Else { Icon(@resources.photo).size(21).color("#B4AFC2") }
                              }
                            }
                              .label("Send a photo")
                              .width(46).height(46).borderRadius(23).padding(0).flexShrink(0)
                              .horizontalAlignment("center").verticalAlignment("center")
                              .backgroundColor({default: "#1B1922", hover: "#262331"})
                              .cursor("pointer")
                              .onClick(@actions.attachImage)
                          }
                          Input(placeholder: "Message @{state.room.title}")
                            .bind(@state.draft)
                            .onInput(@actions.typing)
                            .onKey(@actions.send)
                            .label("Message")
                            .maxLength(1000)
                            .flex(1).minWidth(0)
                            .paddingHorizontal(18).paddingVertical(12).fontSize(15)
                            .color("#F5F2EA").caretColor("#C9F24D")
                            .borderRadius(23).backgroundColor("#0A090D")
                            .border({default: "1.5px solid #3A3648", focus: "1.5px solid #C9F24D"})
                            .outline("none")
                          Button { Icon(@resources.send).size(22).color("@{state.draft ? '#12140A' : '#8F8AA0'}") }
                            .label("Send")
                            .width(46).height(46).borderRadius(23).padding(0).flexShrink(0)
                            .horizontalAlignment("center").verticalAlignment("center")
                            .backgroundColor("@{state.draft ? '#C9F24D' : '#211F2A'}")
                            .transition(160, easeOut)
                            .cursor("pointer")
                            .onClick(@actions.send)
                        }
                          .gap(8).verticalAlignment("center").width("100%")
                      }
                        .horizontalAlignment("center").paddingHorizontal(12).paddingVertical(10)
                        .backgroundColor("#131218").borderTop("1px solid #262331").flexShrink(0)
                    }
                      .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("hidden").backgroundColor("#131218")
                  }
                    .flex(1).minHeight(0).width("100%").flexDirection("column")
                }
                  .flex(1).minHeight(0).width("100%").flexDirection("column")
              }

              // ========================== NEW ROOM =========================
              Case(match: "newRoom") {
                Row {
                  Column {
                    Column {
                      Row {
                        Button { Icon(@resources.back).size(22).color("#F5F2EA") }
                          .label("Back")
                          .width(40).height(40).borderRadius(20).padding(0).flexShrink(0)
                          .horizontalAlignment("center").verticalAlignment("center")
                          .backgroundColor({default: "transparent", hover: "#211F2A"})
                          .onClick(@actions.back)
                        Text("New room").fontSize(15).fontWeight(700).color("#B4AFC2")
                      }
                        .gap(6).paddingHorizontal(10).paddingVertical(10).verticalAlignment("center").flexShrink(0)
                      Column {
                        Column {
                          Heading("Name your room", level: 2)
                            .fontSize(30).fontWeight(800).color("#F5F2EA").lineHeight(1.1)
                          Text("Rooms are public. Everyone who has the app open can read and post.")
                            .fontSize(15).lineHeight(1.45).color("#B4AFC2")
                        }
                          .gap(10)
                        Column {
                          Row {
                            Text("#").fontSize(22).fontWeight(800).color("#C9F24D")
                            Input(placeholder: "room-name")
                              .bind(@state.newRoomName)
                              .onKey(@actions.createRoom)
                              .label("Room name")
                              .maxLength(24)
                              .flex(1).minWidth(0).fontSize(18).fontWeight(600)
                              .color("#F5F2EA").caretColor("#C9F24D")
                              .paddingHorizontal(4).paddingVertical(15)
                              .border("0px solid #0A090D").backgroundColor("#0A090D").outline("none")
                          }
                            .gap(6).paddingHorizontal(16).verticalAlignment("center")
                            .borderRadius(16).backgroundColor("#0A090D")
                            .border("1.5px solid #3A3648")
                          Text("2 to 24 letters, digits or dashes").fontSize(13).color("#8F8AA0").marginLeft(4)
                        }
                          .gap(8)
                        If(condition: @state.newRoomError) {
                          Text("@{state.newRoomError}").fontSize(14).fontWeight(600).color("#FF9C8F")
                            .liveRegion("polite")
                        }
                        Button { Text("Create room").fontSize(16).fontWeight(800).color("#12140A") }
                          .width("100%").padding(16).borderRadius(18).horizontalAlignment("center")
                          .backgroundColor({default: "#C9F24D", hover: "#D8FA6E"})
                          .cursor("pointer")
                          .onClick(@actions.createRoom)
                      }
                        .gap(22).paddingHorizontal(24).paddingTop(16).paddingBottom(28)
                        .width("100%").maxWidth(460).alignSelf("center")
                    }
                      .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("auto").backgroundColor("#131218")
                  }
                    .flex(1).minHeight(0).width("100%").flexDirection("column")
                }
                  .flex(1).minHeight(0).width("100%").flexDirection("column")
              }

              // ========================= NEW MESSAGE =======================
              Case(match: "newDm") {
                Row {
                  Row {
                    Column {
                      Row {
                        Button { Icon(@resources.back).size(22).color("#F5F2EA") }
                          .label("Back")
                          .width(40).height(40).borderRadius(20).padding(0).flexShrink(0)
                          .horizontalAlignment("center").verticalAlignment("center")
                          .backgroundColor({default: "transparent", hover: "#211F2A"})
                          .onClick(@actions.back)
                        Text("New message").fontSize(15).fontWeight(700).color("#B4AFC2")
                      }
                        .gap(6).paddingHorizontal(10).paddingVertical(10).verticalAlignment("center").flexShrink(0)
                      Column {
                        Heading("Who to?", level: 2)
                          .fontSize(30).fontWeight(800).color("#F5F2EA").lineHeight(1.1)
                          .paddingHorizontal(12).paddingBottom(12)
                        If(condition: @state.hasPeople) {
                          Column {
                            ForEach(items: @state.people, key: "id", as: "who") {
                              Row {
                                Stack {
                                  Column {
                                    Text("@{who.initial}").fontSize(18).fontWeight(800).color("#14121A")
                                  }
                                    .width(48).height(48).borderRadius(24)
                                    .backgroundColor("@{who.color}")
                                    .horizontalAlignment("center").verticalAlignment("center")
                                    .opacity("@{who.online ? 1 : 0.45}")
                                  If(condition: @who.online) {
                                    Box {}
                                      .width(15).height(15).borderRadius(8)
                                      .backgroundColor("#C9F24D").border("3px solid #131218")
                                  }
                                }
                                  .horizontalAlignment("end").verticalAlignment("end").flexShrink(0)
                                Column {
                                  Text("@{who.name}").fontSize(16).fontWeight(700).color("#F5F2EA")
                                    .maxLines(1).textOverflow("ellipsis")
                                  Text("@{who.status}").fontSize(13).fontWeight(600)
                                    .color("@{who.online ? '#C9F24D' : '#A29DB3'}")
                                }
                                  .flex(1).minWidth(0).gap(2)
                              }
                                .gap(13).paddingHorizontal(12).paddingVertical(10).borderRadius(18)
                                .verticalAlignment("center").flexShrink(0)
                                .backgroundColor({default: "#131218", hover: "#1D1B25"})
                                .cursor("pointer")
                                .onClick(@actions.startDm, id: "@{who.id}")
                            }
                          }
                          Else {
                            // a Row, so it never reuses the list Column above
                            Row {
                            Column {
                              Column { Icon(@resources.chat).size(30).color("#C9F24D") }
                                .width(68).height(68).borderRadius(24).backgroundColor("#1B1922")
                                .border("1px solid #262331")
                                .horizontalAlignment("center").verticalAlignment("center")
                              Text("Nobody else is here yet").fontSize(17).fontWeight(800).color("#F5F2EA")
                              Text("Open this app in another browser, or say hi in #general and wait for company.")
                                .fontSize(14).lineHeight(1.45).color("#A29DB3").maxWidth(300)
                            }
                              .gap(10).paddingHorizontal(12).paddingVertical(20)
                            }
                          }
                        }
                      }
                        .paddingHorizontal(8).paddingTop(16).paddingBottom(20)
                        .width("100%").maxWidth(520).alignSelf("center")
                    }
                      .flex(1).minHeight(0).width("100%").maxWidth("100%").overflowY("auto").backgroundColor("#131218")
                  }
                    .flex(1).minHeight(0).width("100%").flexDirection("column")
                }
                  .flex(1).minHeight(0).width("100%").flexDirection("column")
              }
            }
          }
            .display("@{state.screen == 'list' ? 'none' : 'flex'}")
            .flex(1).minWidth(0).minHeight(0).alignSelf("stretch").overflow("hidden")
            .backgroundColor("#131218")
        }
          // a centred column on wide windows, edge to edge on a phone
          .flex(1).minHeight(0).width("100%").maxWidth(720)
          .backgroundColor("#131218")
          .overflow("hidden")
          .borderLeft("1px solid #211F2A").borderRight("1px solid #211F2A")
      }
        .flex(1).minHeight(0).height("100%").width("100%")
        .horizontalAlignment("center")
        .backgroundColor("#09080C")
        .fontFamily("-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif")
        .overflow("hidden")
    }
  `);

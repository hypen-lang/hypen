import { app } from "@hypen-space/core";
import { durableObjectStore, withKey } from "@hypen-space/cf";
import { connectionGeo } from "./geo";
import { ICONS } from "./icons";
import { getAirQuality, getForecast, searchCities, type CityResult, type Forecast } from "./openmeteo";
import { present, themeFor, type Unit, type WeatherView } from "./present";

// Weather — Open-Meteo forecast for where you are, plus saved cities.
//
//   - Default location: the viewer's edge geo (`request.cf`, see geo.ts).
//   - City search: Open-Meteo geocoding, autocompleting on every keystroke
//     (`.bind` + `.onInput`); stale responses are dropped.
//   - Saved cities and the °C/°F choice persist in the Durable Object; the
//     forecast itself is a cache, not state worth persisting (see prefsStore).
//   - A 60 s ticker per session re-derives the view (clock, "Now" hour,
//     "updated N min ago") from the shared cache and pulls a fresh forecast
//     once the 10-minute TTL lapses, so open clients update live.
//   - The background and surfaces follow the current condition, day/night.

export interface Place {
  id: string;
  name: string;
  subtitle: string;
  latitude: number;
  longitude: number;
  isHere: boolean;
}

export interface Chip {
  id: string;
  name: string;
  isHere: boolean;
  bg: string;
  fg: string;
}

export interface SearchRow {
  id: string;
  name: string;
  detail: string;
  latitude: number;
  longitude: number;
}

export type WeatherState = WeatherView & {
  unit: Unit;
  saved: Place[];
  here: Place;
  place: Place;
  isSaved: boolean;
  canSave: boolean;
  chips: Chip[];
  query: string;
  results: SearchRow[];
  searchState: "idle" | "searching" | "results" | "empty" | "error";
  showResults: boolean;
  status: "loading" | "ready" | "error";
  errorText: string;
  locateIcon: string;
};

const HERE_ID = "here";

function placeFromGeo(): Place {
  const geo = connectionGeo();
  return {
    id: HERE_ID,
    name: geo.city,
    subtitle: geo.fromEdge
      ? ["My location", geo.region, geo.country].filter(Boolean).join(" · ")
      : `My location · ${geo.region} (default)`,
    latitude: geo.latitude,
    longitude: geo.longitude,
    isHere: true,
  };
}

const EMPTY_VIEW: WeatherView = {
  now: { temp: "—", icon: ICONS.cloud, label: "", hiLo: "", feels: "", localTime: "", dateLabel: "", isDay: true },
  theme: themeFor(2, true),
  hourly: [],
  chart: { points: [[0.5, 0], [1.5, 0]], domain: [0, 1], nowPoint: [] },
  summary: "",
  daily: [],
  details: [],
  footer: "Weather data by Open-Meteo.com",
};

export function initialWeatherState(): WeatherState {
  const here: Place = { ...placeFromGeo(), name: "Locating…" };
  return {
    ...EMPTY_VIEW,
    unit: "C",
    saved: [],
    here,
    place: here,
    isSaved: false,
    canSave: false,
    chips: [],
    query: "",
    results: [],
    searchState: "idle",
    showResults: false,
    status: "loading",
    errorText: "",
    locateIcon: ICONS.locate,
  };
}

// ---------------------------------------------------------------------------
// Persistence: only the choices (saved cities + unit), one key per DO.
// ---------------------------------------------------------------------------

interface Prefs {
  unit: Unit;
  saved: Place[];
}

const baseStore = durableObjectStore<WeatherState>(withKey<WeatherState>(() => "weather-prefs"));
const lastSaved = new WeakMap<object, string>();

const prefsStore: typeof baseStore = {
  __bindStorage: (storage) => baseStore.__bindStorage(storage),
  resolveKey: (state, moduleName, sessionId) => baseStore.resolveKey(state, moduleName, sessionId),
  async load(key) {
    const stored = (await baseStore.load(key).catch(() => null)) as Partial<Prefs> | null;
    if (!stored) return null;
    const saved = Array.isArray(stored.saved)
      ? stored.saved.filter((p) => p && typeof p.latitude === "number" && typeof p.longitude === "number")
      : [];
    return { unit: stored.unit === "F" ? "F" : "C", saved } as unknown as WeatherState;
  },
  async save(key, state) {
    const prefs: Prefs = { unit: state.unit, saved: state.saved };
    const json = JSON.stringify(prefs);
    // Every state flush calls save (clock ticks included); only write on change.
    if (lastSaved.get(baseStore) === `${key}:${json}`) return;
    lastSaved.set(baseStore, `${key}:${json}`);
    await baseStore.save(key, prefs as unknown as WeatherState);
  },
  delete: (key) => baseStore.delete(key),
};

// ---------------------------------------------------------------------------
// Loading & presenting
// ---------------------------------------------------------------------------

interface Loaded {
  placeId: string;
  forecast: Forecast;
  aqi: number | null;
}

const loaded = new WeakMap<object, Loaded>();
const tickers = new WeakMap<object, ReturnType<typeof setInterval>>();
const searchSeq = new WeakMap<object, number>();

function chipsFor(state: WeatherState): Chip[] {
  const theme = state.theme;
  return [state.here, ...state.saved].map((p) => {
    const active = p.id === state.place.id;
    return {
      id: p.id,
      name: p.name,
      isHere: p.isHere,
      bg: active ? theme.chipActive : theme.chip,
      fg: active ? theme.chipActiveText : theme.text,
    };
  });
}

function refreshChrome(state: WeatherState): void {
  state.isSaved = state.saved.some((p) => p.id === state.place.id);
  state.canSave = !state.place.isHere;
  state.locateIcon = state.place.isHere ? ICONS.locateOn : ICONS.locate;
  state.chips = chipsFor(state);
}

function applyView(state: WeatherState, data: Loaded): void {
  const view = present(data.forecast, state.unit, data.aqi);
  state.now = view.now;
  state.theme = view.theme;
  state.hourly = view.hourly;
  state.chart = view.chart;
  state.summary = view.summary;
  state.daily = view.daily;
  state.details = view.details;
  state.footer = view.footer;
  state.status = "ready";
  refreshChrome(state);
}

/**
 * Fetch (or reuse from cache) the forecast for `state.place` and re-render.
 * `quiet` keeps the current screen up while refreshing.
 */
async function load(state: WeatherState, { quiet = false } = {}): Promise<void> {
  const place = { ...state.place };
  const current = loaded.get(state);
  if (!quiet && current?.placeId !== place.id) {
    state.status = "loading";
    refreshChrome(state);
  }
  try {
    const [forecast, aqi] = await Promise.all([
      getForecast(place.latitude, place.longitude),
      getAirQuality(place.latitude, place.longitude),
    ]);
    if (state.place.id !== place.id) return; // the user moved on
    const data = { placeId: place.id, forecast, aqi };
    loaded.set(state, data);
    applyView(state, data);
  } catch (error) {
    if (state.place.id !== place.id) return;
    console.warn(`[weather] forecast for ${place.name} failed:`, error);
    if (current?.placeId === place.id) return; // keep showing what we have
    state.status = "error";
    state.errorText =
      error instanceof Error && /limit|429/i.test(error.message)
        ? "Open-Meteo is rate-limiting this server. Try again in a minute."
        : "Couldn't reach Open-Meteo. Check the connection and try again.";
  }
}

function selectPlace(state: WeatherState, place: Place): void {
  state.place = place;
  state.query = "";
  state.results = [];
  state.searchState = "idle";
  state.showResults = false;
  refreshChrome(state);
  void load(state);
}

function placeFromResult(r: SearchRow): Place {
  return { id: r.id, name: r.name, subtitle: r.detail, latitude: r.latitude, longitude: r.longitude, isHere: false };
}

function searchRow(r: CityResult): SearchRow {
  return {
    id: `geo-${r.id}`,
    name: r.name,
    detail: [r.region, r.country].filter((s) => s && s !== r.name).join(", "),
    latitude: r.latitude,
    longitude: r.longitude,
  };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export default app
  .defineState<WeatherState>(initialWeatherState())
  .persist(prefsStore)
  .onCreated((state) => {
    // Geo was parked by the DO before any handler runs (worker.ts).
    state.here = placeFromGeo();
    state.place = state.here;
    refreshChrome(state);
    // Never hold the first paint behind a third-party request.
    void load(state);
    tickers.set(
      state as object,
      setInterval(() => {
        const data = loaded.get(state);
        if (data?.placeId === state.place.id) applyView(state, data); // clock, "Now", age
        void load(state, { quiet: true }); // cache hit until the TTL lapses
      }, 60_000),
    );
  })
  .onDestroyed((state) => {
    const timer = tickers.get(state as object);
    if (timer !== undefined) clearInterval(timer);
    tickers.delete(state as object);
  })
  .onAction("search", async ({ state }) => {
    const q = state.query.trim();
    const seq = (searchSeq.get(state as object) ?? 0) + 1;
    searchSeq.set(state as object, seq);
    if (q.length < 2) {
      state.results = [];
      state.searchState = "idle";
      state.showResults = false;
      return;
    }
    state.showResults = true;
    if (state.results.length === 0) state.searchState = "searching";
    try {
      const rows = (await searchCities(q)).map(searchRow);
      if (searchSeq.get(state as object) !== seq) return; // a newer keystroke won
      state.results = rows;
      state.searchState = rows.length ? "results" : "empty";
    } catch {
      if (searchSeq.get(state as object) !== seq) return;
      state.results = [];
      state.searchState = "error";
    }
  })
  .onAction("pickFirst", async ({ state }) => {
    const first = state.results[0];
    if (first) selectPlace(state, placeFromResult(first));
  })
  .onAction("clearSearch", async ({ state }) => {
    searchSeq.set(state as object, (searchSeq.get(state as object) ?? 0) + 1);
    state.query = "";
    state.results = [];
    state.searchState = "idle";
    state.showResults = false;
  })
  .onAction<{ id: string }>("selectCity", async ({ action, state }) => {
    const row = state.results.find((r) => r.id === action.payload?.id);
    if (row) selectPlace(state, placeFromResult(row));
  })
  .onAction<{ id: string }>("selectChip", async ({ action, state }) => {
    const id = action.payload?.id;
    const place = id === HERE_ID ? state.here : state.saved.find((p) => p.id === id);
    if (place && place.id !== state.place.id) selectPlace(state, { ...place });
  })
  .onAction("goHere", async ({ state }) => {
    if (!state.place.isHere) selectPlace(state, { ...state.here });
  })
  .onAction("toggleSave", async ({ state }) => {
    const place = state.place;
    if (place.isHere) return;
    if (state.saved.some((p) => p.id === place.id)) {
      state.saved = state.saved.filter((p) => p.id !== place.id);
    } else {
      state.saved = [...state.saved, { ...place }].slice(-12);
    }
    refreshChrome(state);
  })
  .onAction<{ unit: Unit }>("setUnit", async ({ action, state }) => {
    const unit = action.payload?.unit === "F" ? "F" : "C";
    if (unit === state.unit) return;
    state.unit = unit;
    const data = loaded.get(state as object);
    if (data?.placeId === state.place.id) applyView(state, data);
  })
  .onAction("retry", async ({ state }) => {
    await load(state);
  })
  .ui(`
    module App {
      Column {
        Column {
          // ---------- search + controls ----------
          Row {
            Input(placeholder: "Search for a city")
              .bind(@state.query)
              .onInput(@actions.search)
              .onKey(@actions.pickFirst)
              .label("Search for a city")
              .flex(1)
              .minWidth(0)
              .paddingHorizontal(14)
              .paddingVertical(10)
              .borderRadius(12)
              .borderWidth(1)
              .borderStyle("solid")
              .borderColor("@{state.theme.cardBorder}")
              .backgroundColor("@{state.theme.input}")
              .color("#FFFFFF")
              .fontSize(15)

            Button {
              Image(src: "@{state.locateIcon}", alt: "Location arrow").width(18).height(18).hidden()
            }
              .label("Show weather for my location")
              .onClick(@actions.goHere)
              .padding(10)
              .borderRadius(12)
              .borderWidth(1)
              .borderStyle("solid")
              .borderColor("@{state.theme.cardBorder}")
              .backgroundColor("@{state.theme.input}")
              .cursor("pointer")

            Row {
              Button {
                Text("°C").fontSize(14).fontWeight(600).color("@{state.unit == 'C' ? state.theme.chipActiveText : '#FFFFFF'}")
              }
                .label("Celsius")
                .onClick(@actions.setUnit, unit: "C")
                .paddingHorizontal(10)
                .paddingVertical(7)
                .borderRadius(9)
                .borderWidth(0)
                .backgroundColor("@{state.unit == 'C' ? '#FFFFFF' : 'transparent'}")
                .cursor("pointer")
                .transition(160, easeOut)
              Button {
                Text("°F").fontSize(14).fontWeight(600).color("@{state.unit == 'F' ? state.theme.chipActiveText : '#FFFFFF'}")
              }
                .label("Fahrenheit")
                .onClick(@actions.setUnit, unit: "F")
                .paddingHorizontal(10)
                .paddingVertical(7)
                .borderRadius(9)
                .borderWidth(0)
                .backgroundColor("@{state.unit == 'F' ? '#FFFFFF' : 'transparent'}")
                .cursor("pointer")
                .transition(160, easeOut)
            }
              .padding(3)
              .gap(2)
              .borderRadius(12)
              .backgroundColor("@{state.theme.input}")
              .flexShrink(0)
          }
            .gap(8)
            .verticalAlignment("center")
            .width("100%")

          // ---------- autocomplete ----------
          If(condition: @state.showResults) {
            Column {
              If(condition: "@{state.searchState == 'searching'}") {
                Text("Searching…").fontSize(14).color("#64748B").padding(12)
              }
              If(condition: "@{state.searchState == 'empty'}") {
                Text("No places match that name").fontSize(14).color("#64748B").padding(12)
              }
              If(condition: "@{state.searchState == 'error'}") {
                Text("City search is unavailable right now").fontSize(14).color("#B91C1C").padding(12)
              }
              ForEach(items: @state.results, key: "id") {
                Button {
                  Column {
                    Text("@{item.name}").fontSize(15).fontWeight(600).color("#0F172A")
                    Text("@{item.detail}").fontSize(12).color("#64748B")
                  }
                    .gap(1)
                    .horizontalAlignment("start")
                }
                  .onClick(@actions.selectCity, id: "@{item.id}")
                  .width("100%")
                  .textAlign("left")
                  .paddingHorizontal(12)
                  .paddingVertical(9)
                  .borderRadius(10)
                  .borderWidth(0)
                  .backgroundColor({default: "transparent", hover: "#F1F5F9"})
                  .cursor("pointer")
              }
            }
              .padding(6)
              .borderRadius(16)
              .backgroundColor("#FFFFFF")
              .boxShadow("0 12px 32px rgba(15, 23, 42, 0.28)")
              .enter(fade, slide, from: top, duration: 160)
              .exit(fade, duration: 120)
          }

          // ---------- my location + saved cities ----------
          Row {
            ForEach(items: @state.chips, key: "id") {
              Button {
                Row {
                  Text("➤").fontSize(11).color("@{item.fg}").display("@{item.isHere ? 'block' : 'none'}").hidden()
                  Text("@{item.name}").fontSize(13).fontWeight(600).color("@{item.fg}").whiteSpace("nowrap")
                }
                  .gap(6)
                  .verticalAlignment("center")
              }
                .onClick(@actions.selectChip, id: "@{item.id}")
                .paddingHorizontal(14)
                .paddingVertical(8)
                .borderRadius(999)
                .borderWidth(0)
                .backgroundColor("@{item.bg}")
                .flexShrink(0)
                .cursor("pointer")
                .transition(200, easeOut)
                .enter(fade, scale, duration: 180)
                .layout(spring)
            }
          }
            .gap(8)
            .overflowX("auto")
            .width("100%")
            .paddingBottom(2)

          When(value: @state.status) {
            Case(match: "loading") {
              Column {
                Spinner()
                Text("Loading the forecast for @{state.place.name}…").fontSize(14).color("@{state.theme.sub}")
              }
                .gap(14)
                .horizontalAlignment("center")
                .paddingVertical(120)
                .width("100%")
            }
            Case(match: "error") {
              Column {
                Text("@{state.errorText}").fontSize(15).color("#FFFFFF").textAlign("center")
                Button { Text("Try again").fontSize(14).fontWeight(600).color("#0F172A") }
                  .onClick(@actions.retry)
                  .paddingHorizontal(18)
                  .paddingVertical(10)
                  .borderRadius(999)
                  .borderWidth(0)
                  .backgroundColor("#FFFFFF")
                  .cursor("pointer")
              }
                .gap(16)
                .horizontalAlignment("center")
                .paddingVertical(100)
                .paddingHorizontal(24)
                .width("100%")
            }
            Else {
              Column {
                // ---------- hero ----------
                Column {
                  Row {
                    Text("@{state.place.name}")
                      .fontSize(30)
                      .fontWeight(600)
                      .color("#FFFFFF")
                    // Two buttons rather than one with a bound .label(): the
                    // accessible name does not follow a binding (see README).
                    If(condition: "@{state.canSave && state.isSaved}") {
                      Button { Text("★").fontSize(22).color("#FFD43B") }
                        .label("Remove from saved cities")
                        .onClick(@actions.toggleSave, animate: spring)
                        .backgroundColor("transparent")
                        .borderWidth(0)
                        .padding(2)
                        .cursor("pointer")
                    }
                    If(condition: "@{state.canSave && !state.isSaved}") {
                      Button { Text("☆").fontSize(22).color("#FFFFFF") }
                        .label("Save this city")
                        .onClick(@actions.toggleSave, animate: spring)
                        .backgroundColor("transparent")
                        .borderWidth(0)
                        .padding(2)
                        .cursor("pointer")
                    }
                  }
                    .gap(6)
                    .verticalAlignment("center")
                    .horizontalAlignment("center")
                  Text("@{state.place.subtitle}").fontSize(13).color("@{state.theme.sub}").textAlign("center")
                  Row {
                    Image(src: "@{state.now.icon}", alt: "@{state.now.label}").width(78).height(78)
                    Text("@{state.now.temp}")
                      .fontSize(88)
                      .fontWeight(200)
                      .lineHeight(1)
                      .color("#FFFFFF")
                      .transition(250, easeOut)
                  }
                    .gap(6)
                    .verticalAlignment("center")
                    .marginTop(6)
                  Text("@{state.now.label}").fontSize(20).fontWeight(500).color("#FFFFFF")
                  Text("@{state.now.hiLo}   @{state.now.feels}").fontSize(15).color("@{state.theme.sub}").whiteSpace("pre")
                  Text("@{state.now.dateLabel} · @{state.now.localTime} local time")
                    .fontSize(12)
                    .color("@{state.theme.sub}")
                    .marginTop(4)
                }
                  .gap(3)
                  .horizontalAlignment("center")
                  .paddingTop(10)
                  .paddingBottom(8)
                  .width("100%")

                // ---------- next 24 hours ----------
                Column {
                  Text("@{state.summary}").fontSize(13).color("#FFFFFF").lineHeight(1.4)
                  Box {}.height(1).width("100%").backgroundColor("@{state.theme.cardBorder}")
                  Column {
                    Column {
                      Chart(x: [0, 24], y: @state.chart.domain) {
                        Area(points: @state.chart.points, smooth: true).fill("#FFFFFF").fillOpacity(0.10)
                        Line(points: @state.chart.points, smooth: true).stroke("@{state.theme.accent}").strokeWidth(2.5)
                        Points(points: @state.chart.nowPoint, radius: 4).fill("#FFFFFF")
                      }
                        .height(46)
                        .width("100%")
                      Row {
                        ForEach(items: @state.hourly, key: "id") {
                          Column {
                            Text("@{item.time}")
                              .fontSize(12)
                              .fontWeight("@{item.isNow ? 700 : 500}")
                              .color("#FFFFFF")
                              .whiteSpace("nowrap")
                            Image(src: "@{item.icon}", alt: "@{item.condition}").width(30).height(30)
                            Text("@{item.temp}").fontSize(16).fontWeight(600).color("#FFFFFF")
                            Text("@{item.pop}").fontSize(11).fontWeight(600).color("#9BDCFF").height(14).opacity("@{item.popOpacity}")
                          }
                            .width(56)
                            .flexShrink(0)
                            .gap(5)
                            .horizontalAlignment("center")
                        }
                      }
                    }
                      .width(1344)
                      .gap(4)
                  }
                    .overflowX("auto")
                    .width("100%")
                    .paddingBottom(4)
                }
                  .gap(10)
                  .padding(14)
                  .borderRadius(20)
                  .backgroundColor("@{state.theme.card}")
                  .borderWidth(1)
                  .borderStyle("solid")
                  .borderColor("@{state.theme.cardBorder}")
                  .width("100%")

                // ---------- 7 days ----------
                Column {
                  Text("7-DAY FORECAST")
                    .fontSize(12)
                    .fontWeight(600)
                    .letterSpacing(0.8)
                    .color("@{state.theme.sub}")
                    .marginBottom(4)
                  ForEach(items: @state.daily, key: "id") {
                    Row {
                      Text("@{item.day}").fontSize(16).fontWeight(500).color("#FFFFFF").width(56).flexShrink(0)
                      Column {
                        Image(src: "@{item.icon}", alt: "@{item.condition}").width(28).height(28)
                        Text("@{item.pop}").fontSize(10).fontWeight(600).color("#9BDCFF")
                      }
                        .width(40)
                        .flexShrink(0)
                        .horizontalAlignment("center")
                      Text("@{item.lo}").fontSize(16).color("@{state.theme.sub}").width(40).textAlign("right").alignSelf("center").flexShrink(0)
                      Row {
                        Box {}.width("@{item.left}").height(6).flexShrink(0)
                        Box {}
                          .width("@{item.width}")
                          .height(6)
                          .borderRadius(3)
                          .background("@{item.bar}")
                          .transition(300, easeOut)
                      }
                        .flex(1)
                        .minWidth(40)
                        .height(6)
                        .borderRadius(3)
                        .backgroundColor("rgba(0,0,0,0.18)")
                        .overflow("hidden")
                        .marginHorizontal(12)
                      Text("@{item.hi}").fontSize(16).fontWeight(600).color("#FFFFFF").width(40).flexShrink(0)
                    }
                      .verticalAlignment("center")
                      .paddingVertical(7)
                      .borderTop("1px solid @{state.theme.cardBorder}")
                      .width("100%")
                  }
                }
                  .padding(14)
                  .borderRadius(20)
                  .backgroundColor("@{state.theme.card}")
                  .borderWidth(1)
                  .borderStyle("solid")
                  .borderColor("@{state.theme.cardBorder}")
                  .width("100%")

                // ---------- detail tiles ----------
                Grid(@state.details, key: "id") {
                  Column {
                    Text("@{item.label}")
                      .fontSize(11)
                      .fontWeight(600)
                      .letterSpacing(0.8)
                      .textTransform("uppercase")
                      .color("@{state.theme.sub}")
                    Text("@{item.value}").fontSize(26).fontWeight(500).color("#FFFFFF")
                    Text("@{item.sub}").fontSize(12).color("@{state.theme.sub}").lineHeight(1.35)
                  }
                    .gap(4)
                    .padding(14)
                    .minHeight(112)
                    .borderRadius(20)
                    .backgroundColor("@{state.theme.card}")
                    .borderWidth(1)
                    .borderStyle("solid")
                    .borderColor("@{state.theme.cardBorder}")
                }
                  .gridColumns({default: 2, md: 3})
                  .gap(12)
                  .width("100%")

                Text("@{state.footer}")
                  .fontSize(11)
                  .color("@{state.theme.sub}")
                  .textAlign("center")
                  .paddingVertical(6)
              }
                .gap(14)
                .width("100%")
            }
          }
        }
          .gap(12)
          .padding(16)
          .paddingBottom(28)
          .width("100%")
          .maxWidth(640)
          .alignSelf("center")
          .flexShrink(0)
      }
        .flex(1)
        .minHeight(0)
        .overflowY("auto")
        .width("100%")
        .background("@{state.theme.bg}")
        .color("#FFFFFF")
        .transition(400, easeOut)
    }
  `);

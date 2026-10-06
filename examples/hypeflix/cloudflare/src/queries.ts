// Hypeflix data layer — every title streams from the Internet Archive's
// public-domain feature-film collections (https://archive.org/details/feature_films).
//
// The streaming rule this app demonstrates: the server NEVER proxies or ships
// video payloads. It resolves a direct, streamable MP4 endpoint on archive.org
// (which serves HTTP 206 range responses), validates it with a 1-byte ranged
// probe, and sends the resolved URL string to the client's Video component.
// The client platform's media stack does the actual streaming.

export interface Movie {
  id: string;
  title: string;
  year: string;
  genre: string;
  blurb: string;
  /** Verified MP4 derivative inside the archive.org item (fallback if live resolution fails). */
  file: string;
  posterUrl: string;
  saved: boolean;
  meta: string;
  /**
   * Ordered candidate stream URLs for titles NOT resolved through
   * archive.org metadata (Wikimedia Commons transcodes, mirrors,
   * trailer fallbacks). resolveStream probes them in order and hands
   * out the first that validates — multi-candidate resolution keeps a
   * single dead host from killing a title.
   */
  candidates?: string[];
  /** Absolute upstream poster URL for the worker's poster proxy. */
  posterSource?: string;
}

export interface StreamResolution {
  ok: boolean;
  /** Resolved streamable endpoint (only set when ok). */
  url?: string;
  /** HTTP status that caused the failure (403 for restricted items, 404 for gone, ...). */
  status?: number;
  message?: string;
}

// Served by the worker's cached poster proxy (see worker.ts): same-origin,
// edge-cached, and only the first viewer of a title waits on archive.org.
// (Non-web clients resolving relative URLs — the desktop remote example —
// degrade to the placeholder; poster is best-effort there anyway.)
const posterUrl = (id: string) => `/poster/${encodeURIComponent(id)}`;
const downloadUrl = (id: string, file: string) =>
  `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;

interface Seed {
  id: string;
  title: string;
  year: string;
  genre: string;
  blurb: string;
  file: string;
}

const seed = (s: Seed): Movie => ({
  ...s,
  posterUrl: posterUrl(s.id),
  saved: false,
  meta: `${s.year} · ${s.genre}`,
});

// Open movies resolved from Wikimedia Commons transcodes (verified ranged
// probes) with per-title fallback tiers — Google's old gtv-videos-bucket now
// returns AccessDenied, and archive.org is frequently slow, so every title
// carries an ORDERED candidate list instead of trusting one host. Posters
// resolve through the worker's caching proxy via Special:FilePath (the proxy
// follows the redirect and caches the thumb for a day).
const COMMONS_T = "https://upload.wikimedia.org/wikipedia/commons/transcoded";
const commonsPoster = (file: string) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=640`;
const openMovie = (o: {
  id: string; title: string; year: string; genre: string; blurb: string;
  candidates: string[]; posterFile: string;
}): Movie => ({
  id: o.id,
  title: o.title,
  year: o.year,
  genre: o.genre,
  blurb: o.blurb,
  file: "",
  candidates: o.candidates,
  posterUrl: posterUrl(o.id),
  posterSource: commonsPoster(o.posterFile),
  saved: false,
  meta: `${o.year} · ${o.genre}`,
});

// Every entry below was verified against the archive.org metadata API: the item
// is not access-restricted and the listed MP4 derivative exists and serves
// range requests. Items can still disappear or get restricted later — that is
// exactly the failure mode `resolveStream` guards against at play time.

const BBB_FILE = "Big_Buck_Bunny_4K.webm";
const NOTLD_FILE = "Night_of_the_Living_Dead_%281968%29.webm";
const SINTEL_FILE = "Sintel_movie_4K.webm";
const TOS_FILE = "Tears_of_Steel_in_4k_-_Official_Blender_Foundation_release.webm";

export const FEATURED: Movie = openMovie({
  id: "big-buck-bunny",
  title: "Big Buck Bunny",
  year: "2008",
  genre: "Animation",
  blurb:
    "The Blender Institute's open-movie classic: a gentle giant rabbit exacts good-natured revenge on three bullying rodents. Made entirely with free software and released Creative Commons.",
  candidates: [
    `${COMMONS_T}/c/c0/${BBB_FILE}/${BBB_FILE}.360p.mpeg4.mp4`,
    `${COMMONS_T}/c/c0/${BBB_FILE}/${BBB_FILE}.720p.vp9.webm`,
    "https://media.w3.org/2010/05/bunny/movie.mp4",
  ],
  posterFile: BBB_FILE,
});

const OPEN_MOVIES: Movie[] = [
  FEATURED,
  openMovie({
    id: "sintel", title: "Sintel", year: "2010", genre: "Fantasy",
    blurb: "A lone woman crosses a fantastical world searching for the dragon she once rescued. Blender's third open movie.",
    candidates: [
      `${COMMONS_T}/f/f1/${SINTEL_FILE}/${SINTEL_FILE}.480p.vp9.webm`,
      "https://media.w3.org/2010/05/sintel/trailer.mp4",
    ],
    posterFile: SINTEL_FILE,
  }),
  openMovie({
    id: "tears-of-steel", title: "Tears of Steel", year: "2012", genre: "Sci-Fi",
    blurb: "Robots seize Amsterdam in Blender's live-action/VFX open movie, shot to stress-test its compositing tools.",
    candidates: [
      `${COMMONS_T}/1/10/${TOS_FILE}/${TOS_FILE}.480p.vp9.webm`,
      "https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov",
    ],
    posterFile: TOS_FILE,
  }),
];

const TRENDING: Movie[] = [
  {
    ...seed({ id: "Night.Of.The.Living.Dead_1080p", title: "Night of the Living Dead", year: "1968", genre: "Horror", blurb: "George A. Romero's landmark of independent horror: strangers barricade a Pennsylvania farmhouse as the dead begin to walk.", file: "NightOfTheLivingDead_DVD5_512kb.mp4" }),
    // Same public-domain film on Wikimedia Commons — the fallback tier
    // when archive.org is slow or unresponsive.
    candidates: [`${COMMONS_T}/2/24/${NOTLD_FILE}/${NOTLD_FILE}.480p.vp9.webm`],
  },
  seed({ id: "his_girl_friday", title: "His Girl Friday", year: "1940", genre: "Comedy", blurb: "Cary Grant and Rosalind Russell trade the fastest dialogue ever filmed in Howard Hawks' newsroom screwball classic.", file: "his_girl_friday_512kb.mp4" }),
  seed({ id: "house_on_haunted_hill_ipod", title: "House on Haunted Hill", year: "1959", genre: "Horror", blurb: "Vincent Price offers five guests $10,000 each to survive a night in a haunted mansion. William Castle's gimmick-horror gem.", file: "house_on_haunted_hill_512kb.mp4" }),
  seed({ id: "charlie_chaplin_film_fest", title: "Charlie Chaplin Festival", year: "1938", genre: "Comedy", blurb: "Four classic Chaplin two-reelers — The Adventurer, The Cure, Easy Street and The Immigrant — in one festival cut.", file: "charlie_chaplin_film_fest_512kb.mp4" }),
  seed({ id: "TheFastandtheFuriousJohnIreland1954goofyrip", title: "The Fast and the Furious", year: "1955", genre: "Thriller", blurb: "A wrongly-accused trucker breaks jail and hijacks a Jaguar bound for a cross-border road race. The Corman original.", file: "TheFastandtheFuriousJohnIreland1954goofyrip_512kb.mp4" }),
  seed({ id: "Return_of_the_Kung_Fu_Dragon", title: "Return of the Kung Fu Dragon", year: "1976", genre: "Action", blurb: "A tyrant seizes a golden city; twenty years on, the rightful heirs fight back. Vintage Taiwanese kung-fu fantasy.", file: "Return_of_the_Kung_Fu_Dragon_512kb.mp4" }),
  seed({ id: "VoyagetothePlanetofPrehistoricWomen", title: "Voyage to the Planet of Prehistoric Women", year: "1967", genre: "Sci-Fi", blurb: "Astronauts on Venus meet telepathic priestesses in Peter Bogdanovich's gloriously recycled space oddity.", file: "VoyagetothePlanetofPrehistoricWomen_512kb.mp4" }),
  seed({ id: "JungleBook", title: "Jungle Book", year: "1942", genre: "Adventure", blurb: "Sabu stars as Mowgli in Zoltán Korda's lush Technicolor telling of Kipling's tales.", file: "Jungle_Book_512kb.mp4" }),
  seed({ id: "reefer_madness1938", title: "Reefer Madness", year: "1938", genre: "Cult", blurb: "The unintentionally hilarious exploitation classic that became a midnight-movie institution.", file: "reefer_madness1938_512kb.mp4" }),
];

const NOIR: Movie[] = [
  seed({ id: "TheStranger_0", title: "The Stranger", year: "1946", genre: "Film Noir", blurb: "Orson Welles directs and stars as a Nazi war criminal hiding in a Connecticut town, with Edward G. Robinson on his trail.", file: "The_Stranger_512kb.mp4" }),
  seed({ id: "ScarletStreet", title: "Scarlet Street", year: "1945", genre: "Film Noir", blurb: "Fritz Lang's merciless noir: a meek cashier, a femme fatale, and a spiral into forgery and murder.", file: "Scarlet_Street_512kb.mp4" }),
  seed({ id: "Detour", title: "Detour", year: "1945", genre: "Film Noir", blurb: "Edgar G. Ulmer's poverty-row masterpiece — a hitchhiker, a dead man's identity, and the worst luck in noir history.", file: "Detour_512kb.mp4" }),
  seed({ id: "He_Walked_By_Night.avi", title: "He Walked by Night", year: "1948", genre: "Film Noir", blurb: "A cop-killer outwits the LAPD in this semi-documentary procedural that inspired Dragnet, shot by John Alton.", file: "He_Walked_By_Night_512kb.mp4" }),
  seed({ id: "kansascityconfidencial", title: "Kansas City Confidential", year: "1952", genre: "Film Noir", blurb: "An ex-con framed for an armored-car heist tracks the masked crew to Mexico. A blueprint for Reservoir Dogs.", file: "kansascityconfidencial_512kb.mp4" }),
  seed({ id: "TheRedHouse", title: "The Red House", year: "1947", genre: "Film Noir", blurb: "Edward G. Robinson guards the secret of a house deep in the woods in this rural gothic noir.", file: "The_Red_House_512kb.mp4" }),
  seed({ id: "TheChase_", title: "The Chase", year: "1946", genre: "Film Noir", blurb: "A shell-shocked veteran chauffeurs a Miami gangster — then runs with his wife to Havana. Dreamlike, fatalistic noir.", file: "TheChase_512kb.mp4" }),
  seed({ id: "Whistle_Stop", title: "Whistle Stop", year: "1946", genre: "Film Noir", blurb: "Ava Gardner returns to her small town and reignites an old flame into robbery and murder.", file: "Whistle_Stop_512kb.mp4" }),
];

const HORROR: Movie[] = [
  seed({ id: "Nosferatu_most_complete_version_93_mins.", title: "Nosferatu", year: "1922", genre: "Horror", blurb: "F.W. Murnau's unauthorized Dracula — Max Schreck's Count Orlok remains cinema's most unsettling vampire.", file: "Nosferatu_1922_Symphony_of_Horror_512kb.mp4" }),
  seed({ id: "ThePhantomoftheOpera", title: "The Phantom of the Opera", year: "1925", genre: "Horror", blurb: "Lon Chaney's Man of a Thousand Faces haunts the Paris Opera in the silent horror landmark.", file: "Phantom_of_the_Opera_512kb.mp4" }),
  seed({ id: "DasKabinettdesDoktorCaligariTheCabinetofDrCaligari", title: "The Cabinet of Dr. Caligari", year: "1920", genre: "Horror", blurb: "The original German Expressionist nightmare: a somnambulist, a carnival hypnotist, and painted shadows.", file: "The_Cabinet_of_Dr._Caligari_512kb.mp4" }),
  seed({ id: "CarnivalofSouls", title: "Carnival of Souls", year: "1962", genre: "Horror", blurb: "After a crash, a church organist drifts between worlds, drawn to an abandoned carnival pavilion. Eerie and unforgettable.", file: "CarnivalOfSouls_512kb.mp4" }),
  seed({ id: "Horror_Express", title: "Horror Express", year: "1973", genre: "Horror", blurb: "Christopher Lee and Peter Cushing trap an ancient alien horror aboard the Trans-Siberian Express.", file: "Horror_Express_512kb.mp4" }),
  seed({ id: "BloodyPitOfHorror", title: "Bloody Pit of Horror", year: "1965", genre: "Horror", blurb: "A photo crew picks the wrong castle: its owner believes he is the reincarnated Crimson Executioner. Italian gothic camp.", file: "BloodyPitOfHorror.mp4" }),
  seed({ id: "cco_attackofthegiantleeches", title: "Attack of the Giant Leeches", year: "1959", genre: "Horror", blurb: "Something in the Florida swamp is dragging people under. Drive-in creature-feature perfection.", file: "ccoPublicDomainAttack_of_the_Giant_Leeches_512kb.mp4" }),
];

const SCIFI: Movie[] = [
  seed({ id: "Killers_from_space", title: "Killers from Space", year: "1954", genre: "Sci-Fi", blurb: "Peter Graves is brought back from the dead by bug-eyed aliens plotting invasion from inside a mountain.", file: "Killers_from_space_512kb.mp4" }),
  seed({ id: "teenagers_from_outerspace", title: "Teenagers from Outer Space", year: "1959", genre: "Sci-Fi", blurb: "An alien deserter falls for an Earth girl while his crewmates unleash the Gargon. Beloved B-movie schlock.", file: "Teenagers_from_Outer_Space_512kb.mp4" }),
  seed({ id: "planet_outlaws_ipod", title: "Planet Outlaws", year: "1953", genre: "Sci-Fi", blurb: "Buck Rogers wakes after 500 years to battle Killer Kane — the 1939 serial recut as a feature.", file: "planet_outlaws_512kb.mp4" }),
  seed({ id: "In_The_Year_2889", title: "In the Year 2889", year: "1967", genre: "Sci-Fi", blurb: "Survivors of a nuclear apocalypse hold out in a valley stalked by mutants. Larry Buchanan's TV-movie remake of Day the World Ended.", file: "In_The_Year_2889_1967.avi_512kb.mp4" }),
  seed({ id: "Cosmos_War_of_the_Planets", title: "Cosmos: War of the Planets", year: "1977", genre: "Sci-Fi", blurb: "Italian space opera at its most delirious — rogue planets, killer robots, and disco-ready spacesuits.", file: "Cosmos_War_of_the_Planets_512kb.mp4" }),
  seed({ id: "WarOfTheRobots", title: "War of the Robots", year: "1978", genre: "Sci-Fi", blurb: "Android abductors, laser swords, and starship dogfights in Alfonso Brescia's shameless space epic.", file: "WarOfTheRobots1978.mp4" }),
  seed({ id: "StarWreckInThePirkining", title: "Star Wreck: In the Pirkining", year: "2005", genre: "Sci-Fi", blurb: "The Finnish fan-parody phenomenon — a feature-length space battle made by volunteers and released free.", file: "StarWreck_512kb.mp4" }),
];

const COMEDY: Movie[] = [
  seed({ id: "my_favorite_brunette", title: "My Favorite Brunette", year: "1947", genre: "Comedy", blurb: "Bob Hope's baby photographer is mistaken for a private eye, with Dorothy Lamour and Peter Lorre along for the ride.", file: "my_favorite_brunette_512kb.mp4" }),
  seed({ id: "mclintok_widescreen", title: "McLintock!", year: "1963", genre: "Comedy", blurb: "John Wayne and Maureen O'Hara brawl through a comic western take on The Taming of the Shrew.", file: "McLintock_512kb.mp4" }),
  seed({ id: "royal_wedding", title: "Royal Wedding", year: "1951", genre: "Musical", blurb: "Fred Astaire dances on the ceiling — literally — in Stanley Donen's London-set musical.", file: "royal_wedding_512kb.mp4" }),
  seed({ id: "TheFlyingDeuces", title: "The Flying Deuces", year: "1939", genre: "Comedy", blurb: "Laurel and Hardy join the Foreign Legion to forget a broken heart. Chaos, inevitably, ensues.", file: "The_Flying_Deuces_512kb.mp4" }),
  seed({ id: "AsYouLikeIt1936", title: "As You Like It", year: "1936", genre: "Comedy", blurb: "A young Laurence Olivier stars in Shakespeare's forest comedy of disguise and courtship.", file: "AsYouLikeIt_512kb.mp4" }),
  seed({ id: "3stooges", title: "Three Stooges: Malice in the Palace", year: "1949", genre: "Comedy", blurb: "The Stooges chase a stolen diamond through a desert café. Slapstick in its purest form.", file: "3stooges_NewMalice1_512kb.mp4" }),
];

export interface Rail {
  key: string;
  title: string;
  movies: Movie[];
}

const RAILS: Rail[] = [
  { key: "open", title: "Blender open movies — always on", movies: OPEN_MOVIES },
  { key: "trending", title: "Trending now", movies: TRENDING },
  { key: "noir", title: "Film noir", movies: NOIR },
  { key: "horror", title: "Horror & chills", movies: HORROR },
  { key: "scifi", title: "Sci-fi B-movies", movies: SCIFI },
  { key: "comedy", title: "Comedy classics", movies: COMEDY },
];

// The Midnight Marathon is the playlist showcase: one Video element playing a
// queue of resolved URLs back-to-back (onTrackChange keeps the UI in sync).
export const MARATHON_ID = "midnight-marathon";
export const MARATHON_TITLE = "Midnight Creature Marathon";
export const MARATHON_IDS = [
  "CarnivalofSouls",
  "cco_attackofthegiantleeches",
  "Killers_from_space",
];

const ALL: Map<string, Movie> = new Map(
  [FEATURED, ...OPEN_MOVIES, ...TRENDING, ...NOIR, ...HORROR, ...SCIFI, ...COMEDY].map(
    (m) => [m.id, m],
  ),
);

// ---------------------------------------------------------------------------
// Catalog reads (module-scope state lives for the life of the DO isolate)
// ---------------------------------------------------------------------------

// Saved-list membership is PER-SESSION state owned by the Browse module —
// a module-scope Set here would be shared by every Durable Object instance
// in the JS isolate, leaking one user's list into another's session.
const withSaved = (saved: ReadonlySet<string>) => (m: Movie): Movie => ({
  ...m,
  saved: saved.has(m.id),
});

export function getFeatured(saved: ReadonlySet<string>): Movie {
  return withSaved(saved)(FEATURED);
}

export function getRails(saved: ReadonlySet<string>): Rail[] {
  return RAILS.map((rail) => ({ ...rail, movies: rail.movies.map(withSaved(saved)) }));
}

export function getMovie(id: string, saved: ReadonlySet<string>): Movie | null {
  const movie = ALL.get(id);
  return movie ? withSaved(saved)(movie) : null;
}

/** Upstream poster URL for the worker's caching poster proxy. */
export function posterSource(id: string): string | null {
  const movie = ALL.get(id);
  if (movie?.posterSource) return movie.posterSource;
  if (movie) return `https://archive.org/services/img/${encodeURIComponent(movie.id)}`;
  return null;
}

export function getMyList(saved: ReadonlySet<string>): Movie[] {
  return [...saved]
    .map((id) => ALL.get(id))
    .filter(Boolean)
    .map((m) => withSaved(saved)(m!));
}


// ---------------------------------------------------------------------------
// Stream resolution + validation
// ---------------------------------------------------------------------------

interface ArchiveFile {
  name: string;
  format?: string;
  size?: string;
}

const resolutionCache = new Map<string, StreamResolution>();

/** Upper bound on each archive.org round trip during stream resolution. */
const RESOLVE_TIMEOUT_MS = 10_000;

/** Pick the best streamable MP4 derivative from an item's file list. */
function pickMp4(files: ArchiveFile[]): string | null {
  const mp4s = files
    .filter((f) => f.name.toLowerCase().endsWith(".mp4"))
    .map((f) => ({ name: f.name, size: Number(f.size ?? 0) }))
    .sort((a, b) => a.size - b.size);
  if (mp4s.length === 0) return null;
  // Prefer the 512kb derivative: small enough to stream smoothly, present on
  // nearly every archive.org movie item.
  const derived = mp4s.find((f) => f.name.toLowerCase().includes("512kb"));
  if (derived) return derived.name;
  // Otherwise the smallest file that is plausibly the full feature (>50MB
  // filters out trailers/clips), falling back to the largest available.
  return (mp4s.find((f) => f.size >= 50_000_000) ?? mp4s[mp4s.length - 1]).name;
}

/**
 * Resolve a movie id to a validated, directly-streamable URL.
 *
 * 1. Ask the archive.org metadata API for the item's current file list and
 *    pick the best MP4 derivative (files get re-derived/renamed over time, so
 *    live resolution beats the curated snapshot).
 * 2. Fall back to the curated file name if the metadata API is unreachable.
 * 3. Validate with a 1-byte ranged GET. Restricted items answer 403, deleted
 *    ones 404 — those become a structured failure the UI surfaces instead of
 *    handing the client a URL that will die in the player.
 */
/** Validate a candidate stream URL with a 1-byte ranged GET.
 *
 * Wikimedia requires a User-Agent (anonymous fetches 403), and a 429
 * passes through as ok: the probe exists to catch gone/restricted URLs
 * (403/404), not to fail a title because the SERVER's egress is
 * rate-limited — the client's own address fetches independently. */
const PROBE_UA = "HypenflixExample/1.0 (Hypen Video component demo)";
async function probeUrl(url: string): Promise<StreamResolution> {
  try {
    const probe = await fetch(url, {
      headers: { Range: "bytes=0-0", "User-Agent": PROBE_UA },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (probe.status === 429) {
      await probe.body?.cancel();
      return { ok: true, url };
    }
    // Drain the 1-byte body so the connection is released.
    const resolution: StreamResolution =
      probe.ok || probe.status === 206
        ? { ok: true, url }
        : {
            ok: false,
            status: probe.status,
            message: `The stream endpoint returned HTTP ${probe.status}.`,
          };
    await probe.body?.cancel();
    return resolution;
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach the stream endpoint: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function resolveStream(id: string): Promise<StreamResolution> {
  const cached = resolutionCache.get(id);
  if (cached?.ok) return cached;

  const movie = ALL.get(id);

  // Multi-candidate titles skip archive.org metadata resolution: probe
  // the ordered candidates and hand out the first that validates.
  if (movie?.candidates?.length && !movie.file) {
    let last: StreamResolution = { ok: false, message: "No candidate validated." };
    for (const url of movie.candidates) {
      last = await probeUrl(url);
      if (last.ok) break;
    }
    resolutionCache.set(id, last);
    return last;
  }

  let file = movie?.file ?? null;

  try {
    // Timeout: when archive.org hangs (it does), the UI must reach the
    // structured failure card, not shimmer on "Resolving stream…" forever.
    const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as { files?: ArchiveFile[]; is_dark?: boolean };
      if (data?.files?.length) {
        file = pickMp4(data.files) ?? file;
      }
    }
  } catch {
    // Metadata API unreachable — fall through to the curated file name.
  }

  if (!file) {
    return { ok: false, status: 404, message: "No streamable MP4 found for this title." };
  }

  let resolution = await probeUrl(downloadUrl(id, file));
  // Archive-hosted titles with fallback candidates (e.g. a Wikimedia
  // Commons transcode of the same public-domain film) try those tiers
  // before surfacing a failure.
  if (!resolution.ok && movie?.candidates?.length) {
    for (const url of movie.candidates) {
      const alt = await probeUrl(url);
      if (alt.ok) {
        resolution = alt;
        break;
      }
    }
  }
  resolutionCache.set(id, resolution);
  return resolution;
}

/** Resolve the marathon queue, keeping only tracks that validated. */
export async function resolveMarathon(): Promise<{
  urls: string[];
  titles: string[];
  failures: string[];
}> {
  const results = await Promise.all(MARATHON_IDS.map((id) => resolveStream(id)));
  const urls: string[] = [];
  const titles: string[] = [];
  const failures: string[] = [];
  results.forEach((res, i) => {
    const title = ALL.get(MARATHON_IDS[i])?.title ?? MARATHON_IDS[i];
    if (res.ok && res.url) {
      urls.push(res.url);
      titles.push(title);
    } else {
      failures.push(`${title}${res.status ? ` (HTTP ${res.status})` : ""}`);
    }
  });
  return { urls, titles, failures };
}

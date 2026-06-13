export interface User {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  favoriteGenre: string;
}

export interface Movie {
  id: string;
  title: string;
  year: number;
  runtimeMin: number;
  rating: number;
  maturity: string;
  genre: string;
  mood: string;
  posterEmoji: string;
  posterUrl: string;
  posterBg: string;
  accent: string;
  tagline: string;
  synopsis: string;
  cast: string;
  isFeatured: boolean;
  isTrending: boolean;
  rank: number;
  saved: boolean;
  meta: string;
  ratingLabel: string;
}

export interface GenreTab {
  id: string;
  label: string;
  active: boolean;
}

interface OmdbSearchItem {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

interface OmdbDetail {
  Title: string;
  Year: string;
  Rated: string;
  Runtime: string;
  Genre: string;
  Director: string;
  Actors: string;
  Plot: string;
  Poster: string;
  imdbRating: string;
  imdbID: string;
  Type: string;
  Response: "True" | "False";
  Error?: string;
}

const USER: User = {
  id: "u1",
  name: "Mara Vale",
  handle: "@marawatches",
  avatar: "MV",
  favoriteGenre: "Sci-Fi",
};

const FEATURED_ID = "tt1375666"; // Inception
const TRENDING_IDS = [
  "tt1375666", // Inception
  "tt0816692", // Interstellar
  "tt0111161", // The Shawshank Redemption
  "tt0468569", // The Dark Knight
  "tt0133093", // The Matrix
  "tt0110912", // Pulp Fiction
  "tt0109830", // Forrest Gump
  "tt0172495", // Gladiator
];
const RECOMMENDED_IDS = [
  "tt0482571", // The Prestige
  "tt2582802", // Whiplash
  "tt6751668", // Parasite
  "tt1853728", // Django Unchained
  "tt4154796", // Avengers: Endgame
  "tt7286456", // Joker
  "tt1745960", // Top Gun: Maverick
  "tt2380307", // Coco
];

const DEFAULT_WATCHLIST = ["tt1375666", "tt0816692", "tt0482571"];
const watchlist = new Set(DEFAULT_WATCHLIST);
const detailCache = new Map<string, Movie>();
const searchCache = new Map<string, OmdbSearchItem[]>();
const DEMO_OMDB_API_KEY = "2ab6e349";

export const GENRES = ["All", "Sci-Fi", "Drama", "Thriller", "Adventure", "Action", "Mystery", "Comedy"];

const FALLBACK_MOVIES: Record<string, Omit<Movie, "saved">> = {
  tt1375666: fallbackMovie("tt1375666", "Inception", 2010, 148, 8.8, "PG-13", "Action, Adventure, Sci-Fi", "Mind-bending", "A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea.", "Leonardo DiCaprio, Joseph Gordon-Levitt, Elliot Page", true, true, 1),
  tt0816692: fallbackMovie("tt0816692", "Interstellar", 2014, 169, 8.7, "PG-13", "Adventure, Drama, Sci-Fi", "Expansive", "A team of explorers travels through a wormhole in space in an attempt to ensure humanity's survival.", "Matthew McConaughey, Anne Hathaway, Jessica Chastain", false, true, 2),
  tt0111161: fallbackMovie("tt0111161", "The Shawshank Redemption", 1994, 142, 9.3, "R", "Drama", "Hopeful", "Two imprisoned men bond over a number of years, finding solace and eventual redemption.", "Tim Robbins, Morgan Freeman, Bob Gunton", false, true, 3),
  tt0468569: fallbackMovie("tt0468569", "The Dark Knight", 2008, 152, 9.0, "PG-13", "Action, Crime, Drama", "Iconic", "Batman faces the Joker, a criminal mastermind who plunges Gotham into chaos.", "Christian Bale, Heath Ledger, Aaron Eckhart", false, true, 4),
  tt0133093: fallbackMovie("tt0133093", "The Matrix", 1999, 136, 8.7, "R", "Action, Sci-Fi", "Cyberpunk", "A hacker learns reality is a simulation and joins a rebellion against its controllers.", "Keanu Reeves, Laurence Fishburne, Carrie-Anne Moss", false, true, 5),
  tt0110912: fallbackMovie("tt0110912", "Pulp Fiction", 1994, 154, 8.9, "R", "Crime, Drama", "Sharp", "Interwoven stories of crime and consequence unfold across Los Angeles.", "John Travolta, Uma Thurman, Samuel L. Jackson", false, true, 6),
  tt0109830: fallbackMovie("tt0109830", "Forrest Gump", 1994, 142, 8.8, "PG-13", "Drama, Romance", "Heartfelt", "A kind-hearted man finds himself crossing paths with defining moments in American history.", "Tom Hanks, Robin Wright, Gary Sinise", false, true, 7),
  tt0172495: fallbackMovie("tt0172495", "Gladiator", 2000, 155, 8.5, "R", "Action, Adventure, Drama", "Epic", "A betrayed Roman general seeks justice from the emperor who murdered his family.", "Russell Crowe, Joaquin Phoenix, Connie Nielsen", false, true, 8),
  tt0482571: fallbackMovie("tt0482571", "The Prestige", 2006, 130, 8.5, "PG-13", "Drama, Mystery, Sci-Fi", "Obsessive", "Two rival magicians wage a dangerous battle of secrets, sacrifice, and illusion.", "Christian Bale, Hugh Jackman, Scarlett Johansson", false, false, 9),
  tt2582802: fallbackMovie("tt2582802", "Whiplash", 2014, 106, 8.5, "R", "Drama, Music", "Intense", "A young drummer is pushed to his limits by a ruthless conservatory instructor.", "Miles Teller, J.K. Simmons, Melissa Benoist", false, false, 10),
  tt6751668: fallbackMovie("tt6751668", "Parasite", 2019, 132, 8.5, "R", "Drama, Thriller", "Unsettling", "A poor family schemes its way into the lives of a wealthy household.", "Song Kang-ho, Lee Sun-kyun, Cho Yeo-jeong", false, false, 11),
  tt1853728: fallbackMovie("tt1853728", "Django Unchained", 2012, 165, 8.5, "R", "Drama, Western", "Bold", "A freed slave teams up with a bounty hunter to rescue his wife.", "Jamie Foxx, Christoph Waltz, Leonardo DiCaprio", false, false, 12),
  tt4154796: fallbackMovie("tt4154796", "Avengers: Endgame", 2019, 181, 8.4, "PG-13", "Action, Adventure, Drama", "Massive", "The surviving Avengers assemble for one last chance to undo catastrophe.", "Robert Downey Jr., Chris Evans, Scarlett Johansson", false, false, 13),
  tt7286456: fallbackMovie("tt7286456", "Joker", 2019, 122, 8.4, "R", "Crime, Drama, Thriller", "Dark", "A failed comedian descends into violence and becomes a symbol of unrest.", "Joaquin Phoenix, Robert De Niro, Zazie Beetz", false, false, 14),
  tt1745960: fallbackMovie("tt1745960", "Top Gun: Maverick", 2022, 130, 8.2, "PG-13", "Action, Drama", "Soaring", "Maverick returns to train elite pilots for a mission that demands everything.", "Tom Cruise, Jennifer Connelly, Miles Teller", false, false, 15),
  tt2380307: fallbackMovie("tt2380307", "Coco", 2017, 105, 8.4, "PG", "Animation, Adventure, Drama", "Warm", "A music-loving boy journeys into the Land of the Dead to uncover his family story.", "Anthony Gonzalez, Gael Garcia Bernal, Benjamin Bratt", false, false, 16),
};

function fallbackMovie(
  id: string,
  title: string,
  year: number,
  runtimeMin: number,
  rating: number,
  maturity: string,
  genre: string,
  mood: string,
  synopsis: string,
  cast: string,
  isFeatured: boolean,
  isTrending: boolean,
  rank: number,
): Omit<Movie, "saved"> {
  return {
    id,
    title,
    year,
    runtimeMin,
    rating,
    maturity,
    genre,
    mood,
    posterEmoji: "★",
    posterUrl: posterFallbackSvg(title),
    posterBg: "#111827",
    accent: accentForGenre(genre),
    tagline: synopsis,
    synopsis,
    cast,
    isFeatured,
    isTrending,
    rank,
    meta: `${year} · ${runtimeMin} min · ${maturity}`,
    ratingLabel: rating.toFixed(1),
  };
}

function apiKey(): string | null {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.OMDB_API_KEY || runtime.process?.env?.OMDB_KEY || DEMO_OMDB_API_KEY || null;
}

async function omdb(params: Record<string, string>): Promise<any | null> {
  const key = apiKey();
  if (!key) return null;
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", key);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OMDb request failed: ${response.status}`);
  return response.json();
}

function posterFallbackSvg(title: string): string {
  const escaped = title.replace(/[<&>"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[ch] ?? ch));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480" viewBox="0 0 320 480"><rect width="320" height="480" fill="#111827"/><rect x="18" y="18" width="284" height="444" rx="28" fill="#1E293B" stroke="#334155"/><text x="160" y="214" font-family="Arial" font-size="32" font-weight="700" fill="#FACC15" text-anchor="middle">Cinebox</text><text x="160" y="262" font-family="Arial" font-size="24" fill="#F8FAFC" text-anchor="middle">${escaped}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function accentForGenre(genre: string): string {
  if (genre.includes("Sci-Fi")) return "#22D3EE";
  if (genre.includes("Drama")) return "#A78BFA";
  if (genre.includes("Action")) return "#EC4899";
  if (genre.includes("Comedy")) return "#FACC15";
  if (genre.includes("Mystery") || genre.includes("Thriller")) return "#34D399";
  return "#EC4899";
}

function moodForGenre(genre: string): string {
  if (genre.includes("Sci-Fi")) return "Mind-bending";
  if (genre.includes("Drama")) return "Prestige";
  if (genre.includes("Action")) return "High energy";
  if (genre.includes("Comedy")) return "Easy watch";
  if (genre.includes("Mystery")) return "Atmospheric";
  if (genre.includes("Thriller")) return "Tense";
  if (genre.includes("Animation")) return "Bright";
  return "Critic pick";
}

function parseYear(value: string): number {
  const match = value.match(/\d{4}/);
  return match ? Number(match[0]) : 0;
}

function parseRuntime(value: string): number {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function movieFromOmdb(detail: OmdbDetail, rank = 0, isFeatured = false, isTrending = false): Movie {
  const year = parseYear(detail.Year);
  const runtimeMin = parseRuntime(detail.Runtime);
  const rating = Number(detail.imdbRating) || 0;
  const genre = detail.Genre && detail.Genre !== "N/A" ? detail.Genre : "Movie";
  const maturity = detail.Rated && detail.Rated !== "N/A" ? detail.Rated : "NR";
  const synopsis = detail.Plot && detail.Plot !== "N/A" ? detail.Plot : "No plot summary is available yet.";
  const posterUrl = detail.Poster && detail.Poster !== "N/A" ? detail.Poster : posterFallbackSvg(detail.Title);
  return {
    id: detail.imdbID,
    title: detail.Title,
    year,
    runtimeMin,
    rating,
    maturity,
    genre,
    mood: moodForGenre(genre),
    posterEmoji: "★",
    posterUrl,
    posterBg: "#111827",
    accent: accentForGenre(genre),
    tagline: synopsis,
    synopsis,
    cast: detail.Actors && detail.Actors !== "N/A" ? detail.Actors : "Cast unavailable",
    isFeatured,
    isTrending,
    rank,
    saved: watchlist.has(detail.imdbID),
    meta: `${year || "Unknown"} · ${runtimeMin || "?"} min · ${maturity}`,
    ratingLabel: rating > 0 ? rating.toFixed(1) : "NR",
  };
}

async function getMovieById(id: string, rank = 0, isFeatured = false, isTrending = false): Promise<Movie> {
  const cached = detailCache.get(id);
  if (cached) {
    return { ...cached, rank, isFeatured, isTrending, saved: watchlist.has(id) };
  }

  const data = await omdb({ i: id, plot: "short", type: "movie" }) as OmdbDetail | null;
  if (data?.Response === "True") {
    const movie = movieFromOmdb(data, rank, isFeatured, isTrending);
    detailCache.set(id, movie);
    return movie;
  }

  const fallback = FALLBACK_MOVIES[id] ?? fallbackMovie(id, "Movie unavailable", 0, 0, 0, "NR", "Movie", "Offline", "Set OMDB_API_KEY to load this title from OMDb.", "Cast unavailable", isFeatured, isTrending, rank);
  const movie = { ...fallback, rank, isFeatured, isTrending, saved: watchlist.has(id) };
  detailCache.set(id, movie);
  return movie;
}

async function getMoviesById(ids: string[], isTrending = false): Promise<Movie[]> {
  const movies = await Promise.all(ids.map((id, index) => getMovieById(id, index + 1, id === FEATURED_ID, isTrending)));
  return movies;
}

export function getPrimaryUser(): User {
  return USER;
}

export function genreTabs(active: string): GenreTab[] {
  return GENRES.map((g) => ({ id: g, label: g, active: g === active }));
}

export async function getFeaturedMovie(_userId: string): Promise<Movie> {
  return getMovieById(FEATURED_ID, 1, true, true);
}

export async function getTrendingMovies(_userId: string, limit = 8): Promise<Movie[]> {
  return (await getMoviesById(TRENDING_IDS.slice(0, limit), true)).map((m) => ({ ...m, isTrending: true }));
}

export async function getRecommendedMovies(_userId: string, limit = 8): Promise<Movie[]> {
  return getMoviesById(RECOMMENDED_IDS.slice(0, limit), false);
}

async function searchOmdb(query: string): Promise<OmdbSearchItem[]> {
  const normalized = query.trim().toLowerCase();
  if (searchCache.has(normalized)) return searchCache.get(normalized)!;

  const data = await omdb({ s: query.trim(), type: "movie", page: "1" }) as { Search?: OmdbSearchItem[]; Response: "True" | "False" } | null;
  const rows = data?.Response === "True" ? data.Search ?? [] : [];
  searchCache.set(normalized, rows);
  return rows;
}

export async function searchMovies(_userId: string, query: string, genre: string): Promise<Movie[]> {
  if (!apiKey()) {
    const needle = query.trim().toLowerCase();
    const all = await getMoviesById([...TRENDING_IDS, ...RECOMMENDED_IDS], false);
    return all.filter((movie) => {
      const matchesQuery = !needle
        || movie.title.toLowerCase().includes(needle)
        || movie.genre.toLowerCase().includes(needle)
        || movie.mood.toLowerCase().includes(needle);
      const matchesGenre = genre === "All" || movie.genre.toLowerCase().includes(genre.toLowerCase());
      return matchesQuery && matchesGenre;
    }).slice(0, 10);
  }

  const searchQuery = query.trim() || (genre === "All" ? "star" : genre);
  const rows = await searchOmdb(searchQuery);
  const details = await Promise.all(rows.slice(0, 10).map((row, index) => getMovieById(row.imdbID, index + 1)));
  const filtered = genre === "All"
    ? details
    : details.filter((movie) => movie.genre.toLowerCase().includes(genre.toLowerCase()));
  return filtered;
}

export async function getMovie(_userId: string, id: string): Promise<Movie | null> {
  return getMovieById(id);
}

export async function getWatchlist(_userId: string): Promise<Movie[]> {
  return Promise.all([...watchlist].map((id, index) => getMovieById(id, index + 1)));
}

export function setSaved(_userId: string, movieId: string, saved: boolean) {
  if (saved) watchlist.add(movieId);
  else watchlist.delete(movieId);
}

export async function profileStats(userId: string) {
  const savedMovies = await getWatchlist(userId);
  const genreCounts = new Map<string, number>();
  let minutes = 0;
  for (const movie of savedMovies) {
    minutes += movie.runtimeMin || 0;
    const genre = movie.genre.split(",")[0]?.trim() || USER.favoriteGenre;
    genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
  }
  const topGenre = [...genreCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? USER.favoriteGenre;
  return {
    user: USER,
    saved: savedMovies.length,
    topGenre,
    hoursQueued: Math.round(minutes / 60),
  };
}

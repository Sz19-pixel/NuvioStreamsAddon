const axios = require('axios');
const cheerio = require('cheerio');

// Constants
const PROXY_URL = process.env.GDRIVEPLAYER_PROXY_URL || process.env.SHOWBOX_PROXY_URL_VALUE;
const BASE_URL = 'https://api.gdriveplayer.us';
const PLAYER_BASE_URL = 'https://database.gdriveplayer.us';
const TMDB_API_KEY_GDRIVEPLAYER = "439c478a771f35c05022f9feabcca01c"; // Public TMDB API key

// Simple In-Memory Cache
const gdriveCache = {
  search: {},
  episodes: {},
  players: {}
};
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes TTL for cache entries

// Function to get from cache
function getFromCache(type, key) {
  if (gdriveCache[type] && gdriveCache[type][key]) {
    const entry = gdriveCache[type][key];
    if (Date.now() - entry.timestamp < CACHE_TTL) {
      console.log(`[GDrivePlayer Cache] HIT for ${type} - ${key}`);
      return entry.data;
    }
    console.log(`[GDrivePlayer Cache] STALE for ${type} - ${key}`);
    delete gdriveCache[type][key]; // Remove stale entry
  }
  console.log(`[GDrivePlayer Cache] MISS for ${type} - ${key}`);
  return null;
}

// Function to save to cache
function saveToCache(type, key, data) {
  if (!gdriveCache[type]) gdriveCache[type] = {};
  gdriveCache[type][key] = {
    data: data,
    timestamp: Date.now()
  };
  console.log(`[GDrivePlayer Cache] SAVED for ${type} - ${key}`);
}

// Proxy wrapper for fetch
async function proxiedFetchGDrive(url, options = {}, isFullUrlOverride = false) {
  const isHttpUrl = url.startsWith('http://') || url.startsWith('https://');
  const fullUrl = isHttpUrl || isFullUrlOverride ? url : `${BASE_URL}${url}`;
  
  let fetchUrl;
  if (PROXY_URL) {
    fetchUrl = `${PROXY_URL}${encodeURIComponent(fullUrl)}`;
    console.log(`[GDrivePlayer] Fetching: ${url} (via proxy: ${fetchUrl.substring(0,100)}...)`);
  } else {
    fetchUrl = fullUrl;
    console.log(`[GDrivePlayer] Fetching: ${url} (direct request)`);
  }
  
  try {
    const response = await axios.get(fetchUrl, {
      timeout: 10000, // Reduced timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        ...options.headers
      },
      ...options
    });
    
    if (!response || response.status !== 200) {
      let errorBody = '';
      try {
        errorBody = response.data || '';
      } catch (e) { /* ignore */ }
      throw new Error(`Response not OK: ${response.status} ${response.statusText}. Body: ${errorBody.toString().substring(0,200)}`);
    }
    
    return response.data;
  } catch (error) {
    console.error(`[GDrivePlayer] Fetch error for ${url}:`, error.message);
    throw error;
  }
}

// Helper function to get IMDb ID from TMDB
async function getImdbIdFromTmdb(tmdbId, mediaType) {
  try {
    const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY_GDRIVEPLAYER}`;
    const response = await axios.get(tmdbUrl, { timeout: 10000 });
    
    if (response.data && response.data.imdb_id) {
      console.log(`[GDrivePlayer] Found IMDb ID ${response.data.imdb_id} for TMDB ${tmdbId}`);
      return response.data.imdb_id;
    }
    
    console.log(`[GDrivePlayer] No IMDb ID found for TMDB ${tmdbId}`);
    return null;
  } catch (error) {
    console.error(`[GDrivePlayer] Error getting IMDb ID for TMDB ${tmdbId}:`, error.message);
    return null;
  }
}

// Helper function to get TMDB info for quality and additional details
async function getTmdbInfo(tmdbId, mediaType) {
  try {
    const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY_GDRIVEPLAYER}`;
    const response = await axios.get(tmdbUrl, { timeout: 10000 });
    return response.data;
  } catch (error) {
    console.error(`[GDrivePlayer] Error getting TMDB info for ${tmdbId}:`, error.message);
    return null;
  }
}

// Generate placeholder streams when player endpoints are unavailable
function generatePlaceholderStreams(imdbId, title, mediaType, season = null, episode = null) {
  const quality = 'HD';
  const identifier = mediaType === 'movie' ? imdbId : `${imdbId}_S${season}E${episode}`;
  
  // Generate a placeholder URL that could potentially be resolved later
  const playerUrl = mediaType === 'movie' 
    ? `${PLAYER_BASE_URL}/player.php?imdb=${imdbId}`
    : `${PLAYER_BASE_URL}/player.php?type=series&imdb=${imdbId}&season=${season}&episode=${episode}`;

  return [{
    name: `[GDrivePlayer] ${title || 'Content'} ${quality}`,
    title: `GDrivePlayer ${quality}`,
    url: playerUrl, // Direct player URL - may work in some clients
    quality: quality,
    subtitles: [],
    behaviorHints: {
      bingeGroup: 'gdriveplayer-' + imdbId,
      countryWhitelist: ['US', 'GB', 'CA', 'AU', 'NZ', 'IE'],
      notWebReady: true, // Indicate this might not work in web players
      playerUrl: playerUrl // Store original player URL for reference
    }
  }];
}

// Alternative approach: try to resolve player redirects
async function tryPlayerRedirection(playerUrl) {
  try {
    console.log(`[GDrivePlayer] Attempting player redirection for: ${playerUrl}`);
    
    // Try with a very short timeout to catch immediate redirects
    const response = await axios.get(playerUrl, {
      timeout: 3000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://gdriveplayer.us'
      }
    });

    // Check if we got redirected to a direct video URL
    if (response.request.res.responseUrl && 
        (response.request.res.responseUrl.includes('googlevideo') || 
         response.request.res.responseUrl.includes('googleusercontent'))) {
      console.log(`[GDrivePlayer] Found direct video URL via redirect: ${response.request.res.responseUrl.substring(0, 100)}...`);
      return [{
        url: response.request.res.responseUrl,
        quality: 'HD',
        type: 'video/mp4'
      }];
    }

    return [];
  } catch (error) {
    console.log(`[GDrivePlayer] Player redirection failed: ${error.message}`);
    return [];
  }
}

// Main function to get streams
async function getGDrivePlayerStreams(tmdbId, mediaType = 'movie', season = '', episode = '') {
  console.log(`[GDrivePlayer] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);
  
  try {
    // First, get the IMDb ID from TMDB
    const imdbId = await getImdbIdFromTmdb(tmdbId, mediaType);
    if (!imdbId) {
      console.log(`[GDrivePlayer] Could not find IMDb ID for TMDB ${tmdbId}`);
      return [];
    }

    // Get TMDB info for title
    const tmdbInfo = await getTmdbInfo(tmdbId, mediaType);
    const title = tmdbInfo ? (tmdbInfo.title || tmdbInfo.name) : 'Unknown';

    let playerUrl = null;
    const cacheKey = `${mediaType}_${imdbId}${season ? `_S${season}E${episode}` : ''}`;
    
    // Check cache first
    const cached = getFromCache('search', cacheKey);
    if (cached) {
      playerUrl = cached;
    } else {
      if (mediaType === 'movie') {
        // For movies, get movie info first to get player URL
        try {
          const movieInfo = await proxiedFetchGDrive(`/v1/imdb/${imdbId}`);
          if (movieInfo && movieInfo.player_url) {
            playerUrl = movieInfo.player_url;
            saveToCache('search', cacheKey, playerUrl);
          }
        } catch (error) {
          console.log(`[GDrivePlayer] Error getting movie info for ${imdbId}:`, error.message);
        }
      } else if (mediaType === 'tv') {
        // For TV shows, get series info to get episode player URLs
        try {
          const seriesInfo = await proxiedFetchGDrive(`/v2/series/imdb/${imdbId}/season${season}`);
          if (seriesInfo && seriesInfo.length > 0 && seriesInfo[0].list_episode) {
            const episodeInfo = seriesInfo[0].list_episode.find(ep => ep.episode === episode.toString());
            if (episodeInfo && episodeInfo.player_url) {
              playerUrl = episodeInfo.player_url;
              saveToCache('search', cacheKey, playerUrl);
            }
          }
        } catch (error) {
          console.log(`[GDrivePlayer] Error getting series info for ${imdbId} S${season}E${episode}:`, error.message);
        }
      }
    }

    if (!playerUrl) {
      console.log(`[GDrivePlayer] No player URL found for ${imdbId}`);
      return [];
    }

    // Try to get streams through redirection first
    const redirectStreams = await tryPlayerRedirection(playerUrl);
    if (redirectStreams.length > 0) {
      console.log(`[GDrivePlayer] Successfully got ${redirectStreams.length} streams via redirection`);
      return redirectStreams.map((source, index) => ({
        name: `[GDrivePlayer] ${title} ${source.quality}`,
        title: `GDrivePlayer ${source.quality}`,
        url: source.url,
        quality: source.quality,
        subtitles: [],
        behaviorHints: {
          bingeGroup: 'gdriveplayer-' + imdbId,
          countryWhitelist: ['US', 'GB', 'CA', 'AU', 'NZ', 'IE']
        }
      }));
    }

    // If redirection doesn't work, provide the player URL as a fallback
    console.log(`[GDrivePlayer] Providing player URL as fallback stream`);
    const placeholderStreams = generatePlaceholderStreams(imdbId, title, mediaType, season, episode);
    
    return placeholderStreams;

  } catch (error) {
    console.error(`[GDrivePlayer] Error fetching streams:`, error.message);
    return [];
  }
}

module.exports = {
  getGDrivePlayerStreams
};

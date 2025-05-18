const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { spawn } = require("child_process");

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/downloads", express.static(path.join(__dirname, "output")));

// Helper function: Unpacks the obfuscated JavaScript code
function unPack(code) {
  function indent(code) {
    try {
      var tabs = 0,
        old = -1,
        add = "";
      for (var i = 0; i < code.length; i++) {
        if (code[i].indexOf("{") != -1) tabs++;
        if (code[i].indexOf("}") != -1) tabs--;

        if (old != tabs) {
          old = tabs;
          add = "";
          while (old > 0) {
            add += "\t";
            old--;
          }
          old = tabs;
        }

        code[i] = add + code[i];
      }
    } finally {
      tabs = null;
      old = null;
      add = null;
    }
    return code;
  }

  var env = {
    eval: function (c) {
      code = c;
    },
    window: {},
    document: {},
  };

  eval("with(env) {" + code + "}");

  code = (code + "")
    .replace(/;/g, ";\n")
    .replace(/{/g, "\n{\n")
    .replace(/}/g, "\n}\n")
    .replace(/\n;\n/g, ";\n")
    .replace(/\n\n/g, "\n");

  code = code.split("\n");
  code = indent(code);

  code = code.join("\n");
  return code;
}

// Helper function: Extracts video information from unpacked JavaScript
function extractVideoInfo(unpackedCode) {
  const videoInfo = {
    videoId: null,
    sources: [],
    thumbnailUrl: null,
    title: null,
    tracks: [],
    qualityLabels: {},
    playbackRates: [],
  };

  try {
    // Extract video ID
    const videoIdMatch = unpackedCode.match(/[?&]b=([^&"']+)/);
    if (videoIdMatch) {
      videoInfo.videoId = videoIdMatch[1];
    }

    // Extract sources (m3u8 links)
    const sourcesRegex = /sources\s*:\s*\[\s*{([^}]+)}\s*\]/g;
    let sourcesMatch;
    while ((sourcesMatch = sourcesRegex.exec(unpackedCode)) !== null) {
      const sourceData = sourcesMatch[1];

      // Extract file URL
      const fileMatch = sourceData.match(/file\s*:\s*["']([^"']+)["']/);
      if (fileMatch) {
        videoInfo.sources.push({
          file: fileMatch[1],
          type: fileMatch[1].includes(".m3u8") ? "hls" : "mp4",
        });
      }
    }

    // Extract all sources as an array
    const allSourcesMatch = unpackedCode.match(/sources\s*:\s*(\[[\s\S]*?\])/);
    if (allSourcesMatch) {
      const sourcesText = allSourcesMatch[1];
      const fileMatches = sourcesText.match(/file\s*:\s*["']([^"']+)["']/g);

      if (fileMatches && videoInfo.sources.length === 0) {
        fileMatches.forEach((match) => {
          const file = match.match(/file\s*:\s*["']([^"']+)["']/)[1];
          videoInfo.sources.push({
            file: file,
            type: file.includes(".m3u8") ? "hls" : "mp4",
          });
        });
      }
    }

    // Extract thumbnail URL
    const imageMatch = unpackedCode.match(/image\s*:\s*["']([^"']+)["']/);
    if (imageMatch) {
      videoInfo.thumbnailUrl = imageMatch[1];
    }

    // Try to extract title or file name
    const fileCodeMatch = unpackedCode.match(
      /file_code\s*:\s*["']([^"']+)["']/,
    );
    if (fileCodeMatch) {
      videoInfo.title = fileCodeMatch[1];
    }

    // Extract tracks (subtitles)
    const tracksRegex = /tracks\s*:\s*\[\s*{([^}]+)}\s*\]/g;
    let tracksMatch;
    while ((tracksMatch = tracksRegex.exec(unpackedCode)) !== null) {
      const trackData = tracksMatch[1];

      // Extract track info
      const trackFileMatch = trackData.match(/file\s*:\s*["']([^"']+)["']/);
      const trackLabelMatch = trackData.match(/label\s*:\s*["']([^"']+)["']/);
      const trackKindMatch = trackData.match(/kind\s*:\s*["']([^"']+)["']/);

      if (trackFileMatch) {
        videoInfo.tracks.push({
          file: trackFileMatch[1],
          label: trackLabelMatch ? trackLabelMatch[1] : "Unknown",
          kind: trackKindMatch ? trackKindMatch[1] : "captions",
        });
      }
    }

    // Extract quality labels
    const qualityLabelsRegex = /qualityLabels\s*:\s*{([^}]+)}/;
    const qualityLabelsMatch = qualityLabelsRegex.exec(unpackedCode);
    if (qualityLabelsMatch) {
      const qualityData = qualityLabelsMatch[1];
      const qualityEntries = qualityData.match(
        /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g,
      );

      if (qualityEntries) {
        qualityEntries.forEach((entry) => {
          const parts = entry.split(":");
          if (parts.length >= 2) {
            const key = parts[0].replace(/['"]/g, "").trim();
            const value = parts[1].replace(/['"]/g, "").trim();
            videoInfo.qualityLabels[key] = value;
          }
        });
      }
    }

    // Extract playback rates
    const playbackRatesRegex = /playbackRates\s*:\s*\[([\d\.,\s]+)\]/;
    const playbackRatesMatch = playbackRatesRegex.exec(unpackedCode);
    if (playbackRatesMatch) {
      const ratesStr = playbackRatesMatch[1];
      videoInfo.playbackRates = ratesStr
        .split(",")
        .map((rate) => parseFloat(rate.trim()));
    }

    // Generate fallback URLs for HLS streams
    if (videoInfo.sources.length > 0) {
      videoInfo.sources.forEach(source => {
        if (source.file && source.file.includes(".m3u8")) {
          try {
            // Extract important query parameters from the original URL
            const urlObj = new URL(source.file);
            
            // Add a proxied URL option that will work through our API
            source.proxyUrl = `/api/proxy/m3u8?url=${encodeURIComponent(source.file)}&videoId=${videoInfo.videoId}`;
            
            // Store URL parameters for debugging/reference
            const searchParams = urlObj.searchParams;
            source.urlParams = {
              t: searchParams.get('t'),
              s: searchParams.get('s'), 
              e: searchParams.get('e'),
              f: searchParams.get('f'),
              srv: searchParams.get('srv'),
              asn: searchParams.get('asn')
            };
            
            // Add direct stream segments URL for alternative access
            const urlParts = source.file.split('/');
            if (urlParts.length > 3) {
              // Try to extract base path for segments
              urlParts.pop(); // Remove the last part (master.m3u8 or similar)
              source.segmentsBaseUrl = urlParts.join('/') + '/';
            }
          } catch (err) {
            console.error(`Error processing HLS URL: ${err.message}`);
          }
        }
      });
    }

    return videoInfo;
  } catch (error) {
    console.error(`Error extracting video info: ${error.message}`);
    return videoInfo;
  }
}

// Helper function: Parse and format cookies for easier viewing
function parseCookies(cookieArray) {
  return cookieArray.map(cookie => {
    const parts = cookie.split(';');
    const mainPart = parts[0];
    const [name, value] = mainPart.split('=');
    
    // Extract additional attributes
    const attributes = {};
    parts.slice(1).forEach(part => {
      const [attrName, attrValue] = part.split('=').map(s => s.trim());
      attributes[attrName] = attrValue || true; // Some attributes like HttpOnly don't have values
    });
    
    return {
      name: name.trim(),
      value: value,
      attributes,
      raw: cookie
    };
  });
}

// Helper function: Fetch M3U8 content with proper authentication
async function fetchM3u8Content(url, cookies, referer) {
  try {
    console.log(`Fetching M3U8 content from: ${url}`);
    console.log(`Using cookies: ${cookies ? 'Yes' : 'No'}`);
    
    // Parse URL to extract hostname for proper headers
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // Create headers with necessary authentication
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.5",
      "Origin": `https://${hostname}`,
      "Referer": referer || `https://${hostname}/`,
      "Connection": "keep-alive",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
      "Cache-Control": "no-cache",
    };
    
    // Add cookies if provided
    if (cookies) {
      headers["Cookie"] = cookies;
    }
    
    // Make the request with a reasonable timeout
    const response = await axios.get(url, {
      headers,
      maxRedirects: 5,
      withCredentials: true,
      timeout: 15000, // 15 second timeout
      validateStatus: function (status) {
        return status >= 200 && status < 400; // Accept all successful responses
      }
    });
    
    // Make sure we got a text response, not binary
    // M3U8 should always be text, but check to be safe
    if (typeof response.data !== 'string') {
      if (Buffer.isBuffer(response.data)) {
        return response.data.toString('utf8');
      } else {
        throw new Error('Unexpected non-text response for M3U8 file');
      }
    }
    
    return response.data;
  } catch (error) {
    console.error(`Error fetching M3U8: ${error.message}`);
    if (error.response) {
      console.error(`Status code: ${error.response.status}`);
      console.error(`Headers: ${JSON.stringify(error.response.headers)}`);
    }
    throw error;
  }
}

// Helper function: Process M3U8 content to rewrite URLs to go through proxy
function processM3u8Content(content, baseUrl, videoId) {
  if (!content || !baseUrl) return content;
  
  try {
    // Convert baseUrl to URL object for easier manipulation
    const baseUrlObj = new URL(baseUrl);
    const baseUrlPath = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
    
    // Process all URLs in the M3U8 file
    return content
      // Handle stream URLs (for master playlist)
      .replace(
        /(#EXT-X-STREAM-INF:[^\n]*\n)([^\n]+)/g, 
        (match, tag, url) => {
          // Skip URLs that are already going through our proxy
          if (url.trim().startsWith('/api/proxy')) return match;
          
          // Handle relative URLs
          let absoluteUrl = url.trim();
          if (!absoluteUrl.match(/^https?:\/\//)) {
            if (absoluteUrl.startsWith('/')) {
              // Absolute path
              absoluteUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${absoluteUrl}`;
            } else {
              // Relative path - combine with baseUrl directory
              absoluteUrl = baseUrlPath + absoluteUrl;
            }
          }
          
          // Create proxy URL for the stream
          const proxyUrl = `/api/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}&videoId=${videoId}`;
          return `${tag}${proxyUrl}`;
        }
      )
      // Handle media URLs (for audio tracks, subtitles, etc.)
      .replace(
        /(#EXT-X-MEDIA[^:]*:.*URI=")([^"]+)(")/g,
        (match, prefix, url, suffix) => {
          // Skip URLs that are already going through our proxy
          if (url.trim().startsWith('/api/proxy')) return match;
          
          // Handle relative URLs
          let absoluteUrl = url.trim();
          if (!absoluteUrl.match(/^https?:\/\//)) {
            if (absoluteUrl.startsWith('/')) {
              // Absolute path
              absoluteUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${absoluteUrl}`;
            } else {
              // Relative path - combine with baseUrl directory
              absoluteUrl = baseUrlPath + absoluteUrl;
            }
          }
          
          // Create proper proxy URL based on file type
          const proxyUrl = absoluteUrl.includes('.m3u8') 
            ? `/api/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}&videoId=${videoId}`
            : `/api/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&videoId=${videoId}`;
          
          return `${prefix}${proxyUrl}${suffix}`;
        }
      )
      // Handle segment URLs (for media playlists)
      .replace(
        /^(#EXTINF:[^\n]*\n)([^#\n][^\n]*)/gm,
        (match, tag, url) => {
          // Skip URLs that are already going through our proxy
          if (url.trim().startsWith('/api/proxy')) return match;
          
          // Handle relative URLs
          let absoluteUrl = url.trim();
          if (!absoluteUrl.match(/^https?:\/\//)) {
            if (absoluteUrl.startsWith('/')) {
              // Absolute path
              absoluteUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${absoluteUrl}`;
            } else {
              // Relative path - combine with baseUrl directory
              absoluteUrl = baseUrlPath + absoluteUrl;
            }
          }
          
          // Create proxy URL for the segment
          const proxyUrl = `/api/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&videoId=${videoId}`;
          return `${tag}${proxyUrl}`;
        }
      )
      // Handle key URLs (for encrypted content)
      .replace(
        /(#EXT-X-KEY:[^,]*,URI=")([^"]+)(")/g,
        (match, prefix, url, suffix) => {
          // Skip URLs that are already going through our proxy
          if (url.trim().startsWith('/api/proxy')) return match;
          
          // Handle relative URLs
          let absoluteUrl = url.trim();
          if (!absoluteUrl.match(/^https?:\/\//)) {
            if (absoluteUrl.startsWith('/')) {
              // Absolute path
              absoluteUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${absoluteUrl}`;
            } else {
              // Relative path - combine with baseUrl directory
              absoluteUrl = baseUrlPath + absoluteUrl;
            }
          }
          
          // Create proxy URL for the key
          const proxyUrl = `/api/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&videoId=${videoId}`;
          return `${prefix}${proxyUrl}${suffix}`;
        }
      )
      // Handle map URLs (for initialization segments)
      .replace(
        /(#EXT-X-MAP:URI=")([^"]+)(")/g,
        (match, prefix, url, suffix) => {
          // Skip URLs that are already going through our proxy
          if (url.trim().startsWith('/api/proxy')) return match;
          
          // Handle relative URLs
          let absoluteUrl = url.trim();
          if (!absoluteUrl.match(/^https?:\/\//)) {
            if (absoluteUrl.startsWith('/')) {
              // Absolute path
              absoluteUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${absoluteUrl}`;
            } else {
              // Relative path - combine with baseUrl directory
              absoluteUrl = baseUrlPath + absoluteUrl;
            }
          }
          
          // Create proxy URL for the map
          const proxyUrl = `/api/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&videoId=${videoId}`;
          return `${prefix}${proxyUrl}${suffix}`;
        }
      )
      // Handle ByteRange URLs if present 
      .replace(
        /(#EXT-X-BYTERANGE:[^\n]*\n)([^#\n][^\n]*)/g, 
        (match, tag, url) => {
          // Skip URLs that are already going through our proxy
          if (url.trim().startsWith('/api/proxy')) return match;
          
          // Handle relative URLs
          let absoluteUrl = url.trim();
          if (!absoluteUrl.match(/^https?:\/\//)) {
            if (absoluteUrl.startsWith('/')) {
              // Absolute path
              absoluteUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${absoluteUrl}`;
            } else {
              // Relative path - combine with baseUrl directory
              absoluteUrl = baseUrlPath + absoluteUrl;
            }
          }
          
          // Create proxy URL for the segment
          const proxyUrl = `/api/proxy/segment?url=${encodeURIComponent(absoluteUrl)}&videoId=${videoId}`;
          return `${tag}${proxyUrl}`;
        }
      );

  } catch (error) {
    console.error(`Error processing M3U8 content: ${error.message}`);
    return content; // Return the original content if processing fails
  }
}

// Core function: Fetches the page and extracts video information
async function scrapeVideo(videoId) {
  if (!videoId) {
    throw new Error("Video ID is required");
  }

  try {
    const url = `https://zpjid.com/bkg/${videoId}?ref=animedub.pro`;
    console.log(`Fetching video data from: ${url}`);

    // First make a request to get cookies
    const cookieResponse = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: `https://animedub.pro/`,
        "Cache-Control": "no-cache",
      },
      maxRedirects: 5,
      withCredentials: true,
    });

    // Extract cookies from response
    const cookies = cookieResponse.headers['set-cookie'] || [];
    console.log(`Received cookies: ${cookies.length ? 'Yes' : 'No'}`);
    
    // Create the specific required cookie format
    const requiredCookies = [
      `file_id=43620805; path=/`,
      `aff=40302; path=/`,
      `ref_url=animedub.pro; path=/`,
      `lang=1; path=/`
    ];

    // Combine required cookies with any received cookies
    const allCookies = [...requiredCookies, ...cookies];
    const parsedCookies = parseCookies(allCookies);

    // Format cookies with the specific format needed
    let cookieHeader = `file_id=43620805; aff=40302; ref_url=animedub.pro; lang=1`;
    
    // Also keep any other cookies we might have received that could be important
    const originalCookies = cookies.map(cookie => cookie.split(';')[0]).join('; ');
    if (originalCookies) {
      cookieHeader = `${cookieHeader}; ${originalCookies}`;
    }
    
    // Create simplified cookie string for easier use
    const simpleCookieFormat = `file_id=43620805; aff=40302; ref_url=animedub.pro; lang=1`;
    
    // Now make the main request with the cookies
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: `https://zpjid.com/bkg/${videoId}`,
        "Cache-Control": "no-cache",
        "Cookie": cookieHeader
      },
      withCredentials: true,
    });

    // Create output directory if it doesn't exist
    const outputDir = path.join(process.cwd(), "output", videoId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save raw HTML for debugging
    fs.writeFileSync(path.join(outputDir, "raw.html"), response.data);
    
    // Save cookies information to a dedicated file
    fs.writeFileSync(
      path.join(outputDir, "cookies.json"),
      JSON.stringify({
        rawCookies: cookies,
        parsedCookies: parsedCookies,
        cookieHeader: cookieHeader,
        simpleCookieFormat: simpleCookieFormat
      }, null, 2)
    );

    // Load HTML with cheerio
    const $ = cheerio.load(response.data);

    // Find the script that contains the packed code
    let packedCode = "";
    $("script").each((i, script) => {
      const content = $(script).html() || "";
      if (
        content.includes("eval(function(p,a,c,k,e,d)") &&
        content.includes("jwplayer")
      ) {
        packedCode = content;
        return false; // Break the loop once we find our target
      }
    });

    if (!packedCode) {
      throw new Error("Could not find packed code in the page");
    }

    // Save packed code for reference
    fs.writeFileSync(path.join(outputDir, "packed.js"), packedCode);

    // Unpack the JavaScript
    console.log(`Unpacking obfuscated JavaScript...`);
    const unpackedCode = unPack(packedCode);

    // Save the unpacked code to a file for inspection
    fs.writeFileSync(path.join(outputDir, "unpacked.js"), unpackedCode);

    // Extract video information
    const videoInfo = extractVideoInfo(unpackedCode);
    
    // Store cookies in video info
    videoInfo.cookies = cookieHeader;
    videoInfo.rawCookies = cookies;
    videoInfo.parsedCookies = parsedCookies;
    videoInfo.simpleCookieFormat = simpleCookieFormat;

    // Save video info to JSON file
    fs.writeFileSync(
      path.join(outputDir, "info.json"),
      JSON.stringify(videoInfo, null, 2),
    );

    return videoInfo;
  } catch (error) {
    console.error(`Error scraping video: ${error.message}`);
    if (error.response) {
      console.error(`Status code: ${error.response.status}`);
    }
    throw error;
  }
}

// Function to download video
function downloadVideo(url, outputPath, cookies = '') {
  return new Promise((resolve, reject) => {
    console.log(`Starting download using FFmpeg...`);
    console.log(`URL: ${url}`);
    console.log(`Output: ${outputPath}`);
    console.log(`Using cookies: ${cookies ? 'Yes' : 'No'}`);

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Prepare FFmpeg arguments
    const ffmpegArgs = [
      '-headers', `Cookie: ${cookies}\r\nReferer: https://zpjid.com/\r\n`,
      '-i', url,
      '-c', 'copy', // Copy without re-encoding
      '-bsf:a', 'aac_adtstoasc',
      outputPath
    ];

    // Start download with FFmpeg
    const download = spawn('ffmpeg', ffmpegArgs);

    // Track progress (simplified for API)
    let progressData = {
      progress: 0,
      status: "downloading",
    };

    download.stderr.on("data", (data) => {
      const output = data.toString();

      // Extract duration
      const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch && !progressData.duration) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        progressData.duration = hours * 3600 + minutes * 60 + seconds;
      }

      // Extract progress
      const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseFloat(timeMatch[3]);
        const currentTime = hours * 3600 + minutes * 60 + seconds;

        // Calculate percentage
        if (progressData.duration) {
          progressData.progress = Math.round(
            (currentTime / progressData.duration) * 100,
          );
          progressData.currentTime = currentTime;
        }
      }
    });

    download.on("close", (code) => {
      if (code === 0) {
        progressData.status = "completed";
        progressData.progress = 100;
        resolve(progressData);
      } else {
        progressData.status = "failed";
        progressData.error = `FFmpeg process exited with code ${code}`;
        reject(progressData);
      }
    });

    download.on("error", (err) => {
      progressData.status = "failed";
      progressData.error = err.message;
      reject(progressData);
    });
  });
}

// Function to get the best playback URL for a video
function getPlaybackUrl(videoInfo, sourceIndex = 0) {
  if (!videoInfo || !videoInfo.sources || videoInfo.sources.length === 0) {
    return null;
  }
  
  const source = videoInfo.sources[sourceIndex];
  
  // Always prefer the proxy URL for reliability
  if (source.proxyUrl) {
    return source.proxyUrl;
  }
  
  return source.file;
}

// Function to fetch segment content with proper headers
async function fetchSegment(url, cookies, referer) {
  try {
    console.log(`Fetching segment from: ${url}`);
    
    // Parse URL to extract hostname for proper headers
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // Create headers with necessary authentication
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.5",
      "Origin": `https://${hostname}`,
      "Referer": referer || `https://${hostname}/`,
      "Connection": "keep-alive",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    };
    
    // Add cookies if provided
    if (cookies) {
      headers["Cookie"] = cookies;
    }
    
    // Make the request
    const response = await axios.get(url, {
      headers,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      withCredentials: true,
      timeout: 10000 // 10 second timeout
    });
    
    return response.data;
  } catch (error) {
    console.error(`Error fetching segment: ${error.message}`);
    if (error.response) {
      console.error(`Status code: ${error.response.status}`);
    }
    throw error;
  }
}

// API Endpoints

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Video Scraper API is running" });
});

// Get video information
app.get("/api/videos/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    const videoInfo = await scrapeVideo(videoId);
    res.json({
      success: true,
      data: videoInfo,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get cookies for a specific video
app.get("/api/videos/:videoId/cookies", (req, res) => {
  try {
    const { videoId } = req.params;
    const cookiePath = path.join(process.cwd(), "output", videoId, "cookies.json");
    
    if (!fs.existsSync(cookiePath)) {
      // If cookies file doesn't exist, try to fetch info first
      return res.status(404).json({
        success: false,
        error: "Cookies not found. Try fetching video info first.",
        message: "Use GET /api/videos/:videoId to fetch video info including cookies"
      });
    }
    
    // Read cookies from file
    const cookiesData = JSON.parse(fs.readFileSync(cookiePath, "utf8"));
    
    res.json({
      success: true,
      data: cookiesData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Proxy M3U8 content with proper authentication
// Proxy M3U8 content with proper authentication

    
    // Default referer based on hostname or use the one provided
    const urlObj = new URL(url);
    const referer = req.query.referer || `https://${urlObj.hostname}/`;
    
    // Log request for debugging
    console.log(`M3U8 proxy request for: ${url}`);
    console.log(`With videoId: ${videoId || 'none'}`);
    
    // Fetch the M3U8 content
    const m3u8Content = await fetchM3u8Content(url, cookies, referer);
    
    // Log a small sample of content for debugging (first few lines)
    const contentSample = m3u8Content.split('\n').slice(0, 5).join('\n');
    console.log(`M3U8 content sample: \n${contentSample}...`);
    
    // Process the content to rewrite all URLs to go through our proxy
    const processedContent = processM3u8Content(m3u8Content, url, videoId);
    
    // Set appropriate headers for M3U8 content
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');  // For CORS
    res.set('Cache-Control', 'no-cache');  // Prevent caching of potentially changing playlists
    
    // Send the processed content
    res.send(processedContent);
    
  } catch (error) {
    console.error(`M3U8 proxy error:`, error);
    
    // Return a properly formatted error
    res.status(500).json({
      success: false,
      error: error.message || "Unknown error occurred",
      details: {
        url: req.query.url,
        videoId: req.query.videoId,
        stack: error.stack 
      }
    });
  }
});
    
    // Default referer based on hostname or use the one provided
    const urlObj = new URL(url);
    const referer = req.query.referer || `https://${urlObj.hostname}/`;
    
    // Fetch the M3U8 content
    const m3u8Content = await fetchM3u8Content(url, cookies, referer);
    
    // Process the content to rewrite all URLs to go through our proxy
    const processedContent = processM3u8Content(m3u8Content, url, videoId);
    
    // Set appropriate headers for M3U8 content
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(processedContent);
    
  } catch (error) {
    console.error(`M3U8 proxy error:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Proxy for video segments and other resources (audio, subtitles, keys)
app.get("/api/proxy/segment", async (req, res) => {
  try {
    const { url, videoId } = req.query;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: "URL parameter is required"
      });
    }
    
    // Get cookies either from query or from stored video info
    let cookies = req.query.cookies;
    
    if (!cookies && videoId) {
      try {
        const infoPath = path.join(process.cwd(), "output", videoId, "info.json");
        if (fs.existsSync(infoPath)) {
          const videoInfo = JSON.parse(fs.readFileSync(infoPath, "utf8"));
          cookies = videoInfo.simpleCookieFormat || videoInfo.cookies;
        }
      } catch (error) {
        console.error(`Error retrieving cookies for videoId ${videoId}: ${error.message}`);
      }
    }
    
    // Default referer based on hostname
    const urlObj = new URL(url);
    const referer = req.query.referer || `https://${urlObj.hostname}/`;
    
    // Create headers with necessary authentication
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.5",
      "Origin": `https://${urlObj.hostname}`,
      "Referer": referer,
      "Connection": "keep-alive",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    };
    
    // Add cookies if provided
    if (cookies) {
      headers["Cookie"] = cookies;
    }
    
    // Log request details for debugging
    console.log(`Proxying resource: ${url}`);
    console.log(`With cookies: ${cookies ? 'Yes' : 'No'}`);
    
    // Check if it's an M3U8 file (could be a child playlist)
    if (url.includes('.m3u8')) {
      // Fetch the M3U8 content
      const response = await axios.get(url, {
        headers,
        maxRedirects: 5,
        withCredentials: true,
        timeout: 10000 // 10 second timeout
      });
      
      // Process the content to rewrite URLs
      const processedContent = processM3u8Content(response.data, url, videoId);
      
      // Send as M3U8
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(processedContent);
    } else {
      // For other resources (segments, keys, etc.), pass through as binary data
      const response = await axios.get(url, {
        headers,
        responseType: 'arraybuffer',
        maxRedirects: 5,
        withCredentials: true,
        timeout: 10000 // 10 second timeout
      });
      
      // Determine content type based on extension
      const extension = url.split('.').pop().split('?')[0].toLowerCase();
      let contentType = 'application/octet-stream'; // Default
      
      if (extension === 'ts') {
        contentType = 'video/MP2T';
      } else if (extension === 'mp4' || extension === 'm4s' || extension === 'mp4a') {
        contentType = 'video/mp4';
      } else if (extension === 'vtt') {
        contentType = 'text/vtt';
      } else if (extension === 'srt') {
        contentType = 'text/srt';
      } else if (extension === 'key') {
        contentType = 'application/octet-stream';
      }
      
      // Set appropriate CORS headers
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      
      // Set content type and send data
      res.set('Content-Type', contentType);
      res.send(response.data);
    }
    
  } catch (error) {
    console.error(`Segment proxy error:`, error);
    if (error.response) {
      console.error(`Status code: ${error.response.status}`);
      console.error(`Headers: ${JSON.stringify(error.response.headers)}`);
    }
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Start download
app.post("/api/videos/:videoId/download", async (req, res) => {
  try {
    const { videoId } = req.params;
    const { sourceIndex = 0 } = req.body;

    // First get the video info
    const videoInfo = await scrapeVideo(videoId);

    if (!videoInfo || !videoInfo.sources || videoInfo.sources.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No video sources found",
      });
    }

    // Get the source to download
    const source = videoInfo.sources[sourceIndex];
    if (!source) {
      return res.status(400).json({
        success: false,
        error: `Source index ${sourceIndex} not found`,
      });
    }

    // Create filename
    const fileName = videoInfo.title
      ? `${videoInfo.title}.mp4`
      : `${videoInfo.videoId || "video"}.mp4`;

    const outputPath = path.join(process.cwd(), "output", videoId, fileName);

    // Start the download (non-blocking)
    downloadVideo(source.file, outputPath, videoInfo.simpleCookieFormat || videoInfo.cookies)
      .then(() => {
        console.log(`Download of ${fileName} completed`);
      })
      .catch((error) => {
        console.error(`Download error: ${error.message || error}`);
      });

    // Return immediate response with download details
    res.json({
      success: true,
      message: "Download started",
      data: {
        videoId,
        title: videoInfo.title,
        fileName,
        downloadUrl: `/downloads/${videoId}/${fileName}`,
        statusUrl: `/api/videos/${videoId}/download/status`,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Check download status
app.get("/api/videos/:videoId/download/status", (req, res) => {
  const { videoId } = req.params;
  const outputDir = path.join(process.cwd(), "output", videoId);

  // Check if directory exists
  if (!fs.existsSync(outputDir)) {
    return res.json({
      success: true,
      status: "not_started",
      message: "Download has not been started",
    });
  }

  // Read directory for MP4 files
  try {
    const files = fs
      .readdirSync(outputDir)
      .filter((file) => file.endsWith(".mp4"));

    if (files.length === 0) {
      return res.json({
        success: true,
        status: "in_progress",
        message: "Download in progress, no files completed yet",
      });
    }

    // Check file sizes to determine if download is complete
    const fileDetails = files.map((file) => {
      const filePath = path.join(outputDir, file);
      const stats = fs.statSync(filePath);
      return {
        fileName: file,
        size: stats.size,
        downloadUrl: `/downloads/${videoId}/${file}`,
        lastModified: stats.mtime,
      };
    });

    return res.json({
      success: true,
      status: "completed",
      message: "Download completed",
      files: fileDetails,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// List all downloaded videos
app.get("/api/videos", (req, res) => {
  try {
    const outputDir = path.join(process.cwd(), "output");

    // Check if output directory exists
    if (!fs.existsSync(outputDir)) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Read all directories (each is a video ID)
    const videoDirs = fs
      .readdirSync(outputDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    // Get info for each video
    const videos = videoDirs.map((videoId) => {
      const videoDir = path.join(outputDir, videoId);
      const infoPath = path.join(videoDir, "info.json");
      const cookiePath = path.join(videoDir, "cookies.json");

      if (fs.existsSync(infoPath)) {
        try {
          const videoInfo = JSON.parse(fs.readFileSync(infoPath, "utf8"));
          const hasCookies = fs.existsSync(cookiePath);

          // Check for downloaded files
          const mp4Files = fs
            .readdirSync(videoDir)
            .filter((file) => file.endsWith(".mp4"))
            .map((file) => ({
              fileName: file,
              downloadUrl: `/downloads/${videoId}/${file}`,
            }));

          return {
            videoId,
            title: videoInfo.title,
            thumbnailUrl: videoInfo.thumbnailUrl,
            downloaded: mp4Files.length > 0,
            files: mp4Files,
            hasCookies: hasCookies,
            cookiesUrl: hasCookies ? `/api/videos/${videoId}/cookies` : null
          };
        } catch (e) {
          return { videoId, error: e.message };
        }
      } else {
        return { videoId, status: "incomplete" };
      }
    });

    res.json({
      success: true,
      count: videos.length,
      data: videos,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Delete a downloaded video
app.delete("/api/videos/:videoId", (req, res) => {
  try {
    const { videoId } = req.params;
    const videoDir = path.join(process.cwd(), "output", videoId);

    if (!fs.existsSync(videoDir)) {
      return res.status(404).json({
        success: false,
        error: "Video not found",
      });
    }

    // Recursively delete the directory
    fs.rmSync(videoDir, { recursive: true, force: true });

    res.json({
      success: true,
      message: `Video ${videoId} deleted successfully`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Serve API documentation
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Video Scraper API</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { color: #2c3e50; }
        h2 { color: #3498db; margin-top: 30px; }
        pre { background-color: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; }
        code { font-family: Consolas, Monaco, 'Andale Mono', monospace; }
        .endpoint { background-color: #e8f4fc; padding: 10px; border-left: 5px solid #3498db; margin-bottom: 20px; }
        .method { font-weight: bold; background-color: #3498db; color: white; padding: 3px 8px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <h1>Video Scraper API</h1>
      <p>A RESTful API for scraping and downloading videos.</p>

      <h2>API Endpoints</h2>

      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/health</code></p>
        <p>Check if the API is running.</p>
        <pre><code>curl http://localhost:3000/api/health</code></pre>
      </div>

      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/videos/:videoId</code></p>
        <p>Get information about a video.</p>
        <pre><code>curl http://localhost:3000/api/videos/9q4yh8ji5k4w</code></pre>
      </div>
      
      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/videos/:videoId/cookies</code></p>
        <p>Get cookies for a specific video.</p>
        <pre><code>curl http://localhost:3000/api/videos/9q4yh8ji5k4w/cookies</code></pre>
      </div>

      <div class="endpoint">
        <p><span class="method">POST</span> <code>/api/videos/:videoId/download</code></p>
        <p>Start downloading a video.</p>
        <pre><code>curl -X POST -H "Content-Type: application/json" -d '{"sourceIndex": 0}' http://localhost:3000/api/videos/9q4yh8ji5k4w/download</code></pre>
      </div>

      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/videos/:videoId/download/status</code></p>
        <p>Check the status of a video download.</p>
        <pre><code>curl http://localhost:3000/api/videos/9q4yh8ji5k4w/download/status</code></pre>
      </div>

      <div class="endpoint">
        <p><span class="method">GET</span> <code>/api/videos</code></p>
        <p>List all downloaded videos.</p>
        <pre><code>curl http://localhost:3000/api/videos</code></pre>
      </div>

      <div class="endpoint">
        <p><span class="method">DELETE</span> <code>/api/videos/:videoId</code></p>
        <p>Delete a downloaded video.</p>
        <pre><code>curl -X DELETE http://localhost:3000/api/videos/9q4yh8ji5k4w</code></pre>
      </div>

      <h2>Getting Started</h2>
      <p>To use this API:</p>
      <ol>
        <li>Find a video ID you want to scrape</li>
        <li>Get video information using the GET endpoint</li>
        <li>Start a download using the POST endpoint</li>
        <li>Check download status and access the file when complete</li>
      </ol>

      <p>All downloaded videos are accessible at <code>/downloads/:videoId/:fileName</code></p>
    </body>
    </html>
  `);
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: err.message || "Something went wrong",
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Video Scraper API running on port ${PORT}`);
});

// Export for testing or modularity
module.exports = app;

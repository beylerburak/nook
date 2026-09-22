const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3333;
const DATA_DIR = path.resolve(__dirname, "../../data");
const DATA_FILE = path.join(DATA_DIR, "bookmarks.json");

// Ensure data directory and file exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ items: [], lists: [] }, null, 2), "utf-8");
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return { items: data, lists: [] };
    }
    return {
      items: Array.isArray(data.items) ? data.items : [],
      lists: Array.isArray(data.lists) ? data.lists : []
    };
  } catch (err) {
    console.error("[Nook Server] Error reading data:", err.message);
    return { items: [], lists: [] };
  }
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error("[Nook Server] Error writing data:", err.message);
    return false;
  }
}

function isAllowedOrigin(origin) {
  // Only allow requests from Chrome extensions
  if (typeof origin !== "string") return false;
  if (process.env.NOOK_EXTENSION_ID) {
    // Restrict to a single, known extension id when configured
    return origin === `chrome-extension://${process.env.NOOK_EXTENSION_ID}`;
  }
  return origin.startsWith("chrome-extension://");
}

function isAllowedHost(host) {
  // Only allow requests addressed directly to this loopback server.
  // Prevents DNS-rebinding attacks where a public domain resolves to
  // 127.0.0.1 and the browser sends no Origin header (e.g. plain GETs).
  const port = String(PORT);
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`
  ]);
  return typeof host === "string" && allowedHosts.has(host);
}

function setCorsHeaders(res, origin) {
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const server = http.createServer((req, res) => {
  const origin = req.headers["origin"];

  // Reject requests not addressed to this loopback server (DNS-rebinding protection)
  if (!isAllowedHost(req.headers["host"])) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden: Host not allowed" }));
    return;
  }

  // Reject any browser request from untrusted origins (CSRF protection)
  if (origin && !isAllowedOrigin(origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden: Origin not allowed" }));
    return;
  }

  setCorsHeaders(res, origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
    return;
  }

  // GET /api/bookmarks
  if (req.method === "GET" && url.pathname === "/api/bookmarks") {
    const data = readData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  // POST /api/bookmarks (saves single item, array, or { items, lists })
  if (req.method === "POST" && url.pathname === "/api/bookmarks") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const data = readData();

        // 1. Handle items
        const incomingItems = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.items)
          ? payload.items
          : payload.id
          ? [payload]
          : [];

        const itemMap = new Map();
        for (const item of data.items) {
          if (item?.id) itemMap.set(item.id, item);
        }
        for (const item of incomingItems) {
          if (item?.id) {
            itemMap.set(item.id, { ...itemMap.get(item.id), ...item });
          }
        }
        const mergedItems = Array.from(itemMap.values());
        mergedItems.sort((a, b) => {
          const tA = new Date(a.savedAt || a.createdAt || 0).getTime();
          const tB = new Date(b.savedAt || b.createdAt || 0).getTime();
          return tB - tA;
        });
        data.items = mergedItems;

        // 2. Handle lists if provided in payload
        if (Array.isArray(payload.lists)) {
          const listMap = new Map();
          for (const list of data.lists) {
            if (list?.id) listMap.set(list.id, list);
          }
          for (const list of payload.lists) {
            if (list?.id) {
              listMap.set(list.id, { ...listMap.get(list.id), ...list });
            }
          }
          data.lists = Array.from(listMap.values());
        }

        writeData(data);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            itemCount: data.items.length,
            listCount: data.lists.length
          })
        );
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON: " + err.message }));
      }
    });
    return;
  }

  // POST /api/lists (create or update list)
  if (req.method === "POST" && url.pathname === "/api/lists") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const list = JSON.parse(body);
        if (!list || !list.id || !list.name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "List must have id and name" }));
          return;
        }

        const data = readData();
        const existingIdx = data.lists.findIndex((l) => l.id === list.id);
        if (existingIdx >= 0) {
          data.lists[existingIdx] = { ...data.lists[existingIdx], ...list };
        } else {
          data.lists.push(list);
        }

        writeData(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, list }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON: " + err.message }));
      }
    });
    return;
  }

  // DELETE /api/lists/:id
  if (req.method === "DELETE" && url.pathname.startsWith("/api/lists/")) {
    const listId = decodeURIComponent(url.pathname.replace("/api/lists/", ""));
    const data = readData();
    data.lists = data.lists.filter((l) => l.id !== listId);

    // Unassign listId from items
    for (const item of data.items) {
      if (item.listId === listId) {
        item.listId = null;
        item.listName = null;
      }
    }

    writeData(data);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, listCount: data.lists.length }));
    return;
  }

  // DELETE /api/bookmarks/:id
  if (req.method === "DELETE" && url.pathname.startsWith("/api/bookmarks/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/bookmarks/", ""));
    const data = readData();
    data.items = data.items.filter((item) => item.id !== id);
    writeData(data);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, count: data.items.length }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Nook Server] Running at http://127.0.0.1:${PORT} (localhost only)`);
  console.log(`[Nook Server] Saving bookmarks & lists to: ${DATA_FILE}`);
});

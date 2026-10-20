#!/usr/bin/env node
// MCP server (stdio) with Local Desktop device tools. Used by .mcp.json / .cursor/mcp.json.
"use strict";
require("./launcher-lib.cjs").run("mcp", "LOCALDESKTOP_MCP_JS");

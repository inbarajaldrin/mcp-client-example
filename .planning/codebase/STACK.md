# Technology Stack

**Analysis Date:** 2026-05-02

## Languages

**Primary:**
- TypeScript 5.7.2 - All source code, CLI, API, web server, and providers

**Secondary:**
- Python - MCP servers (external, not in main codebase)
- JavaScript - Node.js runtime environment

## Runtime

**Environment:**
- Node.js (no version constraint specified in .nvmrc; defaults to system Node)

**Package Manager:**
- npm (Node Package Manager)
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- @modelcontextprotocol/sdk 1.25.2 - MCP protocol implementation for stdio-based MCP server communication
- express 5.2.1 - Web server and REST API framework for web UI backend
- react 19.2.4 - Web UI frontend framework
- react-dom 19.2.4 - React DOM rendering

**Testing:**
- No test framework detected (no jest.config, vitest.config, or test files)

**Build/Dev:**
- Vite 7.3.1 - Frontend build bundler (web/frontend)
- @vitejs/plugin-react 5.1.4 - React plugin for Vite
- tsc-watch 6.2.1 - TypeScript compiler with watch mode
- TypeScript 5.7.2 - Language and compiler
- Prettier 3.4.1 - Code formatting

## Key Dependencies

**Critical:**
- @anthropic-ai/sdk 0.32.1 - Anthropic Claude API client
- openai 6.9.0 - OpenAI GPT API client
- @google/genai 1.34.0 - Google Gemini API client
- ollama 0.6.3 - Local Ollama model API client
- tiktoken 1.0.22 - Token counting for OpenAI models (cl100k_base encoding)

**Infrastructure:**
- multer 2.0.2 - File upload middleware for Express (used by `/api` routes)
- dotenv 16.4.7 - Environment variable loading from `.env` files
- yaml 2.8.2 - YAML parsing (for MCP config files and ablation definitions)
- zod 3.24.1 - Schema validation (validation library, not TypeScript-only)
- chalk 5.3.0 - Colored console output for CLI
- @types/express 5.0.6 - TypeScript types for Express
- @types/multer 2.0.0 - TypeScript types for multer
- @types/node 22.10.2 - TypeScript types for Node.js APIs
- @types/react 19.2.14 - TypeScript types for React
- @types/react-dom 19.2.3 - TypeScript types for React DOM
- bun 1.1.38 - JavaScript runtime (listed as devDependency, appears to be exploratory)

## Configuration

**Environment:**
- Loaded from `.env` file (location: project root)
- Uses dotenv 16.4.7 in `src/bin.ts` with resolve path to project `.env`
- Environment variables include API keys (see INTEGRATIONS.md)

**Build:**
- `tsconfig.json` - TypeScript compiler configuration
  - Target: ES2022
  - Module system: Node16 (ESM)
  - Strict mode enabled
  - Root directory: `src/`
  - Output directory: `dist/`

**Development:**
- `.prettierrc` - Code formatting configuration (if present)
- npm scripts in `package.json` for build, watch, format

## Platform Requirements

**Development:**
- Node.js (any recent version)
- npm (comes with Node.js)
- Python with venv (for running MCP servers like Isaac Sim, ROS2, etc.)

**Production:**
- Node.js runtime
- At least one LLM API key (Anthropic, OpenAI, Google, xAI, or local Ollama)
- MCP server processes running separately (stdio-based)

## Build & Run Commands

```bash
npm install                          # Install dependencies
npm run build                        # TypeScript compile + Vite build web frontend
npm run build:web                    # Build frontend only (Vite)
npm run watch                        # Watch mode for TypeScript + chmod binaries
npm run format                       # Format code with Prettier
npm start                            # Run compiled CLI from dist/bin.js
```

## Output

- Compiled output: `dist/` directory
- Web frontend dist: `dist/web/frontend/dist/`
- Binary entry point: `dist/bin.js` (marked executable via chmod 755)
- NPM package binary: `mcp-client` (defined in `package.json` bin field)

---

*Stack analysis: 2026-05-02*

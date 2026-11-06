# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

### Installation

```
$ pnpm install
```

### Local Development

```
$ pnpm start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

### Bear War

The home page embeds the game from `bear-war/`. Its build lives in `static/bear-war/` (gitignored), so build it once, and again after changing the game:

```
$ cd bear-war && npm ci && npm run build -- --outDir ../static/bear-war --emptyOutDir
```

### Build

```
$ pnpm build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

### Deployment

Changes to the main branch are automatically deployed to GitHub Pages by GitHub Actions.

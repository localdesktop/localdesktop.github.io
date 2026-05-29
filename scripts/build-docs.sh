#!/usr/bin/env bash
#
# build-docs.sh — Build offline-readable PDFs of Local Desktop into manuals/.
#
# Two manuals, selected by the first word:
#
#   developer  (default)  Everything: the README, the full gh-pages user +
#                         developer guides and blog, and an architecture
#                         walkthrough of the code. Book-like (serif, parts).
#   user                  Just the gh-pages *user* guide, styled to feel like the
#                         localdesktop.github.io website (sans body, teal accents).
#
# Extra knobs (words, any order):
#   curated (default) | callgraph   — architecture section, developer manual only
#   normal  (default) | compact     — compact = near-square page for a foldable
#   light   (default) | dark        — page theme, user manual only
#
#   bash scripts/build-docs.sh                       # developer, curated, normal
#   bash scripts/build-docs.sh callgraph compact     # developer, call-graph, compact
#   bash scripts/build-docs.sh user                  # user manual, light
#   bash scripts/build-docs.sh user dark             # user manual, dark theme
#   bash scripts/build-docs.sh user dark compact     # user manual, dark, compact
#   bash scripts/build-docs.sh all                   # purge manuals/ + rebuild every variant
#
# The user manual covers the gh-pages user guide *and* the blog.
#
# Always current: the developer manual's code is pulled fresh from source on every
# build (see scripts/docs.py). Renders with the local pandoc + xelatex if present
# (the macOS dev box has MacTeX), else a Dockerized pandoc. No Makefile — this
# slots in next to the other scripts/*.sh. Outputs are gitignored under manuals/.
#
set -euo pipefail
cd "$(dirname "$0")/.."

MANUAL=developer
MODE=curated
SIZE=normal
THEME=light
ALL=0
for arg in "$@"; do
	case "$arg" in
		all) ALL=1 ;;
		developer | user) MANUAL="$arg" ;;
		curated | callgraph) MODE="$arg" ;;
		normal) SIZE=normal ;;
		compact | phone | foldable) SIZE=compact ;;
		light | dark) THEME="$arg" ;;
		*) echo "Ignoring unknown argument '$arg'." >&2 ;;
	esac
done
if [ "$THEME" = dark ] && [ "$MANUAL" != user ]; then
	echo "Note: 'dark' only styles the user manual; ignoring for the developer manual." >&2
	THEME=light
fi

OUTDIR="manuals"

# `all`: wipe the output folder and regenerate every variant in one run, so the
# folder only ever holds the latest build. Each variant is a normal sub-invocation.
if [ "$ALL" = 1 ]; then
	rm -rf "$OUTDIR"
	mkdir -p "$OUTDIR"
	for variant in "" "callgraph" "compact" "callgraph compact" \
		"user" "user compact" "user dark" "user dark compact"; do
		bash scripts/build-docs.sh $variant
	done
	echo "✓ Purged $OUTDIR/ and rebuilt all $(ls "$OUTDIR" | wc -l | tr -d ' ') manuals."
	exit 0
fi

mkdir -p "$OUTDIR"
# Nice filenames: "Local Desktop - <Manual> [(<Qualifier>, …)].pdf", qualifiers in
# Title Case, joined into a single parenthetical.
QUALS=()
if [ "$MANUAL" = user ]; then
	OUT="$OUTDIR/Local Desktop - User Manual"
	[ "$THEME" = dark ] && QUALS+=("Dark")
else
	OUT="$OUTDIR/Local Desktop - Developer Manual"
	[ "$MODE" = callgraph ] && QUALS+=("Call Graph")
fi
[ "$SIZE" = compact ] && QUALS+=("Compact")
if [ ${#QUALS[@]} -gt 0 ]; then
	joined=$(printf ', %s' "${QUALS[@]}"); OUT="$OUT (${joined:2})"
fi
OUT="$OUT.pdf"

VERSION="$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)"
DATE="$(date -u '+%Y-%m-%d %H:%M UTC')"
BUILD="build/docs"
DOC="$BUILD/docs.md"
HEADER="$BUILD/header.tex"
FONTS="$BUILD/fonts"
TEXDIR="$BUILD/tex"
IMGOUT="$BUILD/img"
PY="python3 scripts/docs.py"
mkdir -p "$BUILD" "$FONTS" "$TEXDIR" "$IMGOUT"

# Let `docs.py clean` embed gh-pages images: resolve Docusaurus `/img/...` against
# the static root and cache size-capped PNGs (webp converted via dwebp/sips) here.
export DOCS_STATIC="$PWD/gh-pages/static"
export DOCS_IMGOUT="$PWD/$IMGOUT"

part() { printf '\n\n```{=latex}\n\\part{%s}\n```\n\n' "$1"; }
newpage() { printf '\n\n```{=latex}\n\\newpage\n```\n\n'; }

# --- Assemble the combined Markdown -------------------------------------------
if [ "$MANUAL" = user ]; then
	{
		cat <<-YAML
		---
		title: "Local Desktop — User Manual"
		subtitle: "Running Linux on Android · v$VERSION · generated $DATE"
		---
		YAML
		# The gh-pages *user* guide, in sidebar order. No parts: each topic is a
		# top-level section, like a page on the website.
		first=1
		for d in gh-pages/docs/user/*.md gh-pages/docs/user/app-compatibility/*.md; do
			[ -f "$d" ] || continue
			[ "$first" = 1 ] || newpage
			first=0
			$PY clean "$d"
		done
		# Then the blog, newest first, nested one level under a "Blog" section
		# (DOCS_HSHIFT demotes each post's headings so they sit under it).
		newpage
		printf '# Blog\n'
		for d in $(printf '%s\n' gh-pages/blog/*.md | sort -r); do
			[ -f "$d" ] || continue
			newpage
			DOCS_HSHIFT=1 $PY clean "$d"
		done
	} >"$DOC"
else
	{
		cat <<-YAML
		---
		title: "Local Desktop — Developer Manual"
		subtitle: "v$VERSION · $MODE architecture · $SIZE page · generated $DATE"
		---
		YAML

		# Part I — the project README (images → alt text; the hero shots are webp,
		# which pandoc can't embed into a PDF).
		part "Local Desktop"
		$PY clean README.md

		# Part II — the gh-pages site: user guide, developer guide, then the blog.
		# Globs are ordered so the numeric sidebar prefixes (1-, 2-, …) sort naturally.
		part "Documentation"
		for d in \
			gh-pages/docs/user/*.md \
			gh-pages/docs/user/app-compatibility/*.md \
			gh-pages/docs/developer/*.md \
			gh-pages/docs/developer/bug-cheat-sheet/*.md; do
			[ -f "$d" ] || continue
			newpage
			$PY clean "$d"
		done
		part "Blog"
		for d in gh-pages/blog/*.md; do
			[ -f "$d" ] || continue
			newpage
			$PY clean "$d"
		done

		# Part IV — the architecture walkthrough. Curated expands the hand-written
		# spine; callgraph emits chapters straight from the call-graph walk.
		if [ "$MODE" = callgraph ]; then
			part "Architecture — Generated Call Graph"
			$PY callgraph
		else
			part "Architecture — A Guided Call Stack"
			$PY expand docs/architecture.md
		fi
	} >"$DOC"
fi

# --- Theme palette (user manual) — mirrors the website's light/dark tokens ----
# accent (--ld-accent) · ink (--ld-ink) · code background · page background.
HLSTYLE=tango
if [ "$THEME" = dark ]; then
	ACCENT=2DD4BF; INK=E8EDF5; CODEBG=0E2622; PAGEBG=071018; HLSTYLE=breezedark
else
	ACCENT=0D9488; INK=0F172A; CODEBG=E6F4F2; PAGEBG=
fi

# Cover logo (user manual): recolour the brand mark to the theme's ink on a
# transparent background, then a raw-LaTeX cover inserted above the title block.
COVER=""
if [ "$MANUAL" = user ] && \
	python3 scripts/docs.py logo gh-pages/static/img/logo.png "$BUILD/cover-logo.png" "$INK" 2>/dev/null; then
	printf '\\vspace*{1.2cm}\\begin{center}\\includegraphics[width=0.4\\linewidth]{%s}\\end{center}\\vspace{0.6em}\n' \
		"$BUILD/cover-logo.png" >"$BUILD/cover.tex"
	COVER="$BUILD/cover.tex"
fi

# --- LaTeX header -------------------------------------------------------------
# Common: wrap long code lines (fvextra) so nothing overflows the page.
{
	cat <<-'TEX'
	\usepackage{fvextra}
	\DefineVerbatimEnvironment{Highlighting}{Verbatim}{breaklines,breakanywhere,fontsize=\small,commandchars=\\\{\}}
	\usepackage{microtype}
	\usepackage{xcolor}
	\usepackage{graphicx}
	% Fit every image inside the text block, keeping aspect — bounds both wide
	% screenshots and tall portrait phone captures.
	\setkeys{Gin}{width=\linewidth,height=0.82\textheight,keepaspectratio}
	% Roomier padding inside code blocks (snugshade colours via \fboxsep).
	\setlength{\fboxsep}{7pt}
	% Cleaner page breaks: never strand a heading's first/last line, and don't
	% stretch short pages to the bottom.
	\widowpenalty=10000
	\clubpenalty=10000
	\raggedbottom
	TEX
	# The user manual is dressed in the website's palette: teal accents, ink body
	# text, a tinted code background — light or dark per $THEME.
	if [ "$MANUAL" = user ]; then
		cat <<-TEX
		\definecolor{ldaccent}{HTML}{$ACCENT}
		\definecolor{ldink}{HTML}{$INK}
		\definecolor{shadecolor}{HTML}{$CODEBG}
		TEX
		# Dark theme: paint the page and flip default text to ink (light).
		[ -n "$PAGEBG" ] && printf '\\definecolor{ldbg}{HTML}{%s}\n\\pagecolor{ldbg}\n' "$PAGEBG"
		cat <<-'TEX'
		\usepackage{titlesec}
		\titleformat{\section}{\Large\bfseries\color{ldaccent}}{\thesection}{0.6em}{}
		\titleformat{\subsection}{\large\bfseries\color{ldink}}{\thesubsection}{0.6em}{}
		\titleformat{\subsubsection}{\bfseries\color{ldink}}{\thesubsubsection}{0.6em}{}
		\AtBeginDocument{\color{ldink}}
		TEX
	fi
} >"$HEADER"

# --- Vendor LaTeX styles BasicTeX omits, best-effort --------------------------
# pandoc's highlighting pulls in framed.sty (the `Shaded` wrapper); we use
# fvextra.sty for code wrapping; the user manual uses titlesec.sty for coloured
# headings. None ship with BasicTeX and tlmgr needs sudo, so drop single-file
# copies beside the build and point TEXINPUTS at them. (Docker's TeX has them all.)
CTAN="https://mirrors.ctan.org/macros/latex/contrib"
fetch_sty() {  # $1=name  $2=ctan-subpath-to-ready-.sty
	[ -f "$TEXDIR/$1" ] && return
	kpsewhich "$1" >/dev/null 2>&1 && return
	curl -fsSL "$CTAN/$2" -o "$TEXDIR/$1" 2>/dev/null || true
}
fetch_sty framed.sty framed/framed.sty
fetch_sty titlesec.sty titlesec/titlesec.sty
if [ ! -f "$TEXDIR/fvextra.sty" ] && ! kpsewhich fvextra.sty >/dev/null 2>&1; then
	# fvextra ships only .dtx/.ins, so generate the .sty.
	curl -fsSL "$CTAN/fvextra/fvextra.dtx" -o "$TEXDIR/fvextra.dtx" 2>/dev/null &&
		curl -fsSL "$CTAN/fvextra/fvextra.ins" -o "$TEXDIR/fvextra.ins" 2>/dev/null &&
		(cd "$TEXDIR" && tex -interaction=batchmode fvextra.ins >/dev/null 2>&1) || true
fi
export TEXINPUTS="$PWD/$TEXDIR:${TEXINPUTS:-}"

# --- Vendor the body font (OFL), best-effort ----------------------------------
# Developer manual: Cardo (a book serif). User manual: Lato (a clean web sans, in
# the spirit of the site's system-ui stack). Loaded by path so we don't depend on
# the font being installed; if offline and uncached we fall back to the default.
if [ "$MANUAL" = user ]; then FAMILY=Lato; SUBDIR=lato; else FAMILY=Cardo; SUBDIR=cardo; fi
GFONTS="https://raw.githubusercontent.com/google/fonts/main/ofl/$SUBDIR"
HAVE_FONT=1
for style in Regular Bold Italic; do
	f="$FONTS/$FAMILY-${style}.ttf"
	[ -f "$f" ] || curl -fsSL "$GFONTS/$FAMILY-${style}.ttf" -o "$f" 2>/dev/null || HAVE_FONT=0
done

PANDOC_ARGS=(
	"$DOC" -o "$OUT"
	--pdf-engine=xelatex
	--toc --toc-depth=2 --number-sections
	--highlight-style="$HLSTYLE"
	-H "$HEADER"
	-V colorlinks=true
)
if [ "$MANUAL" = user ]; then
	# Lighter, web-like: article (sections, no chapter pages); teal links via the
	# ldaccent colour defined in the header (pandoc loads hyperref after -H, so we
	# can't \hypersetup ourselves — pass the colour name through instead). Roomier
	# default margins.
	PANDOC_ARGS+=(
		-V documentclass=article
		-V linkcolor=ldaccent -V urlcolor=ldaccent -V toccolor=ldaccent
	)
	[ -n "$COVER" ] && PANDOC_ARGS+=(--include-before-body "$COVER")
	[ "$SIZE" = compact ] || PANDOC_ARGS+=(-V geometry:margin=2.4cm)
else
	PANDOC_ARGS+=(
		--top-level-division=chapter
		-V documentclass=report
		-V linkcolor=NavyBlue -V urlcolor=NavyBlue -V toccolor=NavyBlue
	)
	[ "$SIZE" = compact ] || PANDOC_ARGS+=(-V geometry:margin=2cm)
fi
if [ "$SIZE" = compact ]; then
	# Near-square page sized for a foldable's inner screen (e.g. OnePlus Open).
	PANDOC_ARGS+=(
		-V geometry:paperwidth=130mm -V geometry:paperheight=150mm
		-V geometry:margin=6mm -V fontsize=9pt
	)
fi
if [ "$HAVE_FONT" = 1 ]; then
	PANDOC_ARGS+=(
		-V mainfont="$FAMILY"
		-V "mainfontoptions=Path=$PWD/$FONTS/, Extension=.ttf, UprightFont=*-Regular, BoldFont=*-Bold, ItalicFont=*-Italic"
	)
fi

# --- Render: local pandoc+xelatex if available, else Dockerized pandoc --------
if command -v pandoc >/dev/null 2>&1 && command -v xelatex >/dev/null 2>&1; then
	echo "→ Rendering $OUT (local pandoc + xelatex)…"
	pandoc "${PANDOC_ARGS[@]}"
elif docker info >/dev/null 2>&1; then
	echo "→ Rendering $OUT (pandoc via Docker)…"
	# Re-path the font option for the container mount, then install fvextra and run.
	DOCKER_ARGS=()
	for a in "${PANDOC_ARGS[@]}"; do DOCKER_ARGS+=("${a/$PWD\//\/data\/}"); done
	docker run --rm --platform=linux/amd64 -v "$PWD":/data -w /data \
		--entrypoint sh pandoc/latex:latest -c \
		'tlmgr install fvextra titlesec >/dev/null 2>&1 || true; exec pandoc "$@"' \
		pandoc "${DOCKER_ARGS[@]}"
else
	echo "✗ Need either pandoc+xelatex on PATH, or a running Docker daemon." >&2
	exit 1
fi

echo "✓ Wrote $OUT ($(du -h "$OUT" | cut -f1))"
